'use strict';

/**
 * Workflow Controller — Phase W1 Workflow Canvas
 *
 * Endpoints (all mounted under /api/workflows, all behind `authenticate`):
 *
 *   GET    /                       — list workflows in a workspace
 *   POST   /                       — create a workflow (default isActive=false)
 *   GET    /:id                    — workflow + nodes + edges in one payload
 *   PATCH  /:id                    — name / description / isActive / boardId
 *   DELETE /:id                    — cascades to nodes + edges + runs
 *   POST   /:id/nodes              — add a node
 *   PATCH  /:id/nodes/:nodeId      — update kind / config / position
 *   DELETE /:id/nodes/:nodeId
 *   POST   /:id/edges              — add an edge { sourceNodeId, targetNodeId }
 *   DELETE /:id/edges/:edgeId
 *   GET    /:id/runs               — list recent runs (limit 50)
 *
 * RBAC:
 *   - Read: anyone who can see the workspace (canCallerSeeWorkspace,
 *     reimplemented privately a-la docCommentController).
 *   - Mutations (create / patch / delete / nodes / edges): same workspace
 *     access, with an extra gate on PUBLISH (isActive=true) and any
 *     destructive op — only super-admin, admin, manager, or the workflow's
 *     creator can publish or destructively edit.
 *
 * The legacy `Automation` controller is untouched. Both engines coexist.
 */

const {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  WorkflowRun,
  Workspace,
  User,
} = require('../models');
const safeLogger = require('../utils/safeLogger');
const { sanitizeInput } = require('../utils/sanitize');
const socketService = require('../services/socketService');

// May-19 audit P1-11 — collaborative invalidation. Emits go to two rooms:
//   - workflow:<id>     — canvas-level editors (node/edge events, publish)
//   - workspace:<id>    — workflow list page (create / delete / rename)
// Both are no-ops when socketService.ioInstance isn't initialised (tests).
// Wrapped in try/catch so a busted socket layer never breaks the CRUD path.
//
// May-26 fix — every mutation that emits a socket event now threads the
// originating request's `req.body._clientMutationId` (a UUID stamped by the
// canvas client per mutation) into the payload. The same tab subscribed to
// the room uses it to suppress echoes of its own saves, instead of showing
// "another editor saved changes" every time the user drags a node.
function readClientMutationId(req) {
  // Accept it in either body or header for flexibility. Bound to 64 chars
  // so a malicious client can't bloat the payload.
  const fromBody = req?.body?._clientMutationId;
  const fromHeader = req?.get?.('X-Client-Mutation-Id');
  const raw = (typeof fromBody === 'string' && fromBody) || (typeof fromHeader === 'string' && fromHeader) || null;
  return raw ? String(raw).slice(0, 64) : null;
}

function emitWorkflowEvent(wf, event, extra = {}, req = null) {
  if (!wf) return;
  try {
    const clientMutationId = req ? readClientMutationId(req) : null;
    const payload = {
      workflowId: wf.id,
      workspaceId: wf.workspaceId,
      clientMutationId,
      ...extra,
      ts: Date.now(),
    };
    if (wf.id) socketService.emitToRoom(`workflow:${wf.id}`, event, payload);
    if (wf.workspaceId) socketService.emitToRoom(`workspace:${wf.workspaceId}`, event, payload);
  } catch (err) {
    safeLogger.warn('[Workflow] emit socket event failed (non-fatal)', { err: err.message, event });
  }
}

// ─── trigger / action catalog ─────────────────────────────────────────

