/**
 * Idempotent production migration — adds the `stage` column and supporting index
 * to `task_approval_flows`. Required by the parallel-stage approval rework
 * (chain.row.stage groups parallel approvers — Manager/Admin/SuperAdmin at the
 * final tier — under one stage value while keeping unique levels).
 *
 * Why a separate script and not just re-running create-task-approval-flow.js?
 *   The original CREATE TABLE used `IF NOT EXISTS`, so on existing installs it
 *   no-ops — that's correct for the table itself but means new columns won't be
 *   picked up. This migration uses `ADD COLUMN IF NOT EXISTS` which is safe to
 *   re-run any number of times without effect once applied.
 *
 * Symptom this fixes:
 *   POST /api/task-extras/{id}/submit-approval returns 500 with toast
 *   "Failed to submit for approval". Backend log shows
 *   `column "stage" of relation "task_approval_flows" does not exist`.
 *
 * Run on production (after pulling latest backend code):
 *   node server/scripts/migrate-task-approval-flow-stage.js
 *
 * Safe to re-run. Does not destroy data. Does not lock the table for long
 * (ADD COLUMN with no DEFAULT is metadata-only on Postgres 11+).
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');

const STATEMENTS = [
  // 1. Add the stage column. Nullable, no default — backfill is implicit
  //    (legacy rows are read with COALESCE(stage, level) by the controller).
  `ALTER TABLE task_approval_flows ADD COLUMN IF NOT EXISTS stage INTEGER;`,
  // 2. Composite index used by findCurrentStageRows + getPendingApprovals.
  `CREATE INDEX IF NOT EXISTS task_approval_flows_task_stage_status_idx
     ON task_approval_flows ("taskId", stage, status);`,
];

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[migrate-stage] Connected to database.');

    // Sanity check: table must exist. If not, the user needs to run the
    // initial DDL first (create-task-approval-flow.js).
    const [tableRows] = await sequelize.query(
      `SELECT to_regclass('public.task_approval_flows') AS t;`
    );
    if (!tableRows[0]?.t) {
      console.error(
        '[migrate-stage] FAILED: task_approval_flows does not exist.\n' +
        '  Run server/scripts/create-task-approval-flow.js first.'
      );
      process.exit(1);
    }

    // Pre-state snapshot (so the operator sees what changed).
    const [colsBefore] = await sequelize.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'task_approval_flows' AND column_name = 'stage';`
    );
    const hadColumn = colsBefore.length > 0;
    console.log(`[migrate-stage] stage column present before: ${hadColumn ? 'YES' : 'NO'}`);

    for (const sql of STATEMENTS) {
      console.log(`[migrate-stage] running: ${sql.replace(/\s+/g, ' ').trim()}`);
      await sequelize.query(sql);
    }

    // Post-state verification.
    const [cols] = await sequelize.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'task_approval_flows' AND column_name = 'stage';`
    );
    if (cols.length !== 1) {
      throw new Error('stage column missing after ALTER — migration failed.');
    }
    console.log(`[migrate-stage] verified: stage column present (type=${cols[0].data_type}, nullable=${cols[0].is_nullable}).`);

    const [idx] = await sequelize.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'task_approval_flows'
          AND indexname = 'task_approval_flows_task_stage_status_idx';`
    );
    if (idx.length !== 1) {
      throw new Error('task_approval_flows_task_stage_status_idx missing after CREATE — migration failed.');
    }
    console.log('[migrate-stage] verified: composite index present.');

    if (!hadColumn) {
      console.log('[migrate-stage] Migration applied. Existing in-flight chain rows have stage=NULL — controller treats NULL as stage=level via COALESCE, so no backfill needed.');
    } else {
      console.log('[migrate-stage] No-op. Schema was already up to date.');
    }
    process.exit(0);
  } catch (err) {
    console.error('[migrate-stage] FAILED:', err.message);
    process.exit(1);
  }
})();
