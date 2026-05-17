'use strict';

/**
 * Workflow Canvas Engine — Phase W1
 *
 * Mirrors the call-site contract of `services/automationService.js`:
 *
 *   await processWorkflows(trigger, context)
 *
 * Both engines coexist — every `processAutomations(trigger, ctx)` site in
 * taskController.js now has a sibling `processWorkflows(trigger, ctx)`
 * call. The legacy `Automation` table keeps running unchanged; this engine
 * is the new visual-canvas path.
 *
 * Public surface (exactly):
 *   - processWorkflows(trigger, context)   — fire-and-forget entry point
 *   - executeWorkflow(workflow, startNode, context) — internal walker, exported for tests
 *   - matchesTriggerNode(node, trigger, context)    — config matcher, exported for tests
 *
 * Trigger catalog (v1):
 *   - task_created    ctx: { task, userId }
 *   - task_updated    ctx: { task, previousValues, newValues, userId }
 *   - status_changed  ctx: { task, previousStatus, newStatus, userId }
 *   - task_assigned   ctx: { task, userId }
 *
 * Action catalog (v1):
 *   - notify_user     config { userId | 'assignee', message }
 *   - change_status   config { to }
 *   - change_priority config { to }
 *   - assign_to       config { userId }
 *   - send_message    config { text }                — posts an Adaptive Card
 *                                                       to the Teams webhook
 *                                                       (TEAMS_WEBHOOK_URL).
 *                                                       `text` supports
 *                                                       {{task.title}},
 *                                                       {{task.status}},
 *                                                       {{task.priority}},
 *                                                       {{task.dueDate}},
 *                                                       {{task.id}},
 *                                                       {{workflow.name}}.
 *   - wait            config { minutes }            — no-op stub in v1
 *
 * Errors NEVER throw to the caller. The whole thing is wrapped so a busted
 * workflow can't ripple back into the task mutation that triggered it.
 */

const safeLogger = require('../utils/safeLogger');

// Lazy-loaded so consumers (and tests) that don't have the model registry
// wired don't pay the cost on require. Mirrors the docCommentController
// pattern around notificationService.
let _models;
function getModels() {
  if (!_models) _models = require('../models');
  return _models;
}

let _notificationService;
function getNotificationService() {
  if (!_notificationService) _notificationService = require('../services/notificationService');
  return _notificationService;
}

let _teamsWebhook;
function getTeamsWebhook() {
  if (!_teamsWebhook) _teamsWebhook = require('./teamsWebhook');
  return _teamsWebhook;
}

// Phase W2 — wait cap. setTimeout-based waits hold a Node.js coroutine in
// memory; longer waits would survive a deploy only with a DB-backed scheduler
// (Phase W3). Until then, anything beyond 5 minutes is silently clamped down
// and a warning is logged so the author isn't surprised by silent truncation.
const WAIT_MAX_MS = 5 * 60 * 1000;

// Phase W2 — condition node evaluation. Reads node.config:
//   { field: 'task.status' | 'task.priority' | 'task.assignedTo' | 'task.dueDate',
//     operator: 'equals' | 'not_equals' | 'contains' | 'is_set' | 'is_empty',
//     value: any }
// Returns a boolean — true/false drives which outgoing edges the walker
// follows next (`edge.branch === 'true' | 'false'`).
function evaluateCondition(node, context) {
  const cfg = node.config || {};
  const field = String(cfg.field || '');
  const operator = String(cfg.operator || 'equals');
  const expected = cfg.value;

  const value = readFieldFromContext(field, context);

  switch (operator) {
    case 'equals':     return String(value ?? '') === String(expected ?? '');
    case 'not_equals': return String(value ?? '') !== String(expected ?? '');
    case 'contains':
      return typeof value === 'string'
        && typeof expected === 'string'
        && expected.length > 0
        && value.toLowerCase().includes(expected.toLowerCase());
    case 'is_set':     return value !== null && value !== undefined && value !== '';
    case 'is_empty':   return value === null || value === undefined || value === '';
    default:
      safeLogger.warn('[Workflow] unknown condition operator — defaulting to false', {
        nodeId: node.id,
        operator,
      });
      return false;
  }
}

