// Phase 4 verification — confirms the notification service routes the right
// in-app notification *type* to the right recipient for each approval event.
// Web push and Teams channels are best-effort and not asserted here (they
// short-circuit cleanly if not configured).
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Op } = require('sequelize');
const { Task, Board, TaskApprovalFlow, User, Notification } = require('../models');
const ctrl = require('../controllers/approvalController');

const MONIKA   = '754fc387-1bc6-4c49-8ebd-b5a6645b16e7';
const SHIKHA   = '90570fec-4f4e-47aa-9481-6974782591b4';
const NANDEESH = 'b0eca409-97b9-4848-af26-b90c3f2a0f7e';

function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (b) => { r._body = b; return r; };
  return r;
}

async function loadUser(id) {
  return User.findByPk(id, { attributes: ['id', 'name', 'role'] });
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); failures++; return; }
  console.log('  OK  ', msg);
}

// Async fire-and-forget notifications need a small settle window.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notifsFor(userId, taskId, sinceIso) {
  return Notification.findAll({
    where: {
      userId,
      entityType: 'task',
      entityId: taskId,
      createdAt: { [Op.gte]: new Date(sinceIso) },
    },
    order: [['createdAt', 'ASC']],
    raw: true,
  });
}

(async () => {
  const board = await Board.create({
    name: '__APPROVAL_NOTIF_TEST__',
    color: '#000000',
    createdBy: MONIKA,
    columns: [],
    groups: [{ id: 'new', title: 'New', color: '#888' }],
  });
  const task = await Task.create({
    title: 'Notif test task',
    boardId: board.id,
    groupId: 'new',
    status: 'working_on_it',
    priority: 'medium',
    createdBy: MONIKA,
    assignedTo: MONIKA,
    approvalChain: [],
  });
  console.log(`Created task ${task.id}\n`);

  try {
    const monika = await loadUser(MONIKA);
    const shikha = await loadUser(SHIKHA);
    const nandeesh = await loadUser(NANDEESH);

    // ───────── EVENT 1: submit ─────────
    let cutoff = new Date().toISOString();
    console.log('EVENT 1: submit (monika) — expect shikha receives approval_submitted');
    let res = mockRes();
    await ctrl.submitForApproval(
      { params: { id: task.id }, body: { comment: 'review please' }, user: monika },
      res
    );
    assert(res._status === 200, 'submit ok');
    await sleep(300);
    let shikhaNotifs = await notifsFor(SHIKHA, task.id, cutoff);
    assert(shikhaNotifs.some((n) => n.type === 'approval_submitted'), 'shikha got approval_submitted notif');
    let monikaNotifs = await notifsFor(MONIKA, task.id, cutoff);
    assert(monikaNotifs.length === 0, 'submitter (monika) NOT notified about her own submit');

    // ───────── EVENT 2: shikha approves -> nandeesh notified ─────────
    cutoff = new Date().toISOString();
    console.log('\nEVENT 2: shikha approves — expect nandeesh receives approval_approved');
    res = mockRes();
    await ctrl.approveTask(
      { params: { id: task.id }, body: { comment: 'looks good' }, user: shikha },
      res
    );
    assert(res._status === 200, 'L1 approve ok');
    await sleep(300);
    let nandNotifs = await notifsFor(NANDEESH, task.id, cutoff);
    assert(nandNotifs.some((n) => n.type === 'approval_approved'), 'nandeesh got approval_approved notif');

    // ───────── EVENT 3: nandeesh rejects -> shikha notified ─────────
    cutoff = new Date().toISOString();
    console.log('\nEVENT 3: nandeesh rejects — expect shikha receives approval_rejected');
    res = mockRes();
    await ctrl.rejectTask(
      { params: { id: task.id }, body: { comment: 'reconsider' }, user: nandeesh },
      res
    );
    assert(res._status === 200, 'reject ok');
    await sleep(300);
    shikhaNotifs = await notifsFor(SHIKHA, task.id, cutoff);
    assert(shikhaNotifs.some((n) => n.type === 'approval_rejected'), 'shikha (prev approver) got approval_rejected');
    monikaNotifs = await notifsFor(MONIKA, task.id, cutoff);
    assert(!monikaNotifs.some((n) => n.type === 'approval_rejected'), 'submitter NOT notified (rejection bounced one level only, not back to submitter)');

    // ───────── EVENT 4: changes_requested by shikha -> monika notified ─────────
    cutoff = new Date().toISOString();
    console.log('\nEVENT 4: shikha requests changes — expect monika (submitter) receives approval_changes_requested');
    res = mockRes();
    await ctrl.requestChanges(
      { params: { id: task.id }, body: { comment: 'add detail' }, user: shikha },
      res
    );
    assert(res._status === 200, 'changes_requested ok');
    await sleep(300);
    monikaNotifs = await notifsFor(MONIKA, task.id, cutoff);
    assert(monikaNotifs.some((n) => n.type === 'approval_changes_requested'), 'submitter got approval_changes_requested');

    // ───────── EVENT 5: full happy path -> submitter gets approval_completed ─────────
    cutoff = new Date().toISOString();
    console.log('\nEVENT 5: walk extended chain to completion — expect submitter gets approval_completed');
    await TaskApprovalFlow.destroy({ where: { taskId: task.id } });
    await Task.update({ approvalStatus: null, approvalChain: [], status: 'working_on_it' }, { where: { id: task.id } });
    await ctrl.submitForApproval({ params: { id: task.id }, body: { comment: 'go' }, user: monika }, mockRes());
    // Chain extends to admin -> super admin now. Walk every pending row in
    // sequence rather than hardcoding shikha/nandeesh — chain depth varies by user.
    while (true) {
      const pending = await TaskApprovalFlow.findOne({
        where: { taskId: task.id, status: 'pending' },
        order: [['level', 'ASC']],
        raw: true,
      });
      if (!pending) break;
      const approver = await User.findByPk(pending.userId, { attributes: ['id', 'name', 'role'] });
      await ctrl.approveTask({ params: { id: task.id }, body: {}, user: approver }, mockRes());
    }
    await sleep(500);
    monikaNotifs = await notifsFor(MONIKA, task.id, cutoff);
    assert(monikaNotifs.some((n) => n.type === 'approval_completed'), 'submitter got approval_completed on final approval');

    if (failures === 0) {
      console.log('\n========== ALL NOTIFICATION TESTS PASSED ==========');
    } else {
      console.log(`\n========== ${failures} FAILURE(S) ==========`);
    }
  } finally {
    // cleanup notifications + task
    await Notification.destroy({ where: { entityType: 'task', entityId: task.id } });
    await TaskApprovalFlow.destroy({ where: { taskId: task.id } });
    await Task.destroy({ where: { id: task.id }, force: true });
    await Board.destroy({ where: { id: board.id }, force: true });
    console.log('Cleanup complete.');
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('CRASH:', e); process.exit(1); });