const ALLOWED_NODE_TYPES = new Set(['trigger', 'action', 'condition']);
const ALLOWED_TRIGGER_KINDS = new Set([
  'task_created',
  'task_updated',
  'status_changed',
  'task_assigned',
  'form_submitted',
]);
const ALLOWED_ACTION_KINDS = new Set([
  'notify_user',
  'change_status',
  'change_priority',
  'assign_to',
  'send_message',
  'wait',
  // Phase 7a — safe new actions (May-19 audit). Permissions are re-checked
  // at runtime in workflowEngine.executeWorkflow via the
  // ACTION_PERMISSION_REQUIREMENTS map (labels.add_to_task /
  // labels.remove_from_task / comments.create).
  'add_label',
  'remove_label',
  'add_comment',
]);
const ALLOWED_CONDITION_KINDS = new Set([
  'condition_field',
]);

// ─── helpers ───────────────────────────────────────────────────────────

/**
 * Mirror of `canCallerSeeWorkspace` in docCommentController. Reimplemented
 * privately on purpose — a future change to the doc helper must not
 * silently widen / narrow workflow visibility.
 */
async function canCallerSeeWorkspace(user, workspaceId) {
  if (!workspaceId) return false;
  if (user?.isSuperAdmin) return true;
  const ws = await Workspace.findByPk(workspaceId, {
    include: [
      { model: User, as: 'workspaceMembers', attributes: ['id'], required: false },
    ],
  });
  if (!ws) return false;
  if (user?.role === 'admin' || user?.role === 'manager') return true;
  if (ws.createdBy === user.id) return true;
  const memberIds = (ws.workspaceMembers || []).map((m) => m.id);
  return memberIds.includes(user.id);
}

/**
 * Publish + destructive-edit gate. Workflows are shared infra inside a
 * workspace, so we don't want a random member flipping someone else's
 * draft to live. Mirror of canManageBoard from automationController.
 */
function canManageWorkflow(user, workflow) {
  if (!user || !workflow) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin' || user.role === 'manager') return true;
  if (workflow.createdBy === user.id) return true;
  return false;
}

function serializeWorkflow(wf) {
  if (!wf) return null;
  return wf.toJSON ? wf.toJSON() : wf;
}

// ─── workflow CRUD ────────────────────────────────────────────────────

async function listWorkflows(req, res) {
  try {
    const workspaceId = req.query?.workspaceId;

    // Single-workspace path — keeps the original behaviour for callers that
    // pass an explicit workspaceId.
    if (workspaceId) {
      const allowed = await canCallerSeeWorkspace(req.user, workspaceId);
      if (!allowed) {
        return res.status(403).json({ success: false, message: 'You do not have access to this workspace.' });
      }
      const workflows = await Workflow.findAll({
        where: { workspaceId },
        order: [['createdAt', 'DESC']],
      });
      return res.json({ success: true, data: { workflows: workflows.map(serializeWorkflow) } });
    }

    // No workspaceId → list every workflow the caller can see. The sidebar
    // "Workflows" link routes here. Super-admin / admin / manager see all;
    // everyone else sees workflows in workspaces they created or are a
    // member of (mirrors canCallerSeeWorkspace).
    if (req.user?.isSuperAdmin || req.user?.role === 'admin' || req.user?.role === 'manager') {
      const workflows = await Workflow.findAll({ order: [['createdAt', 'DESC']] });
      return res.json({ success: true, data: { workflows: workflows.map(serializeWorkflow) } });
    }

    const visibleWorkspaces = await Workspace.findAll({
      attributes: ['id', 'createdBy'],
      include: [
        { model: User, as: 'workspaceMembers', attributes: ['id'], required: false },
      ],
    });
    const visibleIds = visibleWorkspaces
      .filter((ws) => ws.createdBy === req.user.id
        || (ws.workspaceMembers || []).some((m) => m.id === req.user.id))
      .map((ws) => ws.id);

    if (visibleIds.length === 0) {
      return res.json({ success: true, data: { workflows: [] } });
    }

    const workflows = await Workflow.findAll({
      where: { workspaceId: visibleIds },
      order: [['createdAt', 'DESC']],
    });
    return res.json({ success: true, data: { workflows: workflows.map(serializeWorkflow) } });
  } catch (err) {
    safeLogger.error('[Workflow] listWorkflows error', { err });
    res.status(500).json({ success: false, message: 'Failed to list workflows.' });
  }
}

