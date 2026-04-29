// Phase 3 integration test — exercises the full approval lifecycle against a
// real DB row. Cleans up everything it creates. Throwaway script (run once,
// keep around for regression).
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize, Task, Board, TaskApprovalFlow, User } = require('../models');
const ctrl = require('../controllers/approvalController');

// Seeded test users (real UUIDs from this DB).
const MONIKA   = '754fc387-1bc6-4c49-8ebd-b5a6645b16e7'; // member, manager = shikha
const SHIKHA   = '90570fec-4f4e-47aa-9481-6974782591b4'; // member, manager = nandeesh
const NANDEESH = 'b0eca409-97b9-4848-af26-b90c3f2a0f7e'; // top of chain (no manager)

function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (b) => { r._body = b; return r; };
  return r;
}

async function loadUser(id) {
  return User.findByPk(id, { attributes: ['id', 'name', 'role'] });
}

async function dumpFlows(taskId, label) {
  const rows = await TaskApprovalFlow.findAll({
    where: { taskId },
    order: [['level', 'ASC']],
    raw: true,
  });
  console.log(`  [${label}]`, rows.map(r => `L${r.level}=${(r.userName||'').trim()}:${r.status}`).join(' | '));
  return rows;
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); failures++; return; }
  console.log('  OK  ', msg);
}

