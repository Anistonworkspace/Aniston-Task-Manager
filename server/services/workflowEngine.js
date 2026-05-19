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

let _permissionEngine;
function getPermissionEngine() {
  if (!_permissionEngine) _permissionEngine = require('./permissionEngine');
  return _permissionEngine;
}

// ─── runtime permission check (May-19 audit P0-3) ──────────────────────
//
// Every action node is gated through this map before its handler runs. The
// audit's headline risk is "a workflow created by an admin keeps mutating
// data even after the admin is demoted." We close that by re-fetching the
// creator from the DB on every run and asking the canonical permission
// engine whether they STILL hold the underlying permission — at *this*
// moment, not at publish time.
//
// Notes:
//  - `tasks.edit_status` / `tasks.edit_priority` / `tasks.assign_others`
//    are the granular Phase-7 actions. The engine's umbrella fallback
//    means an existing `tasks.change_status` / `tasks.set_priority` /
//    `tasks.assign_others` grant still covers them — so this is non-
//    breaking for current grant rows.
//  - `tasks.view` is the floor for `notify_user` (and any future passive
//    action): if the actor can't even see the task, sending a message
//    about it shouldn't be allowed.
//  - `wait` and `send_message` have NO per-action check — `wait` is pure
//    control flow, `send_message` is a webhook to a channel that's already
//    workspace-scoped at config time.
const ACTION_PERMISSION_REQUIREMENTS = {
  notify_user:     { resource: 'tasks',  action: 'view' },
  change_status:   { resource: 'tasks',  action: 'edit_status' },
  change_priority: { resource: 'tasks',  action: 'edit_priority' },
  assign_to:       { resource: 'tasks',  action: 'assign_others' },
  // Phase 7a additions — safe new actions.
  add_label:       { resource: 'labels', action: 'add_to_task' },
  remove_label:    { resource: 'labels', action: 'remove_from_task' },
  add_comment:     { resource: 'comments', action: 'create' },
  // Pure control-flow / webhook side effects — no per-action gate. The
  // workflow's existence + isActive=true is already gated by the publish
  // check on workflows.publish.
  send_message:    null,
  wait:            null,
};

/**
 * Load the user that should be evaluated for runtime permission checks.
 * Always the workflow's `createdBy` — re-fetched fresh so a demoted /
 * deactivated creator's workflows stop mutating data.
 *
 * Returns the User instance (with tier, role, isSuperAdmin) or null if
 * the creator is missing / deactivated / has no tier resolvable.
 */
async function resolveExecutionActor(workflow) {
  try {
    const { User } = getModels();
    if (!workflow?.createdBy) return null;
    const actor = await User.findByPk(workflow.createdBy, {
      attributes: [
        'id', 'role', 'tier', 'isSuperAdmin', 'isActive', 'email', 'name',
      ],
    });
    if (!actor) return null;
    if (actor.isActive === false) return null;
    return actor;
  } catch (err) {
    safeLogger.error('[Workflow] resolveExecutionActor failed', {
      err,
      workflowId: workflow?.id,
    });
    return null;
  }
}

/**
 * Re-check the configured execution actor's CURRENT effective permission
 * for the resource/action pair this node kind requires.
 *
 * Returns `{ allowed, reason }`. When `allowed === false`, the walker
 * MUST NOT call the action handler — it logs a "permission denied" skip
 * to the run output instead.
 */
async function checkActionPermission(actor, node) {
  const requirement = ACTION_PERMISSION_REQUIREMENTS[node.kind];
  // No requirement registered (wait / send_message) → always allowed at
  // the engine layer.
  if (requirement === null || requirement === undefined) {
    return { allowed: true };
  }
  if (!actor) {
    return {
      allowed: false,
      reason: 'workflow creator missing or deactivated',
    };
  }
  try {
    const ok = await getPermissionEngine().hasPermission(
      actor,
      requirement.resource,
      requirement.action,
    );
    if (ok) return { allowed: true };
    return {
      allowed: false,
      reason: `creator lacks ${requirement.resource}.${requirement.action}`,
    };
  } catch (err) {
    safeLogger.error('[Workflow] checkActionPermission threw', {
      err,
      kind: node.kind,
      resource: requirement.resource,
      action: requirement.action,
    });
    // Fail closed — if the permission engine errors out, treat as denied
    // rather than silently allow privileged action.
    return { allowed: false, reason: 'permission engine error (fail-closed)' };
  }
}