function readFieldFromContext(field, context) {
  if (!field) return null;
  const parts = field.split('.');
  let cursor = context;
  for (const part of parts) {
    if (cursor == null) return null;
    cursor = cursor[part];
  }
  return cursor;
}

// Token substitution for `send_message` action text. Resolves the small set
// of fields a workflow author can reasonably reach from action config without
// us shipping a templating language. Unknown placeholders render literally.
function renderMessageTemplate(text, { task, workflow }) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/\{\{\s*task\.title\s*\}\}/gi,    task?.title    ?? '')
    .replace(/\{\{\s*task\.status\s*\}\}/gi,   task?.status   ?? '')
    .replace(/\{\{\s*task\.priority\s*\}\}/gi, task?.priority ?? '')
    .replace(/\{\{\s*task\.dueDate\s*\}\}/gi,  task?.dueDate  ?? '')
    .replace(/\{\{\s*task\.id\s*\}\}/gi,       task?.id       ?? '')
    .replace(/\{\{\s*workflow\.name\s*\}\}/gi, workflow?.name ?? '');
}

// ─── trigger matching ──────────────────────────────────────────────────

/**
 * Returns true if this trigger node should fire given the trigger event +
 * context. The node's `config` may carry additional filters — e.g. a
 * status_changed trigger with `config.status === 'done'` should only fire
 * when newStatus is 'done'. With no config, every event of the right
 * `kind` matches.
 *
 * Exported for tests.
 */
function matchesTriggerNode(node, trigger, context) {
  if (!node || node.type !== 'trigger') return false;
  if (node.kind !== trigger) return false;
  const cfg = node.config || {};
  switch (trigger) {
    case 'status_changed':
      // Match only if config.status is unset OR matches newStatus.
      if (cfg.status && context.newStatus !== cfg.status) return false;
      return true;
    case 'task_assigned':
      // Optional config.userId filter — only fire if the task was assigned
      // to this specific user.
      if (cfg.userId && context.task?.assignedTo !== cfg.userId) return false;
      return true;
    case 'task_created':
    case 'task_updated':
      // No config filters defined for v1.
      return true;
    case 'form_submitted':
      // Optional config.formId — fire only on this specific form's submits.
      // Unset = any form in the workspace matches.
      if (cfg.formId && context.form?.id !== cfg.formId) return false;
      return true;
    default:
      return true;
  }
}

// ─── entry point ───────────────────────────────────────────────────────

/**
 * Fan-out entry point. Loads every active workflow that could fire for
 * this trigger, then executes each one. Mirrors `processAutomations` in
 * call-site shape — taskController fires both side-by-side.
 *
 * Errors are SWALLOWED so a buggy workflow can never destabilize the
 * task mutation that triggered it.
 */
