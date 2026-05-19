'use strict';

/**
 * workflowValidationService — server-side graph validation for publish.
 *
 * Called from workflowController.updateWorkflow when isActive transitions
 * false → true. Returns `{ valid, errors }`. A valid publish requires:
 *
 *   - At least one trigger node.
 *   - Every trigger node has ≥1 outgoing edge (otherwise it fires and
 *     immediately stops — confusing but not destructive).
 *   - Action nodes have the required config keys for their kind (e.g.
 *     change_status requires `to`; notify_user requires a recipient).
 *   - Condition nodes have field + operator + (value for non-{is_set,is_empty}).
 *   - No orphan action / condition nodes — every action / condition must be
 *     reachable from at least one trigger node (BFS from triggers).
 *   - No self-edges. No duplicate edges between same (source, target).
 *   - Branch labels: 'true' / 'false' / null only.
 *
 * Cycles inside the graph are NOT a hard publish blocker — the runtime
 * walker has its own `visited` Set guard — but a warning is emitted in
 * the errors output so the canvas author can fix it. We return them under
 * `errors[].severity === 'warning'` so the controller can decide whether
 * to block or surface as soft feedback. Today: warnings DO NOT block.
 *
 * Pure function — no DB calls. The controller loads workflow + nodes +
 * edges and passes them in. This keeps the service trivially unit-
 * testable and free of mock-DB plumbing.
 */

// Per-action-kind required config keys. Matches workflowEngine's action
// handlers — adding a new action there REQUIRES adding the schema row
// here so publish validation stays in sync.
const ACTION_CONFIG_SCHEMAS = {
  notify_user:     { required: ['userId'], description: 'notify_user needs a recipient (userId or "assignee")' },
  change_status:   { required: ['to'],     description: 'change_status needs a target status (`to`)' },
  change_priority: { required: ['to'],     description: 'change_priority needs a target priority (`to`)' },
  assign_to:       { required: ['userId'], description: 'assign_to needs a target userId' },
  send_message:    { required: ['text'],   description: 'send_message needs a message body (`text`)' },
  wait:            { required: ['minutes'], description: 'wait needs a duration in minutes' },
  // Phase 7a — safe new actions.
  add_label:       { required: ['labelId'],   description: 'add_label needs a labelId' },
  remove_label:    { required: ['labelId'],   description: 'remove_label needs a labelId' },
  add_comment:     { required: ['content'],   description: 'add_comment needs a content body' },
};

const VALID_TRIGGER_KINDS = new Set([
  'task_created', 'task_updated', 'status_changed', 'task_assigned', 'form_submitted',
]);
const VALID_OPERATORS = new Set([
  'equals', 'not_equals', 'contains', 'is_set', 'is_empty',
]);
const VALID_BRANCH_VALUES = new Set([null, undefined, 'true', 'false', '']);

/**
 * @param {object} args
 * @param {object} args.workflow         — the Workflow row (only id/name needed)
 * @param {object[]} args.nodes          — array of WorkflowNode rows
 * @param {object[]} args.edges          — array of WorkflowEdge rows
 * @returns {{ valid: boolean, errors: Array<{ code: string, message: string, nodeId?: string, edgeId?: string, severity: 'error'|'warning' }> }}
 */