async function createWorkflow(req, res) {
  try {
    const { name, description, workspaceId, boardId } = req.body || {};
    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'workspaceId is required.' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name is required.' });
    }
    const allowed = await canCallerSeeWorkspace(req.user, workspaceId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to this workspace.' });
    }

    const wf = await Workflow.create({
      name: sanitizeInput(name.trim()).slice(0, 200),
      description: description ? sanitizeInput(String(description)).slice(0, 4000) : null,
      workspaceId,
      boardId: boardId || null,
      createdBy: req.user.id,
      isActive: false, // canvas always starts as a draft
    });
    emitWorkflowEvent(wf, 'workflow:created', { actorId: req.user.id }, req);
    res.status(201).json({ success: true, data: { workflow: serializeWorkflow(wf) } });
  } catch (err) {
    safeLogger.error('[Workflow] createWorkflow error', { err });
    res.status(500).json({ success: false, message: 'Failed to create workflow.' });
  }
}

async function getWorkflow(req, res) {
  try {
    const wf = await Workflow.findByPk(req.params.id, {
      include: [
        { model: WorkflowNode, as: 'nodes', required: false },
        { model: WorkflowEdge, as: 'edges', required: false },
      ],
    });
    if (!wf) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, wf.workspaceId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    res.json({ success: true, data: { workflow: serializeWorkflow(wf) } });
  } catch (err) {
    safeLogger.error('[Workflow] getWorkflow error', { err });
    res.status(500).json({ success: false, message: 'Failed to load workflow.' });
  }
}

async function updateWorkflow(req, res) {
  try {
    const wf = await Workflow.findByPk(req.params.id);
    if (!wf) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, wf.workspaceId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const body = req.body || {};
    const updates = {};
    if (typeof body.name === 'string' && body.name.trim()) {
      updates.name = sanitizeInput(body.name.trim()).slice(0, 200);
    }
    if (body.description !== undefined) {
      updates.description = body.description
        ? sanitizeInput(String(body.description)).slice(0, 4000)
        : null;
    }
    if (body.boardId !== undefined) {
      updates.boardId = body.boardId || null;
    }
    if (body.isActive !== undefined) {
      // Publish gate — only super-admin / admin / manager / creator can flip.
      if (!canManageWorkflow(req.user, wf)) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to publish this workflow.',
        });
      }
      updates.isActive = !!body.isActive;

      // May-19 audit P0-4 — server-side graph validation on publish.
      // Only runs on the false → true transition; demoting to draft is
      // always allowed (no shape requirements on a draft).
      if (updates.isActive === true && wf.isActive !== true) {
        const { validateWorkflowGraph } = require('../services/workflowValidationService');
        const [nodes, edges] = await Promise.all([
          WorkflowNode.findAll({ where: { workflowId: wf.id } }),
          WorkflowEdge.findAll({ where: { workflowId: wf.id } }),
        ]);
        const validation = validateWorkflowGraph({ workflow: wf, nodes, edges });
        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            code: 'WORKFLOW_PUBLISH_INVALID',
            message: 'This workflow can\'t be published yet — fix the issues below.',
            errors: validation.errors,
          });
        }
      }
    }

    await wf.update(updates);
    // Publish flip and rename/scope changes go to two events so clients
    // can differentiate "remote saved a node" from "someone just hit
    // Publish" without re-fetching to compare isActive.
    if (updates.isActive !== undefined) {
      emitWorkflowEvent(wf, 'workflow:published', {
        actorId: req.user.id,
        isActive: !!updates.isActive,
      }, req);
    }
    emitWorkflowEvent(wf, 'workflow:updated', { actorId: req.user.id, fields: Object.keys(updates) }, req);
    res.json({ success: true, data: { workflow: serializeWorkflow(wf) } });
  } catch (err) {
    safeLogger.error('[Workflow] updateWorkflow error', { err });
    res.status(500).json({ success: false, message: 'Failed to update workflow.' });
  }
}

