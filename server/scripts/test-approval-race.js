// Race-condition test: two clients hit /approve simultaneously for the same
// task. The PESSIMISTIC_WRITE lock on the task row should serialize them so
// exactly one wins (200) and the other sees a clean 409 / 403, never a half-
// committed state with double-approved rows.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Task, Board, TaskApprovalFlow, User } = require('../models');
const ctrl = require('../controllers/approvalController');

const MONIKA = '754fc387-1bc6-4c49-8ebd-b5a6645b16e7';
const SHIKHA = '90570fec-4f4e-47aa-9481-6974782591b4';

function mockRes() {
  const r = { _status: 200, _body: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (b) => { r._body = b; return r; };
  return r;
}

(async () => {
  const board = await Board.create({
    name: '__APPROVAL_RACE_TEST__',
    color: '#000000',
    createdBy: MONIKA,
    columns: [],
    groups: [{ id: 'new', title: 'New', color: '#888' }],
  });
  const task = await Task.create({
    title: 'race test',
    boardId: board.id,
    groupId: 'new',
    status: 'working_on_it',
    priority: 'medium',
    createdBy: MONIKA,
    assignedTo: MONIKA,
    approvalChain: [],
  });

  let failures = 0;
  try {
    const monika = await User.findByPk(MONIKA, { attributes: ['id', 'name', 'role'] });
    const shikha = await User.findByPk(SHIKHA, { attributes: ['id', 'name', 'role'] });

    // Submit so a chain exists.
    await ctrl.submitForApproval(
      { params: { id: task.id }, body: { comment: 'race start' }, user: monika },
      mockRes()
    );

    // Fire two approve calls concurrently as the same user (simulates a double-
    // click submitting both before the first commits).
    const r1 = mockRes();
    const r2 = mockRes();
    const [_a, _b] = await Promise.all([
      ctrl.approveTask({ params: { id: task.id }, body: { comment: 'click 1' }, user: shikha }, r1),
      ctrl.approveTask({ params: { id: task.id }, body: { comment: 'click 2' }, user: shikha }, r2),
    ]);

    const statuses = [r1._status, r2._status].sort();
    console.log(`Concurrent approve statuses: ${statuses.join(', ')}`);

    // Exactly one should succeed (200). The other should fail (403 — chain has
    // advanced and shikha is no longer the current approver) or 409 (no pending
    // step / not pending state). Either is acceptable; what matters is that
    // exactly one succeeded.
    const successes = [r1, r2].filter(r => r._status === 200).length;
    const failsOk = [r1, r2].filter(r => r._status === 403 || r._status === 409).length;

    if (successes === 1 && failsOk === 1) {
      console.log('OK   exactly one approve succeeded, the other was rejected cleanly');
    } else {
      console.error(`FAIL: expected 1 success + 1 reject, got ${successes} success / ${failsOk} reject`);
      failures++;
    }

    // Sanity check: only ONE level-1 row marked approved.
    const l1Rows = await TaskApprovalFlow.count({
      where: { taskId: task.id, level: 1, status: 'approved' },
    });
    if (l1Rows === 1) {
      console.log('OK   exactly one L1 row marked approved');
    } else {
      console.error(`FAIL: expected 1 L1 approved, got ${l1Rows}`);
      failures++;
    }

    if (failures === 0) {
      console.log('\n========== RACE TEST PASSED ==========');
    } else {
      console.log(`\n========== ${failures} FAILURE(S) ==========`);
    }
  } finally {
    await TaskApprovalFlow.destroy({ where: { taskId: task.id } });
    await Task.destroy({ where: { id: task.id }, force: true });
    await Board.destroy({ where: { id: board.id }, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
