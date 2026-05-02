/**
 * Phase 1 realtime fix — manual verification.
 *
 * Reproduces the screenshot bug at the wire level:
 *   creator (admin) creates a task assigned to assignee (member)
 *   → assignee MUST receive 'task:created' on their socket without being
 *     in the board's socket room.
 *
 * Prior to Phase 1: assignee gets nothing (the emit only went to the board
 * room). With Phase 1's emitToBoardAndUsers: assignee receives the event
 * via their personal user:<id> room.
 *
 * Run:
 *   node server/__tests__/realtime-phase1-manual.js
 *
 * Requires the dev server to be running on http://localhost:5000.
 */

/* eslint-disable no-console */
const path = require('path');
const fs = require('fs');

const httpBase = process.env.API_BASE || 'http://localhost:5000';

// Use the client's socket.io-client (CJS build) so we don't have to add a dep.
const sioPath = path.resolve(__dirname, '../../client/node_modules/socket.io-client/build/cjs/index.js');
if (!fs.existsSync(sioPath)) {
  console.error('socket.io-client not found at', sioPath);
  process.exit(2);
}
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
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function login(email, password) {
  const j = await api('POST', '/api/auth/login', { email, password });
  const d = j.data || j;
  return { token: d.token, user: d.user };
}

function connectSocket(token, label) {
  return new Promise((resolve, reject) => {
    const s = io(httpBase, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: false,
    });
    const timer = setTimeout(() => {
      s.close();
      reject(new Error(`${label} socket connect timeout`));
    }, 5000);
    s.on('connect', () => {
      clearTimeout(timer);
      console.log(`  [${label}] socket connected:`, s.id);
      resolve(s);
    });
    s.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label} connect_error: ${err.message}`));
    });
  });
}

function waitForEvent(socket, event, timeoutMs, label) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve({ received: false });
    }, timeoutMs);
    const handler = (data) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve({ received: true, data });
    };
    socket.on(event, handler);
    if (label) socket.on(event, () => console.log(`  [${label}] received '${event}'`));
  });
}

async function findOrCreateBoard(token, creator) {
  // Pick the first board this creator can see; if none, create one.
  const j = await api('GET', '/api/boards', null, token);
  const boards = (j.data && j.data.boards) || j.boards || j.data || [];
  if (Array.isArray(boards) && boards.length) {
    return boards[0];
  }
  const created = await api('POST', '/api/boards', { name: 'Realtime Test Board', color: '#10b981' }, token);
  return (created.data && (created.data.board || created.data)) || created.board;
}

(async () => {
  console.log('▶ Realtime Phase 1 verification\n');

  // ── 1. Log in both users ───────────────────────────────────
  console.log('1. Logging in both users…');
  const creator = await login('admin@aniston.com', 'Admin@1234');
  const assignee = await login('realtime-test@aniston.local', 'Test@1234');
  console.log(`   creator:  ${creator.user.name} (${creator.user.role})`);
  console.log(`   assignee: ${assignee.user.name} (${assignee.user.role})\n`);

  // ── 2. Pick a board ────────────────────────────────────────
  const board = await findOrCreateBoard(creator.token, creator.user);
  console.log(`2. Using board: "${board.name}" (${board.id})\n`);

  // ── 3. Connect assignee's socket — IMPORTANT: do NOT join the
  //      board room. This is exactly the screenshot scenario:
  //      Sunny is on HomePage / MyWork / a different board.
  console.log('3. Assignee connects socket (NOT joining board room)…');
  const assigneeSocket = await connectSocket(assignee.token, 'assignee');

  // Also connect a second socket for the assignee that DOES join the
  // board room — to verify the dedupe (no double-fire on tabs that have
  // the board open).
  console.log('   assignee opens a second tab and DOES join the board room…');
  const assigneeBoardSocket = await connectSocket(assignee.token, 'assignee-board');
  assigneeBoardSocket.emit('board:join', { boardId: board.id });
  await new Promise((r) => setTimeout(r, 200)); // let the join settle

  // ── 4. Arm event listeners on assignee's sockets ───────────
  console.log('\n4. Arming task:created listeners on both assignee tabs…');
  // Use a counter, not waitForEvent, so we can detect duplicates.
  let countNoBoardRoom = 0;
  let countWithBoardRoom = 0;
  assigneeSocket.on('task:created', (data) => {
    countNoBoardRoom += 1;
    console.log(`   [assignee no-board-room] task:created  taskId=${data?.task?.id}  title="${data?.task?.title}"  count=${countNoBoardRoom}`);
  });
  assigneeBoardSocket.on('task:created', (data) => {
    countWithBoardRoom += 1;
    console.log(`   [assignee with-board-room] task:created  taskId=${data?.task?.id}  count=${countWithBoardRoom}`);
  });

  // ── 5. Creator creates a task assigned to the assignee ─────
  console.log('\n5. Creator creates a task assigned to assignee…');
  const dueDate = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const created = await api(
    'POST',
    '/api/tasks',
    {
      title: `JOKER-test-${Date.now()}`,
      description: 'Realtime fanout verification',
      priority: 'medium',
      status: 'not_started',
      dueDate,
      boardId: board.id,
      assignedTo: [assignee.user.id], // POST /api/tasks expects `assignedTo` (string or array)
    },
    creator.token,
  );
  const newTask = (created.data && created.data.task) || created.task;
  console.log(`   created task: ${newTask.id}  title="${newTask.title}"\n`);

  // ── 6. Wait briefly for the events to arrive ───────────────
  await new Promise((r) => setTimeout(r, 1500));

  // ── 7. Report ──────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('RESULTS:');
  console.log(`  Assignee tab WITHOUT board:join : task:created received ${countNoBoardRoom}× ${countNoBoardRoom === 1 ? '✓ PASS' : (countNoBoardRoom === 0 ? '✗ FAIL (this was the bug)' : '✗ FAIL (duplicate)')}`);
  console.log(`  Assignee tab WITH    board:join : task:created received ${countWithBoardRoom}× ${countWithBoardRoom === 1 ? '✓ PASS (deduped)' : '✗ FAIL'}`);
  console.log('══════════════════════════════════════════════════════');

  let exitCode = 0;
  if (countNoBoardRoom !== 1) exitCode = 1;
  if (countWithBoardRoom !== 1) exitCode = 1;

  // ── 8. Cleanup: mark archived via update so the test board doesn't
  //      fill up with detritus on repeated runs.
  try {
    await api('PUT', `/api/tasks/${newTask.id}`, { isArchived: true }, creator.token);
    console.log('\n  cleanup: archived test task');
  } catch (e) {
    console.warn('\n  cleanup: archive failed (non-fatal):', e.message);
  }

  assigneeSocket.close();
  assigneeBoardSocket.close();
  process.exit(exitCode);
})().catch((err) => {
  console.error('\n✗ Test errored:', err.message);
  process.exit(2);
});
