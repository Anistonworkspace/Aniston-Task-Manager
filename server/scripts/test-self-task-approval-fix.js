// Focused regression test for the self-task approval bypass fix.
//
// What this proves:
//   1. submitForApproval on a self-assigned task NO LONGER returns approvalSkipped=true.
//      It now creates real chain rows and sets approvalStatus='pending_approval'
//      (or 'approved' if autoApprove fired due to no senior reviewer).
//   2. updateTask cannot transition status to 'done' for a non-super-admin owner
//      whose task hasn't been approved — the gate returns 403 approval_required.
//   3. updateTask cannot push progress to 100 for the same case — same gate.
//   4. Super Admin can still set status='done' directly with no gate.
//   5. After a chain reaches approvalStatus='approved' (simulated), updateTask
//      allows status='done' transitions normally.
//
// Throwaway script — cleans up after itself. Run from server/ via:
//   node scripts/test-self-task-approval-fix.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize, Task, Board, TaskApprovalFlow, User, TaskAssignee } = require('../models');
const approvalCtrl = require('../controllers/approvalController');
const taskCtrl = require('../controllers/taskController');

function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (b) => { r._body = b; return r; };
  return r;
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  FAIL:', msg); failures++; return; }
  console.log('  OK  ', msg);
}

async function loadUser(filter) {
  return User.findOne({ where: filter, attributes: ['id', 'name', 'role', 'isSuperAdmin', 'isActive', 'managerId'] });
}

(async () => {
  // Pick test users. Need a member with a manager above them and a super admin.
  const member = await loadUser({ role: 'member', isActive: true });
  const superAdmin = await loadUser({ isSuperAdmin: true, isActive: true });
  if (!member) { console.error('No active member user found — seed test users first.'); process.exit(1); }
  if (!superAdmin) { console.error('No active super admin user found — seed test users first.'); process.exit(1); }
  console.log(`Using member=${member.name} (${member.id}), superAdmin=${superAdmin.name} (${superAdmin.id})\n`);

  // Throwaway board owned by the member.
  const board = await Board.create({
    name: '__SELF_TASK_FIX_TEST__',
    color: '#000000',
    createdBy: member.id,
    columns: [],
    groups: [{ id: 'new', title: 'New', color: '#888' }],
  });

  // Self-assigned task: created by member, assignedTo=self, no other assignees.
  const selfTask = await Task.create({
    title: 'self-task fix verification',
    boardId: board.id,
    groupId: 'new',
    status: 'working_on_it',
    progress: 50,
    priority: 'medium',
    createdBy: member.id,
    assignedTo: member.id,
    approvalChain: [],
  });

  let res;
  try {
    console.log('TEST A: submitForApproval on a self-task no longer short-circuits');
    res = mockRes();
    await approvalCtrl.submitForApproval(
      { params: { id: selfTask.id }, body: { comment: 'self submit' }, user: member },
      res
    );
    assert(res._status === 200, `submit returns 200 (got ${res._status})`);
    assert(res._body?.approvalSkipped !== true, 'response no longer carries approvalSkipped=true');
    const rows = await TaskApprovalFlow.findAll({ where: { taskId: selfTask.id }, raw: true });
    assert(rows.length > 0, `chain rows created (got ${rows.length})`);
    const t = await Task.findByPk(selfTask.id);
    assert(
      t.approvalStatus === 'pending_approval' || t.approvalStatus === 'approved',
      `approvalStatus is pending_approval or approved (got ${t.approvalStatus})`
    );

    console.log('\nTEST B: updateTask blocks non-super-admin owner from status=done while pending/null');
    // Reset to a clean state — no chain, status=working.
    await TaskApprovalFlow.destroy({ where: { taskId: selfTask.id } });
    await Task.update({ approvalStatus: null, approvalChain: [], status: 'working_on_it', progress: 50 }, { where: { id: selfTask.id } });
    res = mockRes();
    await taskCtrl.updateTask(
      {
        params: { id: selfTask.id },
        body: { status: 'done' },
        user: member,
        query: {},
      },
      res
    );
    assert(res._status === 403, `non-super-admin status=done -> 403 (got ${res._status})`);
    assert(res._body?.code === 'approval_required', `error code is approval_required (got ${res._body?.code})`);
    const tAfter = await Task.findByPk(selfTask.id);
    assert(tAfter.status === 'working_on_it', `status NOT changed (got ${tAfter.status})`);

    console.log('\nTEST C: updateTask blocks non-super-admin owner from progress=100 alone');
    res = mockRes();
    await taskCtrl.updateTask(
      {
        params: { id: selfTask.id },
        body: { progress: 100 },
        user: member,
        query: {},
      },
      res
    );
    assert(res._status === 403, `non-super-admin progress=100 -> 403 (got ${res._status})`);
    assert(res._body?.code === 'approval_required', `error code is approval_required (got ${res._body?.code})`);
    const tAfter2 = await Task.findByPk(selfTask.id);
    assert(tAfter2.progress !== 100, `progress NOT changed to 100 (got ${tAfter2.progress})`);

    console.log('\nTEST D: super admin can set status=done directly (no approval needed)');
    res = mockRes();
    await taskCtrl.updateTask(
      {
        params: { id: selfTask.id },
        body: { status: 'done' },
        user: superAdmin,
        query: {},
      },
      res
    );
    assert(res._status === 200, `super-admin status=done -> 200 (got ${res._status})`);
    const tDone = await Task.findByPk(selfTask.id);
    assert(tDone.status === 'done', `status set to done (got ${tDone.status})`);

    console.log('\nTEST E: after approvalStatus=approved, member can finalize done');
    // Reset and pretend the chain already approved.
    await Task.update({ status: 'working_on_it', progress: 50, approvalStatus: 'approved' }, { where: { id: selfTask.id } });
    res = mockRes();
    await taskCtrl.updateTask(
      {
        params: { id: selfTask.id },
        body: { status: 'done' },
        user: member,
        query: {},
      },
      res
    );
    assert(res._status === 200, `approved task status=done -> 200 (got ${res._status})`);

    console.log('\nTEST F: createTask blocks non-super-admin from creating a task in done state');
    res = mockRes();
    await taskCtrl.createTask(
      {
        body: {
          title: 'trying to create as done',
          boardId: board.id,
          status: 'done',
          assignedTo: member.id,
        },
        user: member,
      },
      res
    );
    assert(res._status === 403, `member create status=done -> 403 (got ${res._status})`);
    assert(res._body?.code === 'approval_required', `error code is approval_required (got ${res._body?.code})`);

  } finally {
    // Cleanup
    await TaskApprovalFlow.destroy({ where: { taskId: selfTask.id } });
    await TaskAssignee.destroy({ where: { taskId: selfTask.id } });
    await Task.destroy({ where: { id: selfTask.id }, force: true });
    await Board.destroy({ where: { id: board.id }, force: true });
    console.log('\nCleanup complete.');
  }

  if (failures === 0) {
    console.log('\nALL TESTS PASSED');
    process.exit(0);
  } else {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