(async () => {
  const board = await Board.create({
    name: '__APPROVAL_TEST__',
    color: '#000000',
    createdBy: MONIKA,
    columns: [],
    groups: [{ id: 'new', title: 'New', color: '#888' }],
  });
  const task = await Task.create({
    title: 'Approval flow test task',
    boardId: board.id,
    groupId: 'new',
    status: 'working_on_it',
    priority: 'medium',
    createdBy: MONIKA,
    assignedTo: MONIKA,
    approvalChain: [],
  });
  console.log(`Created test task ${task.id} on board ${board.id}\n`);

  try {
    console.log('TEST 1: submitForApproval as monika');
    const monika = await loadUser(MONIKA);
    let res = mockRes();
    await ctrl.submitForApproval(
      { params: { id: task.id }, body: { comment: 'Done please review' }, user: monika },
      res
    );
    assert(res._status === 200, `submit returns 200 (got ${res._status})`);
    let rows = await dumpFlows(task.id, 'after submit');
    // Chain now extends to admin -> super admin per spec: "approval chain
    // includes ALL levels above submitter". For monika that's:
    //   L0 monika, L1 shikha, L2 nandeesh, L3 admin, L4 super admin = 5 rows.
    assert(rows.length === 5, `5 chain rows (submitter + org chain + admin + super admin), got ${rows.length}`);
    assert(rows[0].level === 0 && rows[0].status === 'submitted', 'L0 submitter row');
    assert(rows[1].level === 1 && rows[1].status === 'pending' && rows[1].userId === SHIKHA, 'L1 pending = shikha');
    assert(rows[2].level === 2 && rows[2].status === 'pending' && rows[2].userId === NANDEESH, 'L2 pending = nandeesh');
    assert(rows[3].level === 3 && rows[3].status === 'pending' && rows[3].role === 'admin', 'L3 pending = admin tail');
    assert(rows[4].level === 4 && rows[4].status === 'pending' && rows[4].userId !== rows[3].userId, 'L4 pending = super admin tail');
    let t2 = await Task.findByPk(task.id);
    assert(t2.approvalStatus === 'pending_approval', 'task.approvalStatus = pending_approval');
    assert(t2.status === 'working_on_it', 'task.status unchanged (no DONE replacement)');
    assert(t2.approvalChain.length === 1, 'JSONB mirror has 1 audit entry');

    console.log('\nTEST 2: idempotency — second submit during pending returns 409');
    res = mockRes();
    await ctrl.submitForApproval(
      { params: { id: task.id }, body: { comment: 'duplicate' }, user: monika },
      res
    );
    assert(res._status === 409, `duplicate submit -> 409 (got ${res._status})`);

    console.log('\nTEST 3: wrong approver rejected (monika tries to approve own task)');
    res = mockRes();
    await ctrl.approveTask(
      { params: { id: task.id }, body: {}, user: monika },
      res
    );
    assert(res._status === 403, `wrong approver -> 403 (got ${res._status})`);

    console.log('\nTEST 4: out-of-order REJECT still 403 (reject is current-approver-only)');
    const nandeesh = await loadUser(NANDEESH);
    res = mockRes();
    await ctrl.rejectTask(
      { params: { id: task.id }, body: { comment: 'cannot reject from above' }, user: nandeesh },
      res
    );
    assert(res._status === 403, `out-of-order reject -> 403 (got ${res._status})`);

    console.log('\nTEST 5: approve at level 1 (shikha) — normal sequential flow');
    const shikha = await loadUser(SHIKHA);
    res = mockRes();
    await ctrl.approveTask(
      { params: { id: task.id }, body: { comment: 'Looks good' }, user: shikha },
      res
    );
    assert(res._status === 200, `approve returns 200 (got ${res._status})`);
    rows = await dumpFlows(task.id, 'after L1 approve');
    assert(rows[1].status === 'approved', 'L1 = approved');
    assert(rows[2].status === 'pending', 'L2 still pending — chain advanced');
    t2 = await Task.findByPk(task.id);
    assert(t2.approvalStatus === 'pending_approval', 'task still pending_approval');

    console.log('\nTEST 6: reject at level 2 (nandeesh, now current) — should reset L1 to pending');
    res = mockRes();
    await ctrl.rejectTask(
      { params: { id: task.id }, body: { comment: 'Reconsider' }, user: nandeesh },
      res
    );
    assert(res._status === 200, `reject returns 200 (got ${res._status})`);
    rows = await dumpFlows(task.id, 'after L2 reject');
    assert(rows[1].status === 'pending', 'L1 reset to pending');
    assert(rows[2].status === 'rejected', 'L2 = rejected');
    t2 = await Task.findByPk(task.id);
    assert(t2.approvalStatus === 'pending_approval', 'task still pending');

    console.log('\nTEST 7: reject without comment returns 400');
    res = mockRes();
    await ctrl.rejectTask(
      { params: { id: task.id }, body: {}, user: shikha },
      res
    );
    assert(res._status === 400, `missing comment -> 400 (got ${res._status})`);

    console.log('\nTEST 8: changes_requested — task ends cycle and bounces to submitter');
    await TaskApprovalFlow.destroy({ where: { taskId: task.id } });
    await Task.update({ approvalStatus: null, approvalChain: [], status: 'working_on_it' }, { where: { id: task.id } });
    res = mockRes();
    await ctrl.submitForApproval(
      { params: { id: task.id }, body: { comment: 'Try again' }, user: monika },
      res
    );
    assert(res._status === 200, 'fresh submit OK');
    res = mockRes();
    await ctrl.requestChanges(
      { params: { id: task.id }, body: { comment: 'Need more detail' }, user: shikha },
      res
    );
    assert(res._status === 200, 'request-changes 200');
    t2 = await Task.findByPk(task.id);
    assert(t2.approvalStatus === 'changes_requested', 'task.approvalStatus = changes_requested');
    rows = await dumpFlows(task.id, 'after changes_requested');
    assert(rows[1].status === 'changes_requested', 'L1 row marked changes_requested');

    console.log('\nTEST 9: full happy path — sequential approvals through extended chain to DONE');
    await TaskApprovalFlow.destroy({ where: { taskId: task.id } });
    await Task.update({ approvalStatus: null, approvalChain: [], status: 'working_on_it' }, { where: { id: task.id } });
    res = mockRes();
    await ctrl.submitForApproval({ params: { id: task.id }, body: { comment: 'go' }, user: monika }, res);
    assert(res._status === 200, 'submit OK');
    // Walk the extended chain by approving sequentially. Pull each pending
    // approver from DB rather than hardcoding (chain is now 4 approvers deep).
    for (let step = 1; step <= 4; step++) {
      const pending = await TaskApprovalFlow.findOne({
        where: { taskId: task.id, status: 'pending' },
        order: [['level', 'ASC']],
        raw: true,
      });
      const approver = await User.findByPk(pending.userId, { attributes: ['id', 'name', 'role'] });
      res = mockRes();
      await ctrl.approveTask({ params: { id: task.id }, body: {}, user: approver }, res);
      assert(res._status === 200, `step ${step}: ${approver.name} approve OK`);
    }
    t2 = await Task.findByPk(task.id);
    rows = await dumpFlows(task.id, 'after final approve');
    assert(t2.approvalStatus === 'approved', `final approvalStatus = approved (got ${t2.approvalStatus})`);
    assert(t2.status === 'done', `task.status = done (got ${t2.status})`);
    assert(rows.every((r, i) => i === 0 ? r.status === 'submitted' : r.status === 'approved'), 'all approver rows marked approved');

    console.log('\nTEST 10: post-completion approve attempt returns 409');
    res = mockRes();
    await ctrl.approveTask({ params: { id: task.id }, body: {}, user: nandeesh }, res);
    assert(res._status === 409, `re-approve completed task -> 409 (got ${res._status})`);

    console.log('\nTEST 11: getApprovalChain returns ordered flows');
    res = mockRes();
    await ctrl.getApprovalChain({ params: { id: task.id }, user: monika }, res);
    assert(res._status === 200, 'getApprovalChain returns 200');
    // Chain is now extended (org chain + admin + super admin tail).
    assert(res._body.data.flows.length === 5, `chain has 5 levels (got ${res._body.data.flows.length})`);
    assert(res._body.data.flows[0].level === 0, 'ordered by level');

    console.log('\nTEST 12: getPendingApprovals — fresh chain, shikha sees task');
    await TaskApprovalFlow.destroy({ where: { taskId: task.id } });
    await Task.update({ approvalStatus: null, approvalChain: [], status: 'working_on_it' }, { where: { id: task.id } });
    res = mockRes();
    await ctrl.submitForApproval({ params: { id: task.id }, body: { comment: 'go' }, user: monika }, res);
    res = mockRes();
    await ctrl.getPendingApprovals({ user: shikha }, res);
    assert(res._status === 200, 'getPendingApprovals 200');
    const pendingForShikha = res._body.data.tasks.find(t => t.id === task.id);
    assert(!!pendingForShikha, 'shikha sees the task in her pending queue');
    res = mockRes();
    await ctrl.getPendingApprovals({ user: nandeesh }, res);
    const pendingForNandeesh = res._body.data.tasks.find(t => t.id === task.id);
    assert(!pendingForNandeesh, 'nandeesh does NOT see the task (not her turn yet)');

    console.log('\nTEST 13: early completion — higher-level approver signs off, lower pending levels auto-approved');
    await TaskApprovalFlow.destroy({ where: { taskId: task.id } });
    await Task.update({ approvalStatus: null, approvalChain: [], status: 'working_on_it' }, { where: { id: task.id } });
    res = mockRes();
    await ctrl.submitForApproval({ params: { id: task.id }, body: { comment: 'early completion test' }, user: monika }, res);
    assert(res._status === 200, 'submit OK for early-completion test');

    // Chain is L0 monika -> L1 shikha -> L2 nandeesh -> L3 admin -> L4 super admin.
    // Have the L4 super admin approve out of turn. Expected: L1, L2, L3 get
    // auto-approved with system comment; L4 gets the actor's comment; task done.
    const l4Row = await TaskApprovalFlow.findOne({ where: { taskId: task.id, level: 4 }, raw: true });
    const superAdmin = await User.findByPk(l4Row.userId, { attributes: ['id', 'name', 'role'] });
    res = mockRes();
    await ctrl.approveTask(
      { params: { id: task.id }, body: { comment: 'Senior sign-off, work looks good' }, user: superAdmin },
      res
    );
    assert(res._status === 200, `early-completion approve returns 200 (got ${res._status})`);
    rows = await dumpFlows(task.id, 'after early completion');
    assert(rows.every((r) => r.status === 'submitted' || r.status === 'approved'), 'all rows are submitted/approved');
    const l4After = rows.find((r) => r.level === 4);
    const l1After = rows.find((r) => r.level === 1);
    assert(l4After.comment === 'Senior sign-off, work looks good', 'L4 row has actor comment');
    assert(/Auto-approved due to early completion/.test(l1After.comment || ''), 'L1 row got auto-approval comment');
    t2 = await Task.findByPk(task.id);
    assert(t2.approvalStatus === 'approved', 'task.approvalStatus = approved');
    assert(t2.status === 'done', 'task.status = done');

    console.log('\nTEST 14: early-completion 403 — submitter cannot approve own task');
    await TaskApprovalFlow.destroy({ where: { taskId: task.id } });
    await Task.update({ approvalStatus: null, approvalChain: [], status: 'working_on_it' }, { where: { id: task.id } });
    await ctrl.submitForApproval({ params: { id: task.id }, body: { comment: 'guard test' }, user: monika }, mockRes());
    res = mockRes();
    await ctrl.approveTask({ params: { id: task.id }, body: {}, user: monika }, res);
    assert(res._status === 403, `submitter approve -> 403 (got ${res._status})`);

    console.log('\nTEST 15: reject still requires being CURRENT approver, not just any-pending');
    // L4 super admin tries to REJECT while L1 is current — should be 403.
    res = mockRes();
    await ctrl.rejectTask(
      { params: { id: task.id }, body: { comment: 'try reject from above' }, user: superAdmin },
      res
    );
    assert(res._status === 403, `non-current reject -> 403 (got ${res._status})`);

    if (failures === 0) {
      console.log('\n========== ALL TESTS PASSED ==========');
    } else {
      console.log(`\n========== ${failures} FAILURE(S) ==========`);
      process.exitCode = 1;
    }
  } finally {
    await TaskApprovalFlow.destroy({ where: { taskId: task.id } });
    await Task.destroy({ where: { id: task.id }, force: true });
    await Board.destroy({ where: { id: board.id }, force: true });
    console.log('Cleanup complete.');
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