async function processWorkflows(trigger, context) {
  try {
    const { Workflow, WorkflowNode } = getModels();
    const { Op } = require('sequelize');

    // Resolve boardId from either a task-typed context (legacy task triggers)
    // or an explicit context.boardId (new form_submitted trigger and any
    // future non-task triggers). Same matcher in both cases.
    const boardId = context?.task?.boardId || context?.boardId || null;
    const workspaceId = context?.workspaceId || null;

    // Load all active workflows that are either workspace-wide (no board)
    // or scoped to the triggering task's board. We always include the
    // nodes eagerly so we can match trigger nodes in-memory rather than
    // doing one query per workflow. When a workspaceId is supplied (e.g.
    // form_submitted), we narrow to that workspace as well — otherwise a
    // form in workspace A could fire a workflow in workspace B that
    // happens to be workspace-wide.
    const where = {
      isActive: true,
      [Op.or]: [
        { boardId: null },
        ...(boardId ? [{ boardId }] : []),
      ],
      ...(workspaceId ? { workspaceId } : {}),
    };

    const workflows = await Workflow.findAll({
      where,
      include: [{ model: WorkflowNode, as: 'nodes', required: false }],
    });

    if (!workflows.length) return;

    for (const wf of workflows) {
      try {
        const nodes = wf.nodes || [];
        const triggerNodes = nodes.filter((n) => n.type === 'trigger');
        for (const tn of triggerNodes) {
          if (!matchesTriggerNode(tn, trigger, context)) continue;
          // Fire the chain starting from this trigger node.
          await executeWorkflow(wf, tn, context);
        }
      } catch (err) {
        safeLogger.error('[Workflow] processWorkflows: workflow failed', {
          err,
          workflowId: wf.id,
          trigger,
        });
      }
    }
  } catch (err) {
    safeLogger.error('[Workflow] processWorkflows fatal', { err, trigger });
  }
}

// ─── graph walker ──────────────────────────────────────────────────────

/**
 * Walk the DAG starting from `startNode`. Linear-chain support is
 * required for v1; branching / condition nodes are scaffolded and
 * skipped with a log.
 *
 * Writes a WorkflowRun row at the end and updates the workflow's
 * `lastRunAt` + `lastRunStatus`.
 *
 * Exported for tests.
 */
