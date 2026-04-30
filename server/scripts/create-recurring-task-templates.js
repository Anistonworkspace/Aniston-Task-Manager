/**
 * Phase A — Daily Work / Recurring Task workflow.
 *
 * Creates the `recurring_task_templates` table and extends the
 * `notifications.type` ENUM with two new values used by the recurring
 * generation + missed-escalation jobs (`recurring_generated`, `recurring_missed`).
 *
 * Why a manual script rather than sequelize.sync({alter:true})?
 *   Per CLAUDE.md: Sequelize's ALTER path generates invalid SQL when REFERENCES
 *   + SET DEFAULT NULL are combined, so all schema changes go through hand-rolled
 *   SQL. CREATE TABLE / ALTER TYPE / ADD COLUMN with IF NOT EXISTS guards make
 *   this safe to re-run.
 *
 * Run:
 *   node server/scripts/create-recurring-task-templates.js
 *   node server/scripts/create-recurring-task-templates.js --drop   # tear down (dev only)
 *
 * Companion script (run after this one):
 *   node server/scripts/add-recurring-fields-to-tasks.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');

const drop = process.argv.includes('--drop');

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS recurring_task_templates (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title                   VARCHAR(300) NOT NULL,
    description             TEXT,
    "boardId"               UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    "groupId"               VARCHAR(100) NOT NULL DEFAULT 'new',
    "assigneeId"            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    "createdBy"             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    priority                VARCHAR(20) NOT NULL DEFAULT 'medium',
    frequency               VARCHAR(20) NOT NULL DEFAULT 'daily',
    weekdays                JSONB NOT NULL DEFAULT '[]'::jsonb,
    "dayOfMonth"            INTEGER,
    "startDate"             DATE NOT NULL,
    "endDate"               DATE,
    "dueTime"               TIME NOT NULL DEFAULT '18:00:00',
    timezone                VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "escalateIfMissed"      BOOLEAN NOT NULL DEFAULT FALSE,
    "escalationTargets"     JSONB NOT NULL DEFAULT '["assignee","manager"]'::jsonb,
    "isActive"              BOOLEAN NOT NULL DEFAULT TRUE,
    "lastGeneratedDate"     DATE,
    "nextRunAt"             TIMESTAMP WITH TIME ZONE,
    "archivedAt"            TIMESTAMP WITH TIME ZONE,
    "createdAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "updatedAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT recurring_task_templates_frequency_check
      CHECK (frequency IN ('daily','weekdays','weekly','monthly','custom')),
    CONSTRAINT recurring_task_templates_priority_check
      CHECK (priority IN ('low','medium','high','critical')),
    CONSTRAINT recurring_task_templates_end_after_start_check
      CHECK ("endDate" IS NULL OR "endDate" >= "startDate")
  );
`;

// Additive columns for installs that pre-date this script — no-op if the table
// was just created above with the same shape. CREATE TABLE IF NOT EXISTS does
// not modify an existing table, so future field additions go here.
const ADDITIVE_COLUMNS_SQL = [
  // (Reserved for future schema bumps. Keep this block so the next migrator
  // knows where to add ADD COLUMN IF NOT EXISTS statements.)
];

const INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS recurring_task_templates_next_run_idx
     ON recurring_task_templates ("nextRunAt")
     WHERE "isActive" = TRUE AND "archivedAt" IS NULL;`,
  `CREATE INDEX IF NOT EXISTS recurring_task_templates_assignee_idx
     ON recurring_task_templates ("assigneeId");`,
  `CREATE INDEX IF NOT EXISTS recurring_task_templates_board_idx
     ON recurring_task_templates ("boardId");`,
  `CREATE INDEX IF NOT EXISTS recurring_task_templates_active_idx
     ON recurring_task_templates ("isActive", "archivedAt");`,
  `CREATE INDEX IF NOT EXISTS recurring_task_templates_created_by_idx
     ON recurring_task_templates ("createdBy");`,
];

// notifications.type is an ENUM. ALTER TYPE ADD VALUE IF NOT EXISTS is the
// idempotent path. Cannot run inside an explicit transaction block on older
// Postgres, so each ALTER runs as its own statement (sequelize.query default
// auto-commits).
const ENUM_VALUES_SQL = [
  `ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS 'recurring_generated';`,
  `ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS 'recurring_missed';`,
];

const DROP_SQL = `DROP TABLE IF EXISTS recurring_task_templates CASCADE;`;

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[recurring-tpl-ddl] Connected to database.');

    if (drop) {
      console.log('[recurring-tpl-ddl] --drop requested, dropping table.');
      await sequelize.query(DROP_SQL);
      console.log('[recurring-tpl-ddl] Done. Table dropped.');
      // Note: ENUM values cannot be removed in Postgres; leaving them in place
      // is harmless and the standard practice.
      process.exit(0);
    }

    // pgcrypto provides gen_random_uuid(); enable if missing (no-op if present).
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

    await sequelize.query(CREATE_TABLE_SQL);
    console.log('[recurring-tpl-ddl] recurring_task_templates table ensured.');

    for (const sql of ADDITIVE_COLUMNS_SQL) {
      await sequelize.query(sql);
    }

    for (const sql of INDEX_SQL) {
      await sequelize.query(sql);
    }
    console.log('[recurring-tpl-ddl] Indexes ensured.');

    // ENUM additions — graceful: if the type doesn't exist (fresh install before
    // Notification model has run sync), skip and log.
    const [typeRows] = await sequelize.query(
      `SELECT 1 FROM pg_type WHERE typname = 'enum_notifications_type';`
    );
    if (typeRows.length === 0) {
      console.warn(
        '[recurring-tpl-ddl] enum_notifications_type does not exist yet — '
        + 'skip ENUM additions. Start the server once so Sequelize creates the '
        + 'notifications table, then re-run this script.'
      );
    } else {
      for (const sql of ENUM_VALUES_SQL) {
        await sequelize.query(sql);
      }
      console.log('[recurring-tpl-ddl] notifications.type ENUM extended (recurring_generated, recurring_missed).');
    }

    // Verification — table + at least one of our indexes.
    const [tblRows] = await sequelize.query(
      `SELECT to_regclass('public.recurring_task_templates') AS t;`
    );
    if (!tblRows[0]?.t) {
      throw new Error('recurring_task_templates table missing after CREATE.');
    }

    const [idxRows] = await sequelize.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'recurring_task_templates'
          AND indexname = 'recurring_task_templates_next_run_idx';`
    );
    if (idxRows.length !== 1) {
      throw new Error('recurring_task_templates_next_run_idx missing after CREATE INDEX.');
    }

    console.log('[recurring-tpl-ddl] Verified: table + nextRunAt partial index present.');
    process.exit(0);
  } catch (err) {
    console.error('[recurring-tpl-ddl] FAILED:', err.message);
    if (err.parent) console.error('  parent:', err.parent.message);
    process.exit(1);
  }
})();