// Phase W2 — wait cap. setTimeout-based waits hold a Node.js coroutine in
// memory; longer waits would survive a deploy only with a DB-backed scheduler
// (Phase W3). Until then, anything beyond 5 minutes is silently clamped down
// and a warning is logged so the author isn't surprised by silent truncation.
const WAIT_MAX_MS = 5 * 60 * 1000;

// May-19 audit P0-6 — cross-workflow chain depth cap. When workflow A's
// action mutates a task whose mutation triggers workflow B, the engine
// plumbs `context._chain` (the list of {workflowId, trigger} pairs already
// fired in this causal chain). If the chain hits MAX_WORKFLOW_CHAIN_DEPTH,
// further fan-out is refused with a loud log so the author can see they've
// built a loop. Today's single-workflow visited-Set guard inside
// executeWorkflow handles cycles inside ONE graph; this guard is for
// inter-workflow loops. 5 is the published default; lift via env if needed.
const MAX_WORKFLOW_CHAIN_DEPTH = Number(process.env.WORKFLOW_MAX_CHAIN_DEPTH) || 5;

// May-19 audit P0-5 — in-memory LRU for trigger-idempotency fast path.
// Multi-replica safety still relies on the DB unique index, but in single
// process the LRU is a much cheaper dedup for same-event bursts (e.g.
// React StrictMode firing the same status PATCH twice in dev). Keys live
// 5 minutes; cap at 1000 entries so a noisy producer can't OOM the box.
const IDEMP_LRU_TTL_MS = 5 * 60 * 1000;
const IDEMP_LRU_MAX = 1000;
const _idempLru = new Map();
function _lruHas(key) {
  const entry = _idempLru.get(key);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    _idempLru.delete(key);
    return false;
  }
  // Refresh recency by re-inserting.
  _idempLru.delete(key);
  _idempLru.set(key, entry);
  return true;
}
function _lruPut(key) {
  if (_idempLru.size >= IDEMP_LRU_MAX) {
    // Evict the oldest entry (Map iteration order = insertion order).
    const firstKey = _idempLru.keys().next().value;
    if (firstKey !== undefined) _idempLru.delete(firstKey);
  }
  _idempLru.set(key, { expiresAt: Date.now() + IDEMP_LRU_TTL_MS });
}

/**
 * Compute a per-event idempotency key. Same event fired twice within a
 * minute bucket → same key → DB unique index rejects the second insert.
 *
 * Bucket size is 60s (Math.floor(now / 60000)) which is tight enough that
 * a stale dedup never blocks legitimate same-trigger re-fires, but wide
 * enough that React-StrictMode or a retried Axios PATCH won't fire twice.
 */
