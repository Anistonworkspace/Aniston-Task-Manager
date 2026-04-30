/**
 * Phase A — Daily Work / Recurring Task workflow.
 *
 * Adds recurring-instance bookkeeping columns to the existing `tasks` table
 * and creates the partial unique index that enforces "one task per template
 * per occurrence date" at the database level (idempotent generation).
 *
 * Why a manual script rather than sequelize.sync({alter:true})?
 *   Sequelize's ALTER path generates invalid SQL when REFERENCES + SET DEFAULT
 *   NULL are combined (CLAUDE.md). All schema mutations go through hand-rolled
 *   SQL. Every statement uses IF NOT EXISTS so the script is safe to re-run.
 *
 * What this adds (all NULL-safe, all backward-compatible):
 *   recurringTemplateId    UUID NULL  → FK to recurring_task_templates(id) ON DELETE SET NULL
 *   occurrenceDate         DATE NULL  → which calendar day this instance is "for"
 *   isRecurringInstance    BOOLEAN    → fast filter; default FALSE for legacy tasks
 *   completedAt            TIMESTAMP  → set when status flips to 'done', cleared otherwise
 *   missedEscalationSent   BOOLEAN    → idempotency flag for the missed-escalation job
 *   missedEscalationSentAt TIMESTAMP  → when the escalation fired (audit/debug)
 *
 *   UNIQUE INDEX (recurringTemplateId, occurrenceDate) WHERE recurringTemplateId IS NOT NULL
 *   This is the duplicate-protection guarantee. Two concurrent generation jobs
 *   inserting for the same template+date will result in exactly one row, the
 *   second failing with a unique-violation that the service catches as a no-op.
 *
 * Pre-requisite:
 *   node server/scripts/create-recurring-task-templates.js   (must run first)
 *
 * Run:
 *   node server/scripts/add-recurring-fields-to-tasks.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');

const STATEMENTS = [
  // Recurring-instance linkage. ON DELETE SET NULL keeps generated task history
  // intact even if the template is hard-deleted (we soft-archive by default,
  // but defense in depth).
  `ALTER TABLE tasks
     ADD COLUMN IF NOT EXISTS "recurringTemplateId" UUID
     REFERENCES recurring_task_templates(id) ON DELETE SET NULL;`,

  `ALTER TABLE tasks
     ADD COLUMN IF NOT EXISTS "occurrenceDate" DATE;`,

  `ALTER TABLE tasks
     ADD COLUMN IF NOT EXISTS "isRecurringInstance" BOOLEAN NOT NULL DEFAULT FALSE;`,

  // completedAt: NEW, also used for non-recurring tasks. Backfill below sets it
  // for already-done tasks so reporting queries that use COALESCE(completedAt,
  // updatedAt) work correctly on day one.
  `ALTER TABLE tasks
     ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP WITH TIME ZONE;`,

  `ALTER TABLE tasks
     ADD COLUMN IF NOT EXISTS "missedEscalationSent" BOOLEAN NOT NULL DEFAULT FALSE;`,

  `ALTER TABLE tasks
     ADD COLUMN IF NOT EXISTS "missedEscalationSentAt" TIMESTAMP WITH TIME ZONE;`,

  // Read-side index for the missed-escalation job (find recurring instances
  // where dueDate < now AND status != 'done' AND missedEscalationSent = FALSE).
  `CREATE INDEX IF NOT EXISTS tasks_recurring_instance_idx
     ON tasks ("recurringTemplateId", "occurrenceDate")
     WHERE "isRecurringInstance" = TRUE;`,

  // The duplicate-protection guarantee. Partial unique index — only kicks in
  // when recurringTemplateId is set, so non-recurring tasks are completely
  // unaffected.
  `CREATE UNIQUE INDEX IF NOT EXISTS tasks_recurring_template_occurrence_unique
     ON tasks ("recurringTemplateId", "occurrenceDate")
     WHERE "recurringTemplateId" IS NOT NULL AND "occurrenceDate" IS NOT NULL;`,

  // Idempotent backfill for completedAt. Uses updatedAt as the best available
  // timestamp for legacy done-tasks. Only fills NULL rows so re-running this
  // never overwrites an already-set completedAt.
  `UPDATE tasks
      SET "completedAt" = "updatedAt"
    WHERE status = 'done' AND "completedAt" IS NULL;`,
];

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[recurring-tasks-cols] Connected to database.');

    // Sanity check: companion table must exist or the FK will fail.
    const [tplRows] = await sequelize.query(
      `SELECT to_regclass('public.recurring_task_templates') AS t;`
    );
    if (!tplRows[0]?.t) {
      console.error(
        '[recurring-tasks-cols] FAILED: recurring_task_templates does not exist.\n'
        + '  Run server/scripts/create-recurring-task-templates.js first.'
      );
      process.exit(1);
    }

    // Pre-state snapshot.
    const [colsBefore] = await sequelize.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tasks'
          AND column_name IN (
            'recurringTemplateId','occurrenceDate','isRecurringInstance',
            'completedAt','missedEscalationSent','missedEscalationSentAt'
          );`
    );
    console.log(
      `[recurring-tasks-cols] Existing recurring columns: `
      + (colsBefore.length ? colsBefore.map((r) => r.column_name).join(', ') : 'none')
    );

    for (const sql of STATEMENTS) {
      console.log(`[recurring-tasks-cols] running: ${sql.replace(/\s+/g, ' ').slice(0, 120).trim()}...`);
      await sequelize.query(sql);
    }

    // Verification — every required column + the unique index.
    const requiredCols = [
      'recurringTemplateId', 'occurrenceDate', 'isRecurringInstance',
      'completedAt', 'missedEscalationSent', 'missedEscalationSentAt',
    ];
    const [colsAfter] = await sequelize.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tasks' AND column_name = ANY($1);`,
      { bind: [requiredCols] }
    );
    const have = new Set(colsAfter.map((r) => r.column_name));
    const missing = requiredCols.filter((c) => !have.has(c));
    if (missing.length) {
      throw new Error(`Columns missing after migration: ${missing.join(', ')}`);
    }

    const [idxRows] = await sequelize.query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'tasks'
          AND indexname = 'tasks_recurring_template_occurrence_unique';`
    );
    if (idxRows.length !== 1) {
      throw new Error('Unique partial index tasks_recurring_template_occurrence_unique missing after CREATE.');
    }

    // How many done-tasks were backfilled this run? (Useful first-run signal.)
    const [filledRows] = await sequelize.query(
      `SELECT COUNT(*)::int AS n FROM tasks
         WHERE status = 'done' AND "completedAt" IS NOT NULL;`
    );
    console.log(`[recurring-tasks-cols] Verified columns + unique partial index. Done-tasks with completedAt set: ${filledRows[0].n}.`);
    process.exit(0);
  } catch (err) {
    console.error('[recurring-tasks-cols] FAILED:', err.message);
    if (err.parent) console.error('  parent:', err.parent.message);
    process.exit(1);
  }
})();