async function deleteWorkflow(req, res) {
  try {
    const wf = await Workflow.findByPk(req.params.id);
    if (!wf) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, wf.workspaceId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }
    if (!canManageWorkflow(req.user, wf)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete this workflow.',
      });
    }
    // Snapshot IDs BEFORE destroy so the socket payload still references
    // the deleted record meaningfully.
    const snapshot = { id: wf.id, workspaceId: wf.workspaceId };
    // FK cascade handles nodes / edges / runs.
    await wf.destroy();
    emitWorkflowEvent(snapshot, 'workflow:deleted', { actorId: req.user.id }, req);
    res.json({ success: true, message: 'Workflow deleted.' });
  } catch (err) {
    safeLogger.error('[Workflow] deleteWorkflow error', { err });
    res.status(500).json({ success: false, message: 'Failed to delete workflow.' });
  }
}

// ─── node CRUD ────────────────────────────────────────────────────────

async function createNode(req, res) {
  try {
    const wf = await Workflow.findByPk(req.params.id);
    if (!wf) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, wf.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!canManageWorkflow(req.user, wf)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit this workflow.' });
    }

    const { type, kind, config, position } = req.body || {};
    if (!type || !ALLOWED_NODE_TYPES.has(type)) {
      return res.status(400).json({ success: false, message: 'type must be trigger | action | condition.' });
    }
    if (!kind || typeof kind !== 'string') {
      return res.status(400).json({ success: false, message: 'kind is required.' });
    }
    if (type === 'trigger' && !ALLOWED_TRIGGER_KINDS.has(kind)) {
      return res.status(400).json({ success: false, message: `Unknown trigger kind: ${kind}` });
    }
    if (type === 'action' && !ALLOWED_ACTION_KINDS.has(kind)) {
      return res.status(400).json({ success: false, message: `Unknown action kind: ${kind}` });
    }
    if (type === 'condition' && !ALLOWED_CONDITION_KINDS.has(kind)) {
      return res.status(400).json({ success: false, message: `Unknown condition kind: ${kind}` });
    }

    const node = await WorkflowNode.create({
      workflowId: wf.id,
      type,
      kind: sanitizeInput(kind).slice(0, 64),
      config: config && typeof config === 'object' ? config : {},
      position: position && typeof position === 'object' ? position : { x: 0, y: 0 },
    });
    emitWorkflowEvent(wf, 'workflow:node-created', {
      actorId: req.user.id,
      nodeId: node.id,
      type: node.type,
      kind: node.kind,
    }, req);
    res.status(201).json({ success: true, data: { node: node.toJSON ? node.toJSON() : node } });
  } catch (err) {
    safeLogger.error('[Workflow] createNode error', { err });
    res.status(500).json({ success: false, message: 'Failed to create node.' });
  }
}

async function updateNode(req, res) {
  try {
    const wf = await Workflow.findByPk(req.params.id);
    if (!wf) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, wf.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!canManageWorkflow(req.user, wf)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit this workflow.' });
    }

    const node = await WorkflowNode.findByPk(req.params.nodeId);
    if (!node || node.workflowId !== wf.id) {
      return res.status(404).json({ success: false, message: 'Node not found.' });
    }

    const body = req.body || {};
    const updates = {};
    if (typeof body.kind === 'string' && body.kind) {
      updates.kind = sanitizeInput(body.kind).slice(0, 64);
    }
    if (body.config !== undefined && typeof body.config === 'object' && body.config !== null) {
      updates.config = body.config;
    }
    if (body.position !== undefined && typeof body.position === 'object' && body.position !== null) {
      updates.position = body.position;
    }
    await node.update(updates);
    emitWorkflowEvent(wf, 'workflow:node-updated', {
      actorId: req.user.id,
      nodeId: node.id,
      fields: Object.keys(updates),
    }, req);
    res.json({ success: true, data: { node: node.toJSON ? node.toJSON() : node } });
  } catch (err) {
    safeLogger.error('[Workflow] updateNode error', { err });
    res.status(500).json({ success: false, message: 'Failed to update node.' });
  }
}

