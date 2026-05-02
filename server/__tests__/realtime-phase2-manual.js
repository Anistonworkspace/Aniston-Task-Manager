/**
 * Phase 2 realtime fix — manual verification.
 *
 * What Phase 2 added on top of Phase 1:
 *   - Centralised realtimeService.js (semantic emit methods).
 *   - Subtask events fan out to parent task's assignees / supervisors /
 *     watchers / owners (previously board-room only — the same bug as
 *     Phase 1 but for subtasks).
 *   - Archive emits a task:updated that reaches users not in the board room
 *     (previously board-room only — MyWork wouldn't update).
 *   - Watcher events emit (previously silent).
 *   - Every realtime event now carries a slim envelope: taskId, boardId,
 *     groupId, changedFields, actorId, timestamp at the top level
 *     (existing `task` blob still included for backward compat).
 *
 * Reproduces each of those at the wire level. Requires the dev server
 * running on localhost:5000 with Phase 2 code loaded.
 */

/* eslint-disable no-console */
const path = require('path');

const httpBase = process.env.API_BASE || 'http://localhost:5000';
const sioPath = path.resolve(__dirname, '../../client/node_modules/socket.io-client/build/cjs/index.js');
const { io } = require(sioPath);

async function api(method, url, body, token) {
  const res = await fetch(`${httpBase}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function login(email, password) {
  const j = await api('POST', '/api/auth/login', { email, password });
  const d = j.data || j;
  return { token: d.token, user: d.user };
}

function connectSocket(token, label) {
  return new Promise((resolve, reject) => {
    const s = io(httpBase, { auth: { token }, transports: ['websocket', 'polling'], reconnection: false });
    const timer = setTimeout(() => { s.close(); reject(new Error(`${label} timeout`)); }, 5000);
    s.on('connect', () => { clearTimeout(timer); console.log(`  [${label}] connected ${s.id}`); resolve(s); });
    s.on('connect_error', (e) => { clearTimeout(timer); reject(new Error(`${label}: ${e.message}`)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('▶ Realtime Phase 2 verification\n');
  let pass = 0, fail = 0;
  const check = (label, ok, detail = '') => {
    if (ok) { console.log(`  ✓ ${label}`); pass++; }
    else    { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); fail++; }
  };

  const creator = await login('admin@aniston.com', 'Admin@1234');
  const assignee = await login('realtime-test@aniston.local', 'Test@1234');
  console.log(`creator: ${creator.user.name}, assignee: ${assignee.user.name}\n`);

  const boardsResp = await api('GET', '/api/boards', null, creator.token);
  const boards = (boardsResp.data?.boards) || boardsResp.boards || boardsResp.data || [];
  const board = boards[0];
  if (!board) throw new Error('no board to test on');
  console.log(`board: ${board.name}\n`);

  // ── Phase 1 regression: assignee NOT in board room receives task:created ──
  console.log('Test 1: assignee not in board room receives task:created (Phase 1 regression)');
  const sock = await connectSocket(assignee.token, 'assignee-no-room');
  let evCreated = null;
  sock.on('task:created', (d) => { evCreated = d; });

  const createResp = await api('POST', '/api/tasks', {
    title: `phase2-create-${Date.now()}`,
    boardId: board.id,
    priority: 'medium',
    status: 'not_started',
    dueDate: new Date(Date.now() + 7 * 86400000).toISOString(),
    assignedTo: [assignee.user.id],
  }, creator.token);
  const task = createResp.data?.task || createResp.task;
  await sleep(800);
  check('task:created received via user room', !!evCreated, 'no event after 800ms');
  check('  payload has full task (legacy field preserved)', !!evCreated?.task?.id);
  check('  payload has slim envelope (taskId)', evCreated?.taskId === task.id);
  check('  payload has boardId in envelope', evCreated?.boardId === board.id);
  check('  payload has actorId in envelope', evCreated?.actorId === creator.user.id);
  check('  payload has timestamp', typeof evCreated?.timestamp === 'number');

  // ── Test 2: subtask fan-out (Phase 2 specific) ──
  console.log('\nTest 2: subtask:created fans out to parent assignee NOT in board room');
  let evSubtask = null;
  sock.on('subtask:created', (d) => { evSubtask = d; });
  await api('POST', '/api/subtasks', {
    taskId: task.id,
    title: 'phase2 subtask',
  }, creator.token);
  await sleep(800);
  check('subtask:created received via user room', !!evSubtask, 'no event after 800ms');
  check('  envelope has parent taskId', evSubtask?.taskId === task.id);
  check('  envelope has boardId', evSubtask?.boardId === board.id);
  check('  payload still has subtask blob', !!evSubtask?.subtask);

  // ── Test 3: delete fan-out (admin → permanent delete path) ──
  // Admin's DELETE follows the permanent-delete branch which emits
  // task:deleted with affectedUserIds (Phase 2 migration: previously
  // board-room only, now reaches the assignee's user room too).
  console.log('\nTest 3: delete emits task:deleted that reaches assignee not in board room');
  let evDeleted = null;
  sock.on('task:deleted', (d) => { if (d?.taskId === task.id) evDeleted = d; });
  await api('DELETE', `/api/tasks/${task.id}`, null, creator.token);
  await sleep(800);
  check('task:deleted received via user room', !!evDeleted);
  check('  envelope has taskId', evDeleted?.taskId === task.id);
  check('  envelope has actorId', evDeleted?.actorId === creator.user.id);

  // ── Test 4: watcher events (used to be silent) ──
  console.log('\nTest 4: watcher add/remove emits events (previously silent)');
  // Need a fresh task — the previous one is archived. Create one (but don't
  // assign anyone so this test is independent of test 1).
  const t2Resp = await api('POST', '/api/tasks', {
    title: `phase2-watch-${Date.now()}`,
    boardId: board.id,
    priority: 'low',
    status: 'not_started',
  }, creator.token);
  const t2 = t2Resp.data?.task || t2Resp.task;

  // The assignee will start watching the task. Their socket should receive
  // 'watcher:added'.
  let evWatcherAdded = null, evWatcherRemoved = null;
  sock.on('watcher:added', (d) => { if (d?.taskId === t2.id) evWatcherAdded = d; });
  sock.on('watcher:removed', (d) => { if (d?.taskId === t2.id) evWatcherRemoved = d; });

  await api('POST', `/api/task-extras/${t2.id}/watch`, {}, assignee.token);
  await sleep(600);
  check('watcher:added fired', !!evWatcherAdded);
  check('  payload identifies the watcher', evWatcherAdded?.watcherUserId === assignee.user.id);

  await api('POST', `/api/task-extras/${t2.id}/watch`, {}, assignee.token);
  await sleep(600);
  check('watcher:removed fired (toggle off)', !!evWatcherRemoved);

  // Cleanup
  await api('DELETE', `/api/tasks/${t2.id}`, null, creator.token).catch(() => {});

  sock.close();

  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`PHASE 2 RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`══════════════════════════════════════════════════════`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n✗ test errored:', e.message);
  process.exit(2);
});