async function executeWorkflow(workflow, startNode, context, options = {}) {
  const { WorkflowEdge, WorkflowNode, WorkflowRun, Workflow } = getModels();
  const t0 = Date.now();
  let nodesRun = 0;
  let anyError = false;
  let anySkipped = false;
  let lastError = null;

  try {
    // Load every edge + node for this workflow up-front so the walker
    // doesn't issue N queries.
    const [edges, allNodes] = await Promise.all([
      WorkflowEdge.findAll({ where: { workflowId: workflow.id } }),
      WorkflowNode.findAll({ where: { workflowId: workflow.id } }),
    ]);

    const nodesById = new Map();
    for (const n of allNodes) nodesById.set(n.id, n);

    const edgesBySource = new Map();
    for (const e of edges) {
      const arr = edgesBySource.get(e.sourceNodeId) || [];
      arr.push(e);
      edgesBySource.set(e.sourceNodeId, arr);
    }

    // BFS from the trigger node. Visited set guards against cycles a
    // future canvas bug might allow.
    //
    // Phase W2 branching: when a node is a CONDITION node, we evaluate it
    // once, then only enqueue its outgoing edges whose `branch` matches the
    // result. Edges with `branch === null` from a condition node are still
    // followed (treated as fallthrough so legacy graphs don't break).
    const visited = new Set([startNode.id]);
    const queue = [startNode.id];
    const conditionResults = new Map(); // nodeId → true/false

    while (queue.length) {
      const currentId = queue.shift();
      const currentNode = nodesById.get(currentId);
      const outgoing = edgesBySource.get(currentId) || [];
      const currentBranchResult = conditionResults.get(currentId); // undefined unless current is a condition

      for (const edge of outgoing) {
        // Legacy edge-level condition JSONB (pre-W2). When present, log + skip.
        // Real branching now lives on condition NODES + edge.branch.
        if (edge.condition !== null && edge.condition !== undefined) {
          safeLogger.info('[Workflow] legacy edge.condition skipped (use a condition node)', {
            workflowId: workflow.id,
            edgeId: edge.id,
          });
          anySkipped = true;
          continue;
        }

        // Branch filter — only applies when the SOURCE was a condition node.
        if (currentNode?.type === 'condition' && currentBranchResult !== undefined && edge.branch) {
          const want = currentBranchResult ? 'true' : 'false';
          if (edge.branch !== want) continue;
        }

        const target = nodesById.get(edge.targetNodeId);
        if (!target || visited.has(target.id)) continue;
        visited.add(target.id);

        // Condition nodes evaluate, store the result, then enqueue children
        // (the filter above prunes which children actually run).
        if (target.type === 'condition') {
          let result = false;
          try {
            result = !!evaluateCondition(target, context);
          } catch (err) {
            anyError = true;
            lastError = err;
            safeLogger.warn('[Workflow] condition evaluation threw — treating as false', {
              err,
              workflowId: workflow.id,
              nodeId: target.id,
            });
          }
          conditionResults.set(target.id, result);
          queue.push(target.id);
          continue;
        }

        if (target.type === 'action') {
          let actionResult;
          try {
            actionResult = await executeActionNode(target, context, workflow);
            nodesRun += 1;
          } catch (err) {
            anyError = true;
            lastError = err;
            safeLogger.error('[Workflow] action node failed', {
              err,
              workflowId: workflow.id,
              nodeId: target.id,
              kind: target.kind,
            });
            // Continue walking — failures don't halt the chain, they're
            // recorded in WorkflowRun.status.
          }
          // W3 — when an action signals `{ paused: true }` (long `wait`),
          // stop walking past it. The cron job will resume from this node
          // once the persisted WorkflowWait row matures.
          if (actionResult && actionResult.paused) {
            anySkipped = true;
            continue;
          }
        }
        queue.push(target.id);
      }
    }
  } catch (err) {
    anyError = true;
    lastError = err;
    safeLogger.error('[Workflow] executeWorkflow walker failed', {
      err,
      workflowId: workflow.id,
    });
  }

  const status = anyError ? 'error' : anySkipped ? 'partial' : 'ok';
  const durationMs = Date.now() - t0;

  // Persist the run record + bump lastRunAt on the workflow. Both are
  // wrapped — a failed write here must not propagate.
  try {
    await WorkflowRun.create({
      workflowId: workflow.id,
      // Resume runs carry a distinct `wait_resume` trigger so the audit log
      // can tell continuations apart from initial fires.
      trigger: options.isResume ? 'wait_resume' : startNode.kind,
      context: sanitizeContext(context),
      status,
      nodesRun,
      durationMs,
      error: lastError ? String(lastError.message || lastError).slice(0, 2000) : null,
      startedAt: new Date(t0),
    });
  } catch (err) {
    safeLogger.warn('[Workflow] WorkflowRun.create failed', { err, workflowId: workflow.id });
  }

  try {
    if (typeof workflow.update === 'function') {
      await workflow.update({ lastRunAt: new Date(), lastRunStatus: status });
    } else {
      // Plain-object fallback (some test mocks pass POJOs).
      await Workflow.update(
        { lastRunAt: new Date(), lastRunStatus: status },
        { where: { id: workflow.id } }
      );
    }
  } catch (err) {
    safeLogger.warn('[Workflow] workflow.update(lastRun*) failed', {
      err,
      workflowId: workflow.id,
    });
  }

  return { status, nodesRun, durationMs };
}

// ─── action dispatch ───────────────────────────────────────────────────