async function deleteNode(req, res) {
  try {
    const wf = await Workflow.findByPk(req.params.id);
    if (!wf) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, wf.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!canManageWorkflow(req.user, wf)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit this workflow.' });
    }

    const node = await WorkflowNode.findByPk(req.params.nodeId);
    if (!node || node.workflowId !== wf.id) {
      return res.status(404).json({ success: false, message: 'Node not found.' });
    }
    const deletedNodeId = node.id;
    await node.destroy(); // FK cascade wipes incoming/outgoing edges
    emitWorkflowEvent(wf, 'workflow:node-deleted', {
      actorId: req.user.id,
      nodeId: deletedNodeId,
    }, req);
    res.json({ success: true, message: 'Node deleted.' });
  } catch (err) {
    safeLogger.error('[Workflow] deleteNode error', { err });
    res.status(500).json({ success: false, message: 'Failed to delete node.' });
  }
}

// ─── edge CRUD ────────────────────────────────────────────────────────

async function createEdge(req, res) {
  try {
    const wf = await Workflow.findByPk(req.params.id);
    if (!wf) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, wf.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!canManageWorkflow(req.user, wf)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit this workflow.' });
    }

    const { sourceNodeId, targetNodeId, condition, branch } = req.body || {};
    if (!sourceNodeId || !targetNodeId) {
      return res.status(400).json({ success: false, message: 'sourceNodeId and targetNodeId are required.' });
    }
    if (sourceNodeId === targetNodeId) {
      return res.status(400).json({ success: false, message: 'An edge cannot connect a node to itself.' });
    }
    // Branch — accept null/undefined OR the literal strings 'true'/'false'.
    // Anything else is a client bug and we 400 rather than silently coercing.
    let normalizedBranch = null;
    if (branch !== undefined && branch !== null && branch !== '') {
      if (branch !== 'true' && branch !== 'false') {
        return res.status(400).json({ success: false, message: "branch must be 'true', 'false', or omitted." });
      }
      normalizedBranch = branch;
    }

    // Both nodes must exist and belong to this workflow.
    const [src, tgt] = await Promise.all([
      WorkflowNode.findByPk(sourceNodeId),
      WorkflowNode.findByPk(targetNodeId),
    ]);
    if (!src || src.workflowId !== wf.id || !tgt || tgt.workflowId !== wf.id) {
      return res.status(400).json({
        success: false,
        message: 'Both nodes must exist on this workflow.',
      });
    }

    const edge = await WorkflowEdge.create({
      workflowId: wf.id,
      sourceNodeId,
      targetNodeId,
      condition: condition === undefined ? null : condition,
      branch: normalizedBranch,
    });
    emitWorkflowEvent(wf, 'workflow:edge-created', {
      actorId: req.user.id,
      edgeId: edge.id,
      sourceNodeId,
      targetNodeId,
      branch: normalizedBranch,
    }, req);
    res.status(201).json({ success: true, data: { edge: edge.toJSON ? edge.toJSON() : edge } });
  } catch (err) {
    safeLogger.error('[Workflow] createEdge error', { err });
    res.status(500).json({ success: false, message: 'Failed to create edge.' });
  }
}

