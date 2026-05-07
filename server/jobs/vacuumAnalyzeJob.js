const cron = require('node-cron');
const { sequelize } = require('../models');
const { withCronLock } = require('./cronLock');

/**
 * Weekly VACUUM ANALYZE on the highest-traffic tables.
 *
 * Why this job exists
 * -------------------
 * In May 2026 production hit `missing chunk number 0 for toast value 54078
 * in pg_toast_2619` on `getBoard` / `getTasks`. Root cause: dangling TOAST
 * pointer in `pg_statistic` (the planner stats catalog) for the `tasks`
 * table. We recovered with:
 *
 *   DELETE FROM pg_statistic WHERE starelid = 'tasks'::regclass;
 *   ANALYZE tasks;
 *
 * Postgres autovacuum normally prevents this, but the default thresholds
 * (autovacuum_analyze_scale_factor=0.1) mean a 100k-row `tasks` table
 * waits ~10k changes between ANALYZEs. On heavy churn (status flips,
 * recurring task generation) stats can drift far enough that the planner
 * picks bad plans, and very rarely TOAST pages can become inconsistent
 * across crash/restart cycles.
 *
 * A weekly explicit VACUUM ANALYZE on the hot tables:
 *   1. Refreshes planner stats deterministically (catches drift).
 *   2. Reclaims dead-tuple space and rebuilds TOAST chunks.
 *   3. Surfaces any latent corruption as a job-error log line we can
 *      alert on, instead of as a user-facing 500 in the live API.
 *
 * Schedule
 * --------
 * Sunday 03:00 server time. Off-peak across most timezones, after the
 * weekly recurring-task cohort has settled.
 *
 * Replica safety
 * --------------
 * Wrapped in `withCronLock` so only one replica runs the maintenance
 * per tick. Two concurrent VACUUMs on the same table would not corrupt
 * data (Postgres serialises them) but would hold locks longer than
 * necessary and double the IO. The advisory lock prevents both.
 *
 * Operational notes
 * -----------------
 * - VACUUM (without FULL) is non-blocking: regular reads/writes continue.
 * - We deliberately do NOT use VACUUM FULL — it rewrites the table and
 *   takes an exclusive lock. If you ever need to reclaim heavy bloat,
 *   run VACUUM FULL manually during a maintenance window.
 * - We deliberately do NOT touch system catalogs (pg_statistic, pg_class)
 *   here. Postgres handles those itself and direct VACUUMing them
 *   requires superuser. If pg_statistic ever drifts again, the runbook
 *   in PROGRESS.md applies (DELETE + ANALYZE specific table).
 */

// Tables we VACUUM ANALYZE explicitly. Order matters slightly: tasks
// first because they're the largest, then their join tables, then the
// rest. Each table is its own statement so a failure on one doesn't
// abort the whole job.
const TABLES_TO_MAINTAIN = [
  'tasks',
  'task_assignees',
  'task_owners',
  'subtasks',
  'comments',
  'notifications',
  'activities',
  'worklogs',
  'file_attachments',
  'users',
  'boards',
];

async function runVacuumAnalyze() {
  console.log('[VacuumAnalyze] Starting weekly maintenance...');
  const startedAt = Date.now();
  let succeeded = 0;
  let failed = 0;

  for (const table of TABLES_TO_MAINTAIN) {
    try {
      // Identifier is hard-coded above (not user input) so string
      // interpolation here is safe. We can't parameterise table names
      // in Postgres parameterised queries — they're parsed at planning
      // time, so we must build the SQL ourselves. The whitelist is the
      // entire defense.
      await sequelize.query(`VACUUM (ANALYZE) "${table}"`);
      succeeded++;
    } catch (err) {
      failed++;
      // Don't throw — keep going so one corrupt table doesn't skip
      // maintenance on the rest. We still surface the error in logs
      // so monitoring / alerting can fire on it.
      console.error(`[VacuumAnalyze] Failed on "${table}":`, err && err.message);
    }
  }

  // ── Refresh-token GC (piggy-backs on the weekly maintenance) ───────────
  // The refresh_tokens table grows monotonically until we delete expired
  // rows. We keep ~14 days of audit history beyond expiry so we can
  // forensically investigate a stolen-token report ("show me the JTIs that
  // were active for user X last Tuesday"). Anything older is purely dead
  // weight and we drop it. Bounded by `expiresAt < now() - 14 days` so we
  // never accidentally delete a still-live token.
  try {
    const [, meta] = await sequelize.query(
      `DELETE FROM refresh_tokens WHERE "expiresAt" < NOW() - INTERVAL '14 days'`
    );
    const deleted = (meta && (meta.rowCount || (meta.rows && meta.rows.length))) || 0;
    console.log(`[VacuumAnalyze] refresh_tokens GC: ${deleted} expired row(s) removed.`);
  } catch (err) {
    // Never fatal — the table may not exist yet on a fresh install before
    // boot DDL completes. We only log so monitoring can watch.
    console.warn('[VacuumAnalyze] refresh_tokens GC skipped:', err && err.message);
  }

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `[VacuumAnalyze] Done. ${succeeded} ok, ${failed} failed, ${elapsedSec}s elapsed.`
  );
}

function startVacuumAnalyzeJob() {
  // Sunday at 03:00 (cron format: minute hour day-of-month month day-of-week)
  cron.schedule('0 3 * * 0', () => {
    withCronLock('vacuumAnalyze', runVacuumAnalyze).catch((err) => {
      console.error('[VacuumAnalyze] Job error:', err && err.message);
    });
  });
  console.log('[VacuumAnalyze] Cron scheduled for Sunday 03:00 (replica-safe).');
}

module.exports = { startVacuumAnalyzeJob, runVacuumAnalyze };