async function executeActionNode(node, context, workflow) {
  const cfg = node.config || {};
  const { task } = context;
  const { Task } = getModels();

  switch (node.kind) {
    case 'notify_user': {
      // 'assignee' is the sentinel that resolves to the task's current
      // assignedTo at fire time. Otherwise config.userId is a literal UUID.
      const targetId =
        cfg.userId === 'assignee' ? task?.assignedTo : cfg.userId;
      if (!targetId) {
        safeLogger.warn('[Workflow] notify_user: no recipient resolved', {
          workflowId: workflow.id,
          nodeId: node.id,
        });
        return;
      }
      const message =
        cfg.message ||
        `Workflow "${workflow.name}" triggered for "${task?.title || 'task'}"`;
      const ns = getNotificationService();
      await ns.createNotification({
        userId: targetId,
        type: 'task_updated',
        message,
        entityType: 'task',
        entityId: task?.id || null,
        boardId: task?.boardId || null,
        idempotencyKey: ns.buildIdempotencyKey(
          'workflow-notify',
          workflow.id,
          node.id,
          task?.id || '',
          targetId,
          Math.floor(Date.now() / 60000)
        ),
      });
      return;
    }
    case 'change_status': {
      if (!cfg.to || !task?.id) return;
      await Task.update({ status: cfg.to }, { where: { id: task.id } });
      return;
    }
    case 'change_priority': {
      if (!cfg.to || !task?.id) return;
      await Task.update({ priority: cfg.to }, { where: { id: task.id } });
      return;
    }
    case 'assign_to': {
      if (!cfg.userId || !task?.id) return;
      await Task.update({ assignedTo: cfg.userId }, { where: { id: task.id } });
      return;
    }
    case 'send_message': {
      // Real Teams Adaptive-Card dispatch. teamsWebhook.sendCard() silently
      // no-ops when TEAMS_WEBHOOK_URL is unset, so this is also safe in dev
      // and in CI where the env var is intentionally absent. We never throw
      // out of an action — a webhook failure must not break the workflow.
      const rendered = renderMessageTemplate(cfg.text || '', { task, workflow });
      if (!rendered.trim()) {
        safeLogger.warn('[Workflow] send_message: empty text after templating', {
          workflowId: workflow.id,
          nodeId: node.id,
        });
        return;
      }
      try {
        const teamsWebhook = getTeamsWebhook();
        const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
        const card = teamsWebhook.buildAdaptiveCard({
          title: workflow?.name || 'Workflow',
          subtitle: rendered,
          facts: [
            { title: 'Task',     value: task?.title    || '' },
            { title: 'Status',   value: task?.status   || '' },
            { title: 'Priority', value: task?.priority || '' },
          ],
          actionUrl: task?.id && task?.boardId
            ? `${clientUrl}/boards/${task.boardId}/tasks/${task.id}`
            : null,
          actionLabel: 'Open Task',
        });
        await teamsWebhook.sendCard(card);
      } catch (err) {
        safeLogger.warn('[Workflow] send_message Teams dispatch failed', {
          err,
          workflowId: workflow.id,
          nodeId: node.id,
        });
      }
      return;
    }
    case 'wait': {
      // Phase W3 — two-mode wait:
      //   minutes <= WAIT_MAX_MS:  in-memory setTimeout (cheap, no DB write)
      //   minutes >  WAIT_MAX_MS:  persist a WorkflowWait row and signal
      //                            { paused: true } so the walker stops
      //                            traversing past this node. A cron job
      //                            (workflowWaitJob) resumes from here once
      //                            resumeAt <= NOW().
      const requestedMinutes = Number(cfg.minutes) || 0;
      if (requestedMinutes <= 0) return;
      const requestedMs = requestedMinutes * 60 * 1000;
      if (requestedMs <= WAIT_MAX_MS) {
        await new Promise((resolve) => setTimeout(resolve, requestedMs));
        return;
      }
      // Long wait → persist and pause.
      try {
        const { WorkflowWait } = getModels();
        const resumeAt = new Date(Date.now() + requestedMs);
        await WorkflowWait.create({
          workflowId: workflow.id,
          fromNodeId: node.id,
          context: sanitizeContext(context),
          resumeAt,
        });
        safeLogger.info('[Workflow] wait persisted for cron resume', {
          workflowId: workflow.id,
          nodeId: node.id,
          minutes: requestedMinutes,
          resumeAt: resumeAt.toISOString(),
        });
        return { paused: true };
      } catch (err) {
        // If we can't persist the wait, fall back to in-memory cap so the
        // workflow at least makes some progress. Logged loud so ops sees it.
        safeLogger.error('[Workflow] WorkflowWait persist failed — falling back to capped in-memory wait', {
          err,
          workflowId: workflow.id,
          nodeId: node.id,
        });
        await new Promise((resolve) => setTimeout(resolve, WAIT_MAX_MS));
        return;
      }
    }
    default: {
      safeLogger.warn('[Workflow] unknown action kind', {
        workflowId: workflow.id,
        nodeId: node.id,
        kind: node.kind,
      });
      return;
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────

/**
 * Strip the trigger context down to IDs only before persisting on the
 * WorkflowRun row. We never want to archive a full task body inline —
 * descriptions / attachments / comments could contain sensitive content.
 */
function sanitizeContext(context = {}) {
  const safe = {};
  if (context.task?.id) safe.taskId = context.task.id;
  if (context.task?.boardId) safe.boardId = context.task.boardId;
  if (context.task?.assignedTo) safe.assignedTo = context.task.assignedTo;
  if (context.userId) safe.userId = context.userId;
  if (context.previousStatus) safe.previousStatus = context.previousStatus;
  if (context.newStatus) safe.newStatus = context.newStatus;
  return safe;
}

/**
 * Resume a paused workflow from the wait node it stopped at. Loads the
 * WorkflowWait row by id, hydrates the workflow + wait node, then walks
 * the DAG from the wait node's outgoing edges. The wait row is deleted on
 * any path that completes — success OR fatal load failure — so the cron
 * job doesn't keep retrying a permanently-broken row.
 *
 * Returns the run summary `{ status, nodesRun, durationMs }` when a walk
 * happened, or null when the wait was discarded for a structural reason.
 *
 * The cron job (workflowWaitJob) is the only intended caller.
 */
async function resumeFromWait(waitId) {
  const { WorkflowWait, Workflow, WorkflowNode } = getModels();
  let wait;
  try {
    wait = await WorkflowWait.findByPk(waitId);
    if (!wait) return null;
  } catch (err) {
    safeLogger.error('[Workflow] resumeFromWait: load wait failed', { err, waitId });
    return null;
  }

  let workflow;
  let waitNode;
  try {
    [workflow, waitNode] = await Promise.all([
      Workflow.findByPk(wait.workflowId),
      WorkflowNode.findByPk(wait.fromNodeId),
    ]);
  } catch (err) {
    safeLogger.error('[Workflow] resumeFromWait: load workflow/node failed', {
      err, waitId, workflowId: wait.workflowId, fromNodeId: wait.fromNodeId,
    });
    // Don't delete — give the cron another shot in case it's a transient DB error.
    return null;
  }

  // If the workflow or wait node was deleted while we were paused, drop the
  // wait row — there's nothing to resume into.
  if (!workflow || !waitNode) {
    try { await wait.destroy(); } catch { /* noop */ }
    return null;
  }
  if (!workflow.isActive) {
    // Workflow was unpublished — abandon the wait. Author can re-trigger
    // manually after re-publishing.
    safeLogger.info('[Workflow] resumeFromWait: workflow inactive — dropping wait', {
      waitId, workflowId: workflow.id,
    });
    try { await wait.destroy(); } catch { /* noop */ }
    return null;
  }

  // Bump the attempt counter BEFORE running so a thrown handler doesn't
  // leave the row in an "attemptCount=0 forever" loop. Best-effort.
  try { await wait.increment('attemptCount'); } catch { /* noop */ }

  const context = wait.context || {};
  let result = null;
  try {
    result = await executeWorkflow(workflow, waitNode, context, { isResume: true });
  } catch (err) {
    safeLogger.error('[Workflow] resumeFromWait: executeWorkflow threw', { err, waitId });
  }

  // Always delete the wait — even on engine error. The WorkflowRun row
  // captures what happened, and we don't want a poison message that
  // keeps retrying forever. Author can manually re-fire if needed.
  try { await wait.destroy(); } catch { /* noop */ }
  return result;
}

module.exports = {
  processWorkflows,
  executeWorkflow,
  matchesTriggerNode,
  resumeFromWait,
};
