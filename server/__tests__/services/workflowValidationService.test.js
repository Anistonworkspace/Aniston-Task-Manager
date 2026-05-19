'use strict';

/**
 * Unit tests for workflowValidationService — pure-function validator used
 * by workflowController.updateWorkflow before flipping isActive=true.
 *
 * Pure function, zero side effects, no DB mocks needed.
 */

const { validateWorkflowGraph } = require('../../services/workflowValidationService');

function n(id, type, kind, config = {}) {
  return { id, type, kind, config };
}
function e(id, src, tgt, branch = null) {
  return { id, sourceNodeId: src, targetNodeId: tgt, branch };
}

describe('validateWorkflowGraph', () => {
  test('rejects empty workflow (no trigger)', () => {
    const r = validateWorkflowGraph({ workflow: {}, nodes: [], edges: [] });
    expect(r.valid).toBe(false);
    expect(r.errors.map((x) => x.code)).toContain('NO_TRIGGER');
  });

  test('rejects trigger with no outgoing edge', () => {
    const r = validateWorkflowGraph({
      workflow: {},
      nodes: [n('t1', 'trigger', 'task_created')],
      edges: [],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.map((x) => x.code)).toContain('TRIGGER_DEAD_END');
  });

  test('accepts a valid linear chain', () => {
    const r = validateWorkflowGraph({
      workflow: {},
      nodes: [
        n('t1', 'trigger', 'task_created'),
        n('a1', 'action', 'change_status', { to: 'done' }),
      ],
      edges: [e('e1', 't1', 'a1')],
    });
    expect(r.valid).toBe(true);
    expect(r.errors.filter((x) => x.severity === 'error')).toEqual([]);
  });

  test('rejects self-edge', () => {
    const r = validateWorkflowGraph({
      workflow: {},
      nodes: [n('t1', 'trigger', 'task_created')],
      edges: [e('e1', 't1', 't1')],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.map((x) => x.code)).toContain('EDGE_SELF_LOOP');
  });

  test('rejects orphan action node', () => {
    const r = validateWorkflowGraph({
      workflow: {},
      nodes: [
        n('t1', 'trigger', 'task_created'),
        n('a1', 'action', 'change_status', { to: 'done' }),
        n('a2', 'action', 'change_priority', { to: 'high' }),
      ],
      edges: [e('e1', 't1', 'a1')], // a2 unreachable
    });
    expect(r.valid).toBe(false);
    expect(r.errors.map((x) => x.code)).toContain('NODE_ORPHAN');
  });

  test('rejects missing required config (change_status without `to`)', () => {
    const r = validateWorkflowGraph({
      workflow: {},
      nodes: [
        n('t1', 'trigger', 'task_created'),
        n('a1', 'action', 'change_status', {}),
      ],
      edges: [e('e1', 't1', 'a1')],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.map((x) => x.code)).toContain('ACTION_MISSING_CONFIG');
  });

  test('rejects bad condition operator', () => {
    const r = validateWorkflowGraph({
      workflow: {},
      nodes: [
        n('t1', 'trigger', 'task_created'),
        n('c1', 'condition', 'condition_field', { field: 'task.status', operator: 'banana', value: 'done' }),
      ],
      edges: [e('e1', 't1', 'c1')],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.map((x) => x.code)).toContain('CONDITION_BAD_OPERATOR');
  });

  test('rejects duplicate edge between same pair', () => {
    const r = validateWorkflowGraph({
      workflow: {},
      nodes: [
        n('t1', 'trigger', 'task_created'),
        n('a1', 'action', 'change_status', { to: 'done' }),
      ],
      edges: [e('e1', 't1', 'a1'), e('e2', 't1', 'a1')],
    });
    expect(r.valid).toBe(false);
    expect(r.errors.map((x) => x.code)).toContain('EDGE_DUPLICATE');
  });

  test('accepts the new safe actions (add_label / remove_label / add_comment) with correct config', () => {
    const r = validateWorkflowGraph({
      workflow: {},
      nodes: [
        n('t1', 'trigger', 'task_created'),
        n('a1', 'action', 'add_label', { labelId: 'L1' }),
        n('a2', 'action', 'remove_label', { labelId: 'L1' }),
        n('a3', 'action', 'add_comment', { content: 'Hi' }),
      ],
      edges: [
        e('e1', 't1', 'a1'),
        e('e2', 'a1', 'a2'),
        e('e3', 'a2', 'a3'),
      ],
    });
    expect(r.valid).toBe(true);
  });

  test('warns (does not block) on a cycle', () => {
    const r = validateWorkflowGraph({
      workflow: {},
      nodes: [
        n('t1', 'trigger', 'task_created'),
        n('a1', 'action', 'change_status', { to: 'done' }),
        n('a2', 'action', 'change_priority', { to: 'high' }),
      ],
      edges: [
        e('e1', 't1', 'a1'),
        e('e2', 'a1', 'a2'),
        e('e3', 'a2', 'a1'), // cycle back to a1
      ],
    });
    // No fatal errors; only a warning.
    expect(r.valid).toBe(true);
    expect(r.errors.find((x) => x.code === 'GRAPH_CYCLE' && x.severity === 'warning')).toBeTruthy();
  });
});
