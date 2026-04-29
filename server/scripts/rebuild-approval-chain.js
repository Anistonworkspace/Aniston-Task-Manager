/**
 * Rebuild a task's approval chain from the current org chart.
 *
 * USE CASE: a task was submitted before the chain-derivation bug fix and now
 * has incorrect approval rows (e.g. skipped a direct manager and went straight
 * to Super Admin). This script reconstructs the chain using the current
 * managerId / manager_relations data WITHOUT destroying the original audit
 * history — old rows are kept in the JSONB `approvalChain` mirror.
 *
 * Run:
 *   node server/scripts/rebuild-approval-chain.js <taskId>
 *   node server/scripts/rebuild-approval-chain.js <taskId> --apply   # actually write
 *
 * Without --apply, this is a dry run that prints what *would* change.
 *
 * Safety:
 *   - Refuses to rebuild a task whose approvalStatus is `approved` (terminal
 *     state — preserves the audit). Pass --force to override (admin only).
 *   - Dry-run by default. Must be re-invoked with --apply to mutate.
 *   - Wraps the actual mutation in a transaction.
 *   - Mirrors the deleted rows into approvalChain JSONB with a
 *     `action: 'rebuilt'` marker so the audit record survives.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize, Task, TaskApprovalFlow, User } = require('../models');
const { deriveApprovalChain } = require('../services/approvalChainService');

const args = process.argv.slice(2);
const taskId = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
const force = args.includes('--force');

if (!taskId) {
  console.error('Usage: node server/scripts/rebuild-approval-chain.js <taskId> [--apply] [--force]');
  process.exit(1);
}

(async () => {
  try {
    await sequelize.authenticate();

    const task = await Task.findByPk(taskId);
    if (!task) {
      console.error(`Task ${taskId} not found.`);
      process.exit(1);
    }

    console.log(`Task: "${task.title}" (status=${task.status}, approvalStatus=${task.approvalStatus})`);
    console.log(`Submitter (assignedTo or createdBy): ${task.assignedTo || task.createdBy}`);

    if (task.approvalStatus === 'approved' && !force) {
      console.error('Refusing to rebuild a fully-approved task. Pass --force to override.');
      process.exit(1);
    }

    // Existing chain
    const existing = await TaskApprovalFlow.findAll({
      where: { taskId },
      order: [['level', 'ASC']],
      raw: true,
    });
    console.log(`\nExisting chain (${existing.length} rows):`);
    for (const r of existing) {
      console.log(`  L${r.level} ${r.userName || '(unknown)'} :: ${r.status}`);
    }

    // Determine the original submitter from the level-0 row, or fall back to
    // task.assignedTo / task.createdBy.
    const submitterId = existing.find((r) => r.level === 0)?.userId
      || task.assignedTo
      || task.createdBy;
    if (!submitterId) {
      console.error('Cannot determine submitter — task has no assignee/creator/L0 row.');
      process.exit(1);
    }
    const submitter = await User.findByPk(submitterId, { attributes: ['id', 'name'] });

    // Derive what the chain SHOULD be from the current org chart
    const { chain: newChain, warnings, autoApprove } = await deriveApprovalChain(submitterId);
    console.log(`\nDerived chain for ${submitter?.name || submitterId} (autoApprove=${autoApprove}):`);
    for (const r of newChain) {
      console.log(`  L${r.level} ${r.userName} (${r.role})${r.isSubmitter ? ' [submitter]' : ''}`);
    }
    if (warnings.length > 0) {
      console.log('Warnings:');
      for (const w of warnings) console.log(`  - ${w}`);
    }

    if (!apply) {
      console.log('\nDRY RUN. Re-run with --apply to write changes.');
      process.exit(0);
    }

    // Apply: mirror old chain into JSONB audit, replace rows.
    const t = await sequelize.transaction();
    try {
      const lockedTask = await Task.findByPk(taskId, { transaction: t, lock: t.LOCK.UPDATE });
      const auditPrev = Array.isArray(lockedTask.approvalChain) ? lockedTask.approvalChain : [];
      const rebuildAudit = [
        ...auditPrev,
        {
          userId: null,
          userName: '(system)',
          action: 'rebuilt',
          comment: `Chain rebuilt from current org chart. Replaced ${existing.length} row(s) with ${newChain.length - 1} approver(s).`,
          timestamp: new Date().toISOString(),
        },
      ];

      // Wipe and re-insert
      await TaskApprovalFlow.destroy({ where: { taskId }, transaction: t });
      const now = new Date();
      const rows = newChain.map((row) => ({
        taskId,
        userId: row.userId,
        userName: row.userName,
        role: row.role,
        level: row.level,
        status: row.isSubmitter ? 'submitted' : 'pending',
        comment: row.isSubmitter ? '(rebuilt — original submission preserved in JSONB audit)' : null,
        actionAt: row.isSubmitter ? now : null,
      }));
      await TaskApprovalFlow.bulkCreate(rows, { transaction: t });

      // Determine new approvalStatus. If autoApprove, mark everything approved
      // and set task.status='done' to match the controller's behavior. Otherwise
      // status returns to pending_approval (unchanged in most cases).
      const updates = { approvalChain: rebuildAudit };
      if (autoApprove) {
        await TaskApprovalFlow.update(
          { status: 'approved', actionAt: now, comment: 'Auto-approved (no senior reviewer)' },
          { where: { taskId, level: { [require('sequelize').Op.gt]: 0 } }, transaction: t }
        );
        updates.approvalStatus = 'approved';
        updates.status = 'done';
      } else {
        updates.approvalStatus = 'pending_approval';
      }
      await lockedTask.update(updates, { transaction: t });

      await t.commit();
      console.log(`\nRebuild complete. New approvalStatus: ${updates.approvalStatus}`);
    } catch (err) {
      if (!t.finished) await t.rollback();
      throw err;
    }

    process.exit(0);
  } catch (err) {
    console.error('Rebuild failed:', err.message);
    process.exit(1);
  }
})();