async function deleteEdge(req, res) {
  try {
    const wf = await Workflow.findByPk(req.params.id);
    if (!wf) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, wf.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!canManageWorkflow(req.user, wf)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit this workflow.' });
    }

    const edge = await WorkflowEdge.findByPk(req.params.edgeId);
    if (!edge || edge.workflowId !== wf.id) {
      return res.status(404).json({ success: false, message: 'Edge not found.' });
    }
    const deletedEdgeId = edge.id;
    await edge.destroy();
    emitWorkflowEvent(wf, 'workflow:edge-deleted', {
      actorId: req.user.id,
      edgeId: deletedEdgeId,
    }, req);
    res.json({ success: true, message: 'Edge deleted.' });
  } catch (err) {
    safeLogger.error('[Workflow] deleteEdge error', { err });
    res.status(500).json({ success: false, message: 'Failed to delete edge.' });
  }
}

// ─── runs ─────────────────────────────────────────────────────────────

// POST /api/workflows/:id/test-run
// Run the workflow once with a SYNTHETIC trigger context so the author can
// validate their canvas without waiting for a real task event to fire.
// Body (optional): { task: {...partial overrides...} }. We fall back to a
// canned synthetic task — id 'test-run', a fake title, status 'working_on_it'.
// The run is fire-and-forget on the server side BUT we wait for it to finish
// before responding (test runs are short — they hit `wait` capped at 5 min).
async function testRunWorkflow(req, res) {
  try {
    const wf = await Workflow.findByPk(req.params.id, {
      include: [
        { model: WorkflowNode, as: 'nodes', required: false },
      ],
    });
    if (!wf) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, wf.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });
    if (!canManageWorkflow(req.user, wf)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to test-run this workflow.' });
    }

    // Find the trigger node — every workflow needs exactly one entry point.
    const triggerNode = (wf.nodes || []).find((n) => n.type === 'trigger');
    if (!triggerNode) {
      return res.status(400).json({
        success: false,
        message: 'This workflow has no trigger node yet. Add one before test-running.',
      });
    }

    // Synthetic task — caller can override any subset via body.task.
    const overrides = (req.body?.task && typeof req.body.task === 'object') ? req.body.task : {};
    const syntheticTask = {
      id: overrides.id || 'test-run',
      title: overrides.title || `Test run for "${wf.name}"`,
      status: overrides.status || 'working_on_it',
      priority: overrides.priority || 'medium',
      dueDate: overrides.dueDate || null,
      boardId: overrides.boardId || wf.boardId || null,
      assignedTo: overrides.assignedTo || req.user.id,
    };
    const context = { task: syntheticTask, userId: req.user.id, isTestRun: true };

    // Defer the engine require to avoid a circular import at module load.
    const { executeWorkflow } = require('../services/workflowEngine');
    const result = await executeWorkflow(wf, triggerNode, context);

    return res.json({
      success: true,
      data: {
        result,
        trigger: { type: triggerNode.type, kind: triggerNode.kind },
        synthetic: syntheticTask,
      },
    });
  } catch (err) {
    safeLogger.error('[Workflow] testRunWorkflow error', { err });
    res.status(500).json({ success: false, message: 'Test run failed.' });
  }
}

async function listRuns(req, res) {
  try {
    const wf = await Workflow.findByPk(req.params.id);
    if (!wf) return res.status(404).json({ success: false, message: 'Workflow not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, wf.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });

    const runs = await WorkflowRun.findAll({
      where: { workflowId: wf.id },
      order: [['startedAt', 'DESC']],
      limit: 50,
    });
    res.json({ success: true, data: { runs: runs.map((r) => (r.toJSON ? r.toJSON() : r)) } });
  } catch (err) {
    safeLogger.error('[Workflow] listRuns error', { err });
    res.status(500).json({ success: false, message: 'Failed to load runs.' });
  }
}

module.exports = {
  // workflows
  listWorkflows,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  // nodes
  createNode,
  updateNode,
  deleteNode,
  // edges
  createEdge,
  deleteEdge,
  // runs
  testRunWorkflow,
  // runs
  listRuns,
  // exported for tests
  _internal: { canCallerSeeWorkspace, canManageWorkflow },
};