function validateWorkflowGraph({ workflow, nodes, edges } = {}) {
  const errors = [];
  const push = (code, message, extra = {}) => errors.push({ code, message, severity: 'error', ...extra });
  const warn = (code, message, extra = {}) => errors.push({ code, message, severity: 'warning', ...extra });

  const nodeList = Array.isArray(nodes) ? nodes : [];
  const edgeList = Array.isArray(edges) ? edges : [];

  // ── Trigger presence ───────────────────────────────────────────────
  const triggers = nodeList.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) {
    push('NO_TRIGGER', 'Workflow needs at least one trigger node before publish.');
  }
  for (const t of triggers) {
    if (!VALID_TRIGGER_KINDS.has(t.kind)) {
      push('BAD_TRIGGER_KIND', `Unknown trigger kind "${t.kind}".`, { nodeId: t.id });
    }
  }

  // ── Edge sanity ────────────────────────────────────────────────────
  const seenEdge = new Set(); // 'src→tgt|branch' for dedup
  const nodeIds = new Set(nodeList.map((n) => n.id));
  for (const e of edgeList) {
    if (!nodeIds.has(e.sourceNodeId)) {
      push('EDGE_BAD_SOURCE', 'Edge points from a node that does not exist on this workflow.', { edgeId: e.id });
      continue;
    }
    if (!nodeIds.has(e.targetNodeId)) {
      push('EDGE_BAD_TARGET', 'Edge points to a node that does not exist on this workflow.', { edgeId: e.id });
      continue;
    }
    if (e.sourceNodeId === e.targetNodeId) {
      push('EDGE_SELF_LOOP', 'An edge cannot connect a node to itself.', { edgeId: e.id });
      continue;
    }
    if (!VALID_BRANCH_VALUES.has(e.branch)) {
      push('EDGE_BAD_BRANCH', `Edge branch must be 'true', 'false', or empty. Got "${e.branch}".`, { edgeId: e.id });
    }
    const key = `${e.sourceNodeId}→${e.targetNodeId}|${e.branch || ''}`;
    if (seenEdge.has(key)) {
      push('EDGE_DUPLICATE', 'Duplicate edge between the same two nodes.', { edgeId: e.id });
    }
    seenEdge.add(key);
  }

  // ── Trigger out-degree ─────────────────────────────────────────────
  const outBySource = new Map();
  for (const e of edgeList) {
    const arr = outBySource.get(e.sourceNodeId) || [];
    arr.push(e);
    outBySource.set(e.sourceNodeId, arr);
  }
  for (const t of triggers) {
    if ((outBySource.get(t.id) || []).length === 0) {
      push('TRIGGER_DEAD_END', `Trigger node "${t.kind}" has no outgoing edge — publishing it will fire and immediately stop.`, { nodeId: t.id });
    }
  }

  // ── Action / condition config ──────────────────────────────────────
  for (const n of nodeList) {
    if (n.type === 'action') {
      const schema = ACTION_CONFIG_SCHEMAS[n.kind];
      if (!schema) {
        push('ACTION_UNKNOWN_KIND', `Unknown action kind "${n.kind}".`, { nodeId: n.id });
        continue;
      }
      const cfg = n.config || {};
      for (const key of schema.required) {
        const v = cfg[key];
        if (v === undefined || v === null || v === '') {
          push('ACTION_MISSING_CONFIG', `${schema.description}. Missing "${key}".`, { nodeId: n.id });
        }
      }
      // Wait specific — minutes must be > 0 and finite.
      if (n.kind === 'wait') {
        const m = Number(cfg.minutes);
        if (!Number.isFinite(m) || m <= 0) {
          push('ACTION_WAIT_INVALID', 'wait minutes must be a positive number.', { nodeId: n.id });
        }
      }
    } else if (n.type === 'condition') {
      const cfg = n.config || {};
      if (!cfg.field || typeof cfg.field !== 'string') {
        push('CONDITION_MISSING_FIELD', 'Condition needs a `field` (e.g. "task.status").', { nodeId: n.id });
      }
      if (!cfg.operator || !VALID_OPERATORS.has(String(cfg.operator))) {
        push('CONDITION_BAD_OPERATOR', `Condition operator must be one of: ${[...VALID_OPERATORS].join(', ')}.`, { nodeId: n.id });
      }
      // Value is required for equals/not_equals/contains.
      const needsValue = ['equals', 'not_equals', 'contains'].includes(String(cfg.operator));
      if (needsValue && (cfg.value === undefined || cfg.value === null || cfg.value === '')) {
        push('CONDITION_MISSING_VALUE', 'Condition operator requires a value to compare against.', { nodeId: n.id });
      }
    }
  }

  // ── Orphan detection — every action/condition must be BFS-reachable
  //    from at least one trigger.
  const reachable = new Set();
  const queue = triggers.map((t) => t.id);
  for (const id of queue) reachable.add(id);
  while (queue.length) {
    const current = queue.shift();
    for (const e of (outBySource.get(current) || [])) {
      if (!reachable.has(e.targetNodeId)) {
        reachable.add(e.targetNodeId);
        queue.push(e.targetNodeId);
      }
    }
  }
  for (const n of nodeList) {
    if (n.type === 'trigger') continue;
    if (!reachable.has(n.id)) {
      push('NODE_ORPHAN', `${n.type === 'action' ? 'Action' : 'Condition'} node "${n.kind}" is not reachable from any trigger.`, { nodeId: n.id });
    }
  }

  // ── Cycle warning (informational; walker has its own visited guard) ─
  // Trivial DFS: any node we visit twice via different paths means a cycle.
  // We only flag this as a warning; the engine still walks safely.
  const cycleStack = new Set();
  const seenInPath = new Set();
  function dfs(id) {
    if (cycleStack.has(id)) return id; // back-edge to a node still on the path
    if (seenInPath.has(id)) return null;
    seenInPath.add(id);
    cycleStack.add(id);
    for (const e of (outBySource.get(id) || [])) {
      const hit = dfs(e.targetNodeId);
      if (hit) {
        cycleStack.delete(id);
        return hit;
      }
    }
    cycleStack.delete(id);
    return null;
  }
  for (const t of triggers) {
    const hit = dfs(t.id);
    if (hit) {
      warn('GRAPH_CYCLE', 'Workflow contains a cycle. The runtime walker will halt repeats safely, but this is usually unintentional.', { nodeId: hit });
      break; // one warning is enough
    }
  }

  const fatalErrors = errors.filter((e) => e.severity === 'error');
  return { valid: fatalErrors.length === 0, errors };
}

module.exports = {
  validateWorkflowGraph,
  ACTION_CONFIG_SCHEMAS,
  VALID_TRIGGER_KINDS,
  VALID_OPERATORS,
};
