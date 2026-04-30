/**
 * Phase 1 DDL — create the `task_approval_flows` table that backs the
 * normalized hierarchical task approval workflow.
 *
 * Why a manual script rather than sequelize.sync({alter:true})?
 *   Per CLAUDE.md: Sequelize's ALTER path generates invalid SQL when REFERENCES
 *   + SET DEFAULT NULL are combined, so all schema changes go through hand-rolled
 *   SQL (idempotent CREATE ... IF NOT EXISTS).
 *
 * Run:
 *   node server/scripts/create-task-approval-flow.js
 *   node server/scripts/create-task-approval-flow.js --drop   # tear down (dev only)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');

const drop = process.argv.includes('--drop');

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS task_approval_flows (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "taskId"       UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    "userId"       UUID REFERENCES users(id) ON DELETE SET NULL,
    "userName"     VARCHAR(255),
    role           VARCHAR(50),
    level          INTEGER NOT NULL,
    stage          INTEGER,
    status         VARCHAR(30) NOT NULL DEFAULT 'pending',
    comment        TEXT,
    "attachmentUrl" TEXT,
    "actionAt"     TIMESTAMP WITH TIME ZONE,
    "createdAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "updatedAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  );
`;

// For installs that pre-date the parallel-stage rework: ADD COLUMN IF NOT EXISTS
// is what actually upgrades them, since CREATE TABLE IF NOT EXISTS no-ops on an
// existing table. Safe to run repeatedly. Mirrored in migrate-task-approval-flow-stage.js.
const ADDITIVE_COLUMNS_SQL = [
  `ALTER TABLE task_approval_flows ADD COLUMN IF NOT EXISTS stage INTEGER;`,
];

// Indexes are wrapped in IF NOT EXISTS so the script is safely re-runnable.
const INDEX_SQL = [
  `CREATE UNIQUE INDEX IF NOT EXISTS task_approval_flows_task_level_unique
     ON task_approval_flows ("taskId", level);`,
  `CREATE INDEX IF NOT EXISTS task_approval_flows_task_status_idx
     ON task_approval_flows ("taskId", status);`,
  `CREATE INDEX IF NOT EXISTS task_approval_flows_user_status_idx
     ON task_approval_flows ("userId", status);`,
  `CREATE INDEX IF NOT EXISTS task_approval_flows_task_stage_status_idx
     ON task_approval_flows ("taskId", stage, status);`,
];

const DROP_SQL = `DROP TABLE IF EXISTS task_approval_flows CASCADE;`;

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[approval-flow-ddl] Connected to database.');

    if (drop) {
      console.log('[approval-flow-ddl] --drop requested, dropping table.');
      await sequelize.query(DROP_SQL);
      console.log('[approval-flow-ddl] Done. Table dropped.');
      process.exit(0);
    }

    // pgcrypto provides gen_random_uuid(); enable if missing (no-op if present).
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

    await sequelize.query(CREATE_SQL);
    console.log('[approval-flow-ddl] task_approval_flows table ensured.');

    for (const sql of ADDITIVE_COLUMNS_SQL) {
      await sequelize.query(sql);
    }
    console.log('[approval-flow-ddl] Additive columns ensured (stage).');

    for (const sql of INDEX_SQL) {
      await sequelize.query(sql);
    }
    console.log('[approval-flow-ddl] Indexes ensured.');

    // Sanity check — verify the unique index exists. If a prior partial run
    // created the table without the index, this surfaces the issue loudly.
    const [rows] = await sequelize.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'task_approval_flows'
          AND indexname = 'task_approval_flows_task_level_unique';`
    );
    if (rows.length !== 1) {
      throw new Error('Unique index task_approval_flows_task_level_unique missing after DDL.');
    }
    console.log('[approval-flow-ddl] Verified unique (taskId, level) index present.');

    process.exit(0);
  } catch (err) {
    console.error('[approval-flow-ddl] FAILED:', err.message);
    process.exit(1);
  }
})();
