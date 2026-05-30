/**
 * Daily database backup job.
 *
 * Schedule
 * --------
 *   Defaults to `0 18 * * *` — every day at 18:00 *server time* (UTC in the
 *   production container; the EC2 host clock is UTC by convention). Override
 *   with the `DB_BACKUP_CRON` env if a different cadence is needed.
 *
 *   Why a single fixed time and not a rolling cohort? The product requirement
 *   says "every day at exactly 6:00 PM" — we honour that literally. The cron
 *   tick fires once; the advisory lock guarantees exactly one replica wins.
 *
 * Replica safety
 * --------------
 *   Wrapped in `withCronLock('dailyDbBackup')` so multi-replica deploys do
 *   not produce duplicate dumps. The lock is held only for the duration of
 *   the dump (transactional advisory lock — auto-releases on COMMIT).
 *
 * Retention pass
 * --------------
 *   After a *successful* dump, runs `applyRetentionPolicy()` which deletes
 *   scheduled backups older than DB_BACKUP_RETENTION_DAYS (default 30).
 *   Manual / uploaded / pre_restore artefacts are NEVER auto-pruned.
 *
 * Failure handling
 * ----------------
 *   Errors are logged via safeLogger but the job never crashes the process.
 *   A failed dump leaves a `status=failed` BackupRecord row so the UI can
 *   show that the 6 PM run did not succeed.
 */

const cron = require('node-cron');
const { withCronLock } = require('./cronLock');
const backupService = require('../services/backupService');
const safeLogger = require('../utils/safeLogger');

const DEFAULT_SCHEDULE = '0 18 * * *'; // 6:00 PM every day

async function runScheduledBackup() {
  const cronExpr = process.env.DB_BACKUP_CRON || DEFAULT_SCHEDULE;
  safeLogger.info('[DailyBackup] scheduled run starting', { cron: cronExpr });
  try {
    const record = await backupService.createBackup({
      trigger: 'scheduled',
      createdBy: null,
    });
    safeLogger.info('[DailyBackup] scheduled backup completed', {
      id: record.id, filename: record.filename, sizeBytes: record.sizeBytes,
    });

    // Only run retention after a SUCCESSFUL backup. If the dump failed we
    // do not want to also delete old backups in the same tick — preserving
    // recoverable artefacts during a broken cycle is the safe default.
    try {
      const { deleted } = await backupService.applyRetentionPolicy();
      if (deleted > 0) {
        safeLogger.info('[DailyBackup] retention pruned old scheduled backups', { deleted });
      }
    } catch (err) {
      safeLogger.warn('[DailyBackup] retention pass failed (non-fatal)', { err });
    }
  } catch (err) {
    // createBackup already logged + persisted the failure record. This is the
    // top-level catch so a thrown error here does not kill the cron loop.
    safeLogger.error('[DailyBackup] scheduled backup failed', { err });
  }
}

function startDailyBackupJob() {
  if (process.env.DB_BACKUP_ENABLED === 'false') {
    safeLogger.warn('[DailyBackup] disabled via DB_BACKUP_ENABLED=false');
    return;
  }

  // One-time smoke test so missing pg_dump surfaces in the boot log,
  // not at 18:00 with no UI feedback.
  backupService.assertPgToolsAvailable().catch(() => { /* swallowed inside */ });
  backupService.ensureDirectories().catch((err) => {
    safeLogger.warn('[DailyBackup] could not pre-create backup dirs (will retry on first run)', { err });
  });

  // Reap orphan rows from the previous boot. A row left in `running` after
  // restart is guaranteed orphaned — the only Node process that could have
  // completed it died. Without this, the concurrency lock would refuse all
  // future backups until an operator manually deleted the stuck row.
  backupService.recoverStaleRunningBackups().catch((err) => {
    safeLogger.warn('[DailyBackup] stale-backup recovery failed (non-fatal)', { err });
  });

  const cronExpr = process.env.DB_BACKUP_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(cronExpr)) {
    safeLogger.error('[DailyBackup] invalid DB_BACKUP_CRON — falling back to default', {
      provided: cronExpr, default: DEFAULT_SCHEDULE,
    });
  }
  const schedule = cron.validate(cronExpr) ? cronExpr : DEFAULT_SCHEDULE;

  // Timezone the cron expression is evaluated in. Defaults to Asia/Kolkata
  // because production runs in India and the spec is "6 PM IST". Without a
  // default, node-cron uses the container's system timezone (UTC in Docker),
  // which would silently shift the run to 23:30 IST. BACKUP_CRON_TZ remains
  // an env override for any future non-India deployment.
  const timezone = process.env.BACKUP_CRON_TZ || 'Asia/Kolkata';
  const cronOpts = timezone ? { timezone } : undefined;

  cron.schedule(schedule, () => {
    withCronLock('dailyDbBackup', runScheduledBackup).catch((err) => {
      safeLogger.error('[DailyBackup] job error', { err });
    });
  }, cronOpts);

  safeLogger.info('[DailyBackup] cron scheduled', {
    schedule, timezone: timezone || '(system)', retentionDays: backupService.RETENTION_DAYS,
  });
  console.log(`[DailyBackup] Cron scheduled: ${schedule} ${timezone ? `(${timezone})` : '(system TZ)'} (replica-safe).`);
}

module.exports = {
  startDailyBackupJob,
  runScheduledBackup,
};