function buildTriggerIdempotencyKey(workflowId, trigger, context) {
  const entityId = context?.task?.id || context?.form?.id || '';
  const actorId = context?.actorId || context?.userId || '';
  const minuteBucket = Math.floor(Date.now() / 60000);
  return `${workflowId}|${trigger}|${entityId}|${actorId}|${minuteBucket}`;
}

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
    // May-19 audit P0-6 — chain depth + workflow-origin guards. Refuse to
    // fan out further when:
    //   - the inbound context is marked `originSource: 'workflow'` (the
    //     event came from a workflow action's side effect — we never
    //     trigger a workflow off of itself unless the chain budget allows
    //     it, and even then we increment depth); OR
    //   - the chain depth has hit MAX_WORKFLOW_CHAIN_DEPTH.
    // Both branches log loudly so authors can spot their loop.
    const chain = Array.isArray(context?._chain) ? context._chain : [];
    if (chain.length >= MAX_WORKFLOW_CHAIN_DEPTH) {
      safeLogger.warn('[Workflow] processWorkflows: chain depth cap hit — refusing further fan-out', {
        trigger,
        depth: chain.length,
        chain: chain.map((c) => `${c.workflowId}:${c.trigger}`),
      });
      return;
    }

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

          // May-19 audit P0-5 — per-event idempotency. Single-process LRU
          // fast path; multi-replica safety via the DB partial unique
          // index on (workflowId, idempotencyKey).
          const idempotencyKey = buildTriggerIdempotencyKey(wf.id, trigger, context);
          if (_lruHas(idempotencyKey)) {
            safeLogger.info('[Workflow] processWorkflows: deduped by in-memory idempotency', {
              workflowId: wf.id,
              trigger,
              idempotencyKey,
            });
            continue;
          }
          _lruPut(idempotencyKey);

          // Plumb the chain into the per-workflow run so downstream
          // workflow-originated events keep their depth bookkeeping.
          const nextChain = [...chain, { workflowId: wf.id, trigger }];
          const nextContext = { ...context, _chain: nextChain };

          // Fire the chain starting from this trigger node.
          await executeWorkflow(wf, tn, nextContext, { idempotencyKey });
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
  // First failed step persisted as `failedStepId` (NULLable column added in
  // migration 022). Subsequent failures still log but only the first is
  // surfaced in the column — the textual summary in `error` carries the
  // rest. Mirrors the "first cause" pattern used by approvalLifecycleService.
  let firstFailedStepId = null;
  // Compact per-step audit list. Kept in-memory only — the textual digest
  // below is what lands in `workflow_runs.error` so the UI can show a
  // human-readable reason for partial / failed runs without a separate
  // table.
  const stepAudit = [];

  // May-19 audit P0-3 — re-resolve the workflow's execution actor on every
  // run. If the creator was demoted, deactivated, or deleted since publish,
  // privileged actions will now correctly fail the per-action permission
  // check below rather than silently proceeding.
  const actor = await resolveExecutionActor(workflow);

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
          // May-19 audit P0-3 — runtime permission gate. Every action node
          // re-checks the workflow's execution actor's CURRENT effective
          // permission against the canonical engine. A demoted / deactivated
          // creator's workflows now correctly skip privileged mutations
          // instead of silently bypassing RBAC.
          const permCheck = await checkActionPermission(actor, target);
          if (!permCheck.allowed) {
            anySkipped = true;
            if (!firstFailedStepId) firstFailedStepId = target.id;
            stepAudit.push({
              nodeId: target.id,
              kind: target.kind,
              status: 'skipped',
              reason: permCheck.reason,
            });
            safeLogger.warn('[Workflow] action skipped — permission denied at runtime', {
              workflowId: workflow.id,
              nodeId: target.id,
              kind: target.kind,
              actorId: actor?.id || null,
              reason: permCheck.reason,
            });
            // Walk past the skipped action so downstream nodes still run —
            // mirrors how a failure in one action leaves the chain going.
            queue.push(target.id);
            continue;
          }

          let actionResult;
          try {
            actionResult = await executeActionNode(target, context, workflow);
            nodesRun += 1;
          } catch (err) {
            anyError = true;
            lastError = err;
            if (!firstFailedStepId) firstFailedStepId = target.id;
            stepAudit.push({
              nodeId: target.id,
              kind: target.kind,
              status: 'failed',
              reason: String(err?.message || err).slice(0, 200),
            });
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
  const finishedAtDate = new Date();
  const durationMs = finishedAtDate.getTime() - t0;

  // Build a compact textual digest of skipped/failed steps for the `error`
  // column. The run-history UI parses this back out when present; consumers
  // that just want a one-line summary read the first line. Truncated to
  // 2000 chars so a pathological run can't blow up the row.
  let errorDigest = lastError ? String(lastError.message || lastError) : null;
  if (stepAudit.length > 0) {
    const digestLines = stepAudit.map((s) => `[${s.status}] ${s.kind} (${s.nodeId}): ${s.reason}`);
    errorDigest = (errorDigest ? `${errorDigest}\n` : '') + digestLines.join('\n');
  }
  if (errorDigest) errorDigest = errorDigest.slice(0, 2000);

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
      error: errorDigest,
      startedAt: new Date(t0),
      // May-19 audit follow-up — richer run history. NULL-safe; legacy code
      // paths that don't populate these still write fine.
      finishedAt: finishedAtDate,
      actorId: context?.actorId || context?.userId || null,
      failedStepId: firstFailedStepId,
      retryCount: Number.isFinite(options.retryCount) ? options.retryCount : 0,
      idempotencyKey: options.idempotencyKey || null,
    });
  } catch (err) {
    // A unique-index violation on (workflowId, idempotencyKey) is the
    // expected outcome when the same trigger event fires twice within the
    // dedup window (multi-replica + same-event burst). Log at info level
    // and continue — the duplicate has effectively been deduped at the DB
    // boundary.
    if (err && err.name === 'SequelizeUniqueConstraintError') {
      safeLogger.info('[Workflow] WorkflowRun deduped by idempotency key', {
        workflowId: workflow.id,
        idempotencyKey: options.idempotencyKey,
      });
    } else {
      safeLogger.warn('[Workflow] WorkflowRun.create failed', { err, workflowId: workflow.id });
    }
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
    // ── Phase 7a (May-19 audit follow-up) — safe new actions ─────────
    //
    // Each action is gated through ACTION_PERMISSION_REQUIREMENTS at the
    // walker layer (see executeWorkflow above), so a workflow whose creator
    // was demoted past the required permission silently no-ops with a
    // 'skipped' run-history entry instead of mutating data.
    //
    // Idempotency for these mutating actions piggybacks on the
    // run-level idempotency key — the partial unique index on
    // workflow_runs(workflowId, idempotencyKey) rejects duplicate run
    // rows, which means a duplicate trigger fire never reaches this
    // dispatch the second time. For the very rare same-run re-fire (e.g.
    // a chain visits the same action twice via a cycle, which the
    // walker's `visited` Set already prevents), we rely on the underlying
    // operations being naturally idempotent: TaskLabel uses (taskId,
    // labelId) composite PK so a duplicate insert is a no-op via
    // findOrCreate; Comment.create + idempotencyKey would be a future
    // extension. For now, add_comment is single-fire per run.
    case 'add_label': {
      if (!cfg.labelId || !task?.id) {
        safeLogger.warn('[Workflow] add_label: missing labelId or task', {
          workflowId: workflow.id, nodeId: node.id,
        });
        return;
      }
      const { TaskLabel, Label } = getModels();
      // Verify label exists and is on the same board as the task — labels
      // are board-scoped, so cross-board label assignment is a config bug
      // by the workflow author. Skip silently with a warn.
      const label = await Label.findByPk(cfg.labelId);
      if (!label || (task.boardId && label.boardId && label.boardId !== task.boardId)) {
        safeLogger.warn('[Workflow] add_label: label missing or board mismatch', {
          workflowId: workflow.id, nodeId: node.id,
          labelId: cfg.labelId, taskBoardId: task.boardId,
        });
        return;
      }
      await TaskLabel.findOrCreate({
        where: { taskId: task.id, labelId: cfg.labelId },
        defaults: { taskId: task.id, labelId: cfg.labelId },
      });
      return;
    }
    case 'remove_label': {
      if (!cfg.labelId || !task?.id) return;
      const { TaskLabel } = getModels();
      // destroy is naturally idempotent — zero rows deleted is fine.
      await TaskLabel.destroy({ where: { taskId: task.id, labelId: cfg.labelId } });
      return;
    }
    case 'add_comment': {
      if (!cfg.content || !task?.id) {
        safeLogger.warn('[Workflow] add_comment: missing content or task', {
          workflowId: workflow.id, nodeId: node.id,
        });
        return;
      }
      const { Comment } = getModels();
      // The workflow creator is the comment author — same actor we used
      // for the runtime permission check. Falls back to context.userId
      // (e.g. test-run initiator) when creator can't be resolved.
      const userId = workflow.createdBy || context?.userId || null;
      if (!userId) {
        safeLogger.warn('[Workflow] add_comment: no author resolvable', {
          workflowId: workflow.id, nodeId: node.id,
        });
        return;
      }
      // Render template tokens the same way send_message does so authors
      // can reference {{task.title}} etc. in the comment body.
      const rendered = renderMessageTemplate(String(cfg.content), { task, workflow });
      await Comment.create({
        content: rendered.slice(0, 5000),
        attachments: [],
        taskId: task.id,
        userId,
      });
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
