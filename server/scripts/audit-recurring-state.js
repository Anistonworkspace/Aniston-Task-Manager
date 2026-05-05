/**
 * Read-only audit of the Daily Work / Recurring Work pipeline.
 *
 * Connects to the database in the same way the server does, runs a fixed set
 * of read-only SELECTs, and prints a human-friendly summary. NEVER writes.
 *
 *   node server/scripts/audit-recurring-state.js
 *
 * Sections:
 *   - Templates inventory by status
 *   - nextRunAt distribution
 *   - Templates pointing at archived / missing boards
 *   - Templates with inactive / missing assignees
 *   - Generated instances missing task_assignees / task_owners
 *   - Generated instances missing dueDate / occurrenceDate
 *   - Duplicate-risk summary (should always be 0 thanks to the partial unique
 *     index — non-zero is a real bug)
 *
 * Safe to run against production. Issues only SELECT statements.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');

function fmt(n, w = 6) { return String(n).padStart(w, ' '); }
function header(title) {
  console.log('\n' + '─'.repeat(72));
  console.log(title);
  console.log('─'.repeat(72));
}
async function selectOne(sql, replacements = {}) {
  const [rows] = await sequelize.query(sql, { replacements });
  return rows[0] || null;
}
async function selectAll(sql, replacements = {}) {
  const [rows] = await sequelize.query(sql, { replacements });
  return rows;
}

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[audit-recurring] Connected.');

    // Sanity: required tables exist.
    const tplExists = await selectOne(
      `SELECT to_regclass('public.recurring_task_templates') AS t`
    );
    if (!tplExists?.t) {
      console.error('[audit-recurring] recurring_task_templates does not exist. Aborting.');
      process.exit(1);
    }

    // ── 1. Inventory by status ───────────────────────────────────────────
    header('1) Templates by status');
    const inv = await selectOne(`
      SELECT
        COUNT(*)                                          ::int AS total,
        COUNT(*) FILTER (WHERE "archivedAt" IS NOT NULL)  ::int AS archived,
        COUNT(*) FILTER (WHERE "isActive" = TRUE
                         AND "archivedAt" IS NULL)        ::int AS active,
        COUNT(*) FILTER (WHERE "isActive" = FALSE
                         AND "archivedAt" IS NULL)        ::int AS paused
      FROM recurring_task_templates
    `);
    console.log(`  total      ${fmt(inv.total)}`);
    console.log(`  active     ${fmt(inv.active)}`);
    console.log(`  paused     ${fmt(inv.paused)}`);
    console.log(`  archived   ${fmt(inv.archived)}`);

    const byFreq = await selectAll(`
      SELECT frequency, COUNT(*)::int AS n
        FROM recurring_task_templates
       WHERE "archivedAt" IS NULL
       GROUP BY frequency
       ORDER BY frequency
    `);
    console.log('\n  By frequency (active+paused, excluding archived):');
    for (const row of byFreq) {
      console.log(`    ${(row.frequency || 'unknown').padEnd(12)} ${fmt(row.n)}`);
    }

    // ── 2. nextRunAt distribution ────────────────────────────────────────
    header('2) nextRunAt distribution (active, non-archived)');
    const nra = await selectOne(`
      SELECT
        COUNT(*) FILTER (WHERE "nextRunAt" IS NULL)        ::int AS unscheduled,
        COUNT(*) FILTER (WHERE "nextRunAt" <= NOW())       ::int AS overdue,
        COUNT(*) FILTER (WHERE "nextRunAt" >  NOW()
                         AND "nextRunAt" <= NOW() + INTERVAL '24 hours')
                                                          ::int AS due_24h,
        COUNT(*) FILTER (WHERE "nextRunAt" >  NOW() + INTERVAL '24 hours')
                                                          ::int AS later
      FROM recurring_task_templates
      WHERE "isActive" = TRUE AND "archivedAt" IS NULL
    `);
    console.log(`  unscheduled (NULL nextRunAt)      ${fmt(nra.unscheduled)}`);
    console.log(`  overdue (cron should pick up)     ${fmt(nra.overdue)}`);
    console.log(`  due in next 24h                   ${fmt(nra.due_24h)}`);
    console.log(`  later                             ${fmt(nra.later)}`);

    if (nra.unscheduled > 0 || nra.overdue > 0) {
      const sample = await selectAll(`
        SELECT id, title, frequency, "nextRunAt", "lastGeneratedDate"
          FROM recurring_task_templates
         WHERE "isActive" = TRUE
           AND "archivedAt" IS NULL
           AND ("nextRunAt" IS NULL OR "nextRunAt" <= NOW())
         ORDER BY "nextRunAt" NULLS FIRST
         LIMIT 5
      `);
      console.log('\n  Sample (up to 5):');
      for (const row of sample) {
        console.log(
          `    [${row.id}] ${row.title.slice(0, 36).padEnd(36)} `
          + `freq=${row.frequency.padEnd(8)} `
          + `next=${row.nextRunAt ? new Date(row.nextRunAt).toISOString() : '—'} `
          + `lastGen=${row.lastGeneratedDate || '—'}`
        );
      }
    }

    // ── 3. Templates pointing at archived / missing boards ───────────────
    header('3) Templates with archived or missing boards');
    const badBoard = await selectAll(`
      SELECT t.id, t.title, t."boardId", b.id AS board_id, b."isArchived" AS board_archived
        FROM recurring_task_templates t
        LEFT JOIN boards b ON b.id = t."boardId"
       WHERE t."archivedAt" IS NULL
         AND (b.id IS NULL OR b."isArchived" = TRUE)
       ORDER BY t."createdAt" DESC
    `);
    console.log(`  found: ${badBoard.length}`);
    for (const row of badBoard.slice(0, 10)) {
      console.log(
        `    [${row.id}] ${row.title.slice(0, 36).padEnd(36)} `
        + `boardId=${row.boardId} board=${row.board_id ? (row.board_archived ? 'archived' : 'ok') : 'MISSING'}`
      );
    }
    if (badBoard.length > 10) console.log(`    ...and ${badBoard.length - 10} more`);

    // ── 4. Templates with inactive / missing assignees ───────────────────
    header('4) Templates with inactive or missing assignees');
    const badAssignee = await selectAll(`
      SELECT t.id, t.title, t."assigneeId", u.id AS user_id, u."isActive" AS user_active
        FROM recurring_task_templates t
        LEFT JOIN users u ON u.id = t."assigneeId"
       WHERE t."archivedAt" IS NULL
         AND (u.id IS NULL OR u."isActive" = FALSE)
       ORDER BY t."createdAt" DESC
    `);
    console.log(`  found: ${badAssignee.length}`);
    for (const row of badAssignee.slice(0, 10)) {
      console.log(
        `    [${row.id}] ${row.title.slice(0, 36).padEnd(36)} `
        + `assignee=${row.assigneeId} user=${row.user_id ? (row.user_active ? 'active' : 'INACTIVE') : 'MISSING'}`
      );
    }
    if (badAssignee.length > 10) console.log(`    ...and ${badAssignee.length - 10} more`);

    // ── 5. Generated instances missing task_assignees rows ───────────────
    header('5) Generated recurring instances missing task_assignees');
    const taTable = await selectOne(
      `SELECT to_regclass('public.task_assignees') AS t`
    );
    if (!taTable?.t) {
      console.log('  task_assignees table does not exist on this install — skipped.');
    } else {
      const missingTA = await selectOne(`
        SELECT COUNT(*)::int AS n
          FROM tasks t
         WHERE t."isRecurringInstance" = TRUE
           AND t."isArchived" = FALSE
           AND NOT EXISTS (
             SELECT 1 FROM task_assignees ta
              WHERE ta."taskId" = t.id AND ta.role = 'assignee'
           )
      `);
      console.log(`  count: ${missingTA.n}`);
      if (missingTA.n > 0) {
        const sample = await selectAll(`
          SELECT t.id, t.title, t."boardId", t."assignedTo", t."occurrenceDate"
            FROM tasks t
           WHERE t."isRecurringInstance" = TRUE
             AND t."isArchived" = FALSE
             AND NOT EXISTS (
               SELECT 1 FROM task_assignees ta
                WHERE ta."taskId" = t.id AND ta.role = 'assignee'
             )
           ORDER BY t."createdAt" DESC
           LIMIT 5
        `);
        console.log('\n  Sample (up to 5):');
        for (const row of sample) {
          console.log(
            `    [${row.id}] ${row.title.slice(0, 36).padEnd(36)} `
            + `assignedTo=${row.assignedTo || '—'} occDate=${row.occurrenceDate || '—'}`
          );
        }
      }
    }

    // ── 6. Generated instances missing task_owners rows ──────────────────
    header('6) Generated recurring instances missing task_owners');
    const toTable = await selectOne(
      `SELECT to_regclass('public.task_owners') AS t`
    );
    if (!toTable?.t) {
      console.log('  task_owners table does not exist on this install — skipped.');
    } else {
      const missingTO = await selectOne(`
        SELECT COUNT(*)::int AS n
          FROM tasks t
         WHERE t."isRecurringInstance" = TRUE
           AND t."isArchived" = FALSE
           AND NOT EXISTS (
             SELECT 1 FROM task_owners towners
              WHERE towners."taskId" = t.id
           )
      `);
      console.log(`  count: ${missingTO.n}`);
      if (missingTO.n > 0) {
        const sample = await selectAll(`
          SELECT t.id, t.title, t."boardId", t."assignedTo", t."occurrenceDate"
            FROM tasks t
           WHERE t."isRecurringInstance" = TRUE
             AND t."isArchived" = FALSE
             AND NOT EXISTS (
               SELECT 1 FROM task_owners towners
                WHERE towners."taskId" = t.id
             )
           ORDER BY t."createdAt" DESC
           LIMIT 5
        `);
        console.log('\n  Sample (up to 5):');
        for (const row of sample) {
          console.log(
            `    [${row.id}] ${row.title.slice(0, 36).padEnd(36)} `
            + `assignedTo=${row.assignedTo || '—'} occDate=${row.occurrenceDate || '—'}`
          );
        }
      }
    }

    // ── 7. Instances missing core fields ─────────────────────────────────
    header('7) Generated recurring instances missing core fields');
    const missingCore = await selectOne(`
      SELECT
        COUNT(*) FILTER (WHERE "assignedTo" IS NULL)     ::int AS no_assignee,
        COUNT(*) FILTER (WHERE "dueDate" IS NULL)        ::int AS no_due_date,
        COUNT(*) FILTER (WHERE "occurrenceDate" IS NULL) ::int AS no_occurrence,
        COUNT(*) FILTER (WHERE "boardId" IS NULL)        ::int AS no_board,
        COUNT(*) FILTER (WHERE "groupId" IS NULL OR "groupId" = '') ::int AS no_group
      FROM tasks
      WHERE "isRecurringInstance" = TRUE AND "isArchived" = FALSE
    `);
    console.log(`  no assignedTo                  ${fmt(missingCore.no_assignee)}`);
    console.log(`  no dueDate                     ${fmt(missingCore.no_due_date)}`);
    console.log(`  no occurrenceDate              ${fmt(missingCore.no_occurrence)}`);
    console.log(`  no boardId                     ${fmt(missingCore.no_board)}`);
    console.log(`  no groupId                     ${fmt(missingCore.no_group)}`);

    // ── 8. Duplicate-risk summary ────────────────────────────────────────
    header('8) Duplicate-risk summary');
    const dupes = await selectAll(`
      SELECT "recurringTemplateId", "occurrenceDate", COUNT(*)::int AS n
        FROM tasks
       WHERE "recurringTemplateId" IS NOT NULL
         AND "occurrenceDate"      IS NOT NULL
       GROUP BY "recurringTemplateId", "occurrenceDate"
      HAVING COUNT(*) > 1
       ORDER BY n DESC
       LIMIT 10
    `);
    if (dupes.length === 0) {
      console.log('  No duplicate (templateId, occurrenceDate) pairs found.');
      console.log('  (Partial unique index `tasks_recurring_template_occurrence_unique` is doing its job.)');
    } else {
      console.log(`  WARNING: ${dupes.length} duplicate pair(s) detected:`);
      for (const row of dupes) {
        console.log(
          `    template=${row.recurringTemplateId} `
          + `occDate=${row.occurrenceDate} count=${row.n}`
        );
      }
      console.log('\n  This should be impossible if the partial unique index exists.');
      console.log('  Verify: \\d+ tasks  →  expect tasks_recurring_template_occurrence_unique');
    }

    // ── 9. Index health check ────────────────────────────────────────────
    header('9) Index health check');
    const idxRows = await selectAll(`
      SELECT indexname
        FROM pg_indexes
       WHERE tablename = 'tasks'
         AND indexname IN (
           'tasks_recurring_template_occurrence_unique',
           'tasks_recurring_instance_idx'
         )
    `);
    const have = new Set(idxRows.map((r) => r.indexname));
    for (const expected of [
      'tasks_recurring_template_occurrence_unique',
      'tasks_recurring_instance_idx',
    ]) {
      console.log(`  ${have.has(expected) ? 'OK ' : 'MISSING'} ${expected}`);
    }

    console.log('\n[audit-recurring] Done. (read-only — no rows were modified)');
    process.exit(0);
  } catch (err) {
    console.error('[audit-recurring] FAILED:', err.message);
    if (err.parent) console.error('  parent:', err.parent.message);
    process.exit(1);
  }
})();
