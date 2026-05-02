/**
 * Phase 3 — pure unit tests for the frontend eventRouter.
 *
 * The router is pure JS (no React, no socket) so it's testable from Node
 * directly, no test framework needed. Reproduces every routing rule the
 * RealtimeProvider relies on, so a regression in the router is caught by
 * `node server/__tests__/realtime-phase3-router-unit.js`.
 */

/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');

// Transform the ESM router to CJS via esbuild so we can require it from Node.
// Avoids polluting the prod build with a CJS shadow file.
const esbuildPath = path.resolve(__dirname, '../../client/node_modules/esbuild');
const esbuild = require(esbuildPath);
const routerPath = path.resolve(__dirname, '../../client/src/realtime/eventRouter.js');
const transformed = esbuild.transformSync(
  fs.readFileSync(routerPath, 'utf8'),
  { loader: 'js', format: 'cjs' }
);
const m = { exports: {} };
new Function('module', 'exports', 'require', transformed.code)(m, m.exports, require);
const { routeEvent } = m.exports;

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else    { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}
function has(arr, key) { return Array.isArray(arr) && arr.includes(key); }

console.log('▶ eventRouter pure-function tests\n');

// ── task lifecycle ──
{
  const out = routeEvent('task:created', { taskId: 'T1', boardId: 'B1', groupId: 'G1' });
  check('task:created → tasks.board.B1', has(out, 'tasks.board.B1'));
  check('task:created → tasks.id.T1', has(out, 'tasks.id.T1'));
  check('task:created → tasks.assignedTo.me', has(out, 'tasks.assignedTo.me'));
  check('task:created → dashboard.stats', has(out, 'dashboard.stats'));
}
{
  // legacy nested shape (pre-envelope) still routes
  const out = routeEvent('task:updated', { task: { id: 'T2', boardId: 'B2' } });
  check('legacy nested task.id falls back', has(out, 'tasks.id.T2'));
  check('legacy nested task.boardId falls back', has(out, 'tasks.board.B2'));
}
{
  const out = routeEvent('task:deleted', { taskId: 'T3', boardId: 'B3' });
  check('task:deleted → tasks.board.B3', has(out, 'tasks.board.B3'));
}

// ── subtasks (Phase 2) ──
{
  const out = routeEvent('subtask:created', { taskId: 'T4', boardId: 'B4' });
  check('subtask:created → subtasks.task.T4', has(out, 'subtasks.task.T4'));
  check('subtask:created bumps parent task cache', has(out, 'tasks.id.T4'));
  check('subtask:created bumps board task list (badge)', has(out, 'tasks.board.B4'));
}

// ── watchers (Phase 2) ──
{
  const out = routeEvent('watcher:added', { taskId: 'T5', watcherUserId: 'U5' });
  check('watcher:added → watchers.task.T5', has(out, 'watchers.task.T5'));
  check('watcher:added bumps parent task', has(out, 'tasks.id.T5'));
}

// ── approvals ──
{
  const out = routeEvent('task:approval-updated', { taskId: 'T6', boardId: 'B6' });
  check('task:approval-updated → approvals.task.T6', has(out, 'approvals.task.T6'));
  check('task:approval-updated → tasks.id.T6', has(out, 'tasks.id.T6'));
}

// ── notifications ──
{
  const out = routeEvent('notification:new', { notification: { id: 'N1' } });
  check('notification:new → notifications.list', has(out, 'notifications.list'));
  check('notification:new → notifications.unreadCount', has(out, 'notifications.unreadCount'));
}

// ── boards ──
{
  const out = routeEvent('board:memberAdded', { board: { id: 'B7' } });
  check('board:memberAdded → boards.list', has(out, 'boards.list'));
  check('board:memberAdded → boards.id.B7', has(out, 'boards.id.B7'));
  check('board:memberAdded also touches my task list', has(out, 'tasks.assignedTo.me'));
}

// ── unknown events return [] ──
{
  const out = routeEvent('totally:made-up-event', { foo: 'bar' });
  check('unknown event returns empty array', Array.isArray(out) && out.length === 0);
}

// ── empty payload doesn't crash ──
{
  const out = routeEvent('task:updated', {});
  check('empty payload returns at least the broadcast keys', has(out, 'tasks.assignedTo.me'));
  check('empty payload omits id-bound keys', !out.some(k => k.includes('undefined') || k.includes('null')));
}

console.log(`\n══════════════════════════════════════════════════════`);
console.log(`PHASE 3 ROUTER UNIT: ${pass} passed, ${fail} failed`);
console.log(`══════════════════════════════════════════════════════`);
process.exit(fail ? 1 : 0);
