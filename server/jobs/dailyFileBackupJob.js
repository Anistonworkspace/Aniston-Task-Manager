/**
 * Daily uploaded-files backup job.
 *
 * Schedule
 * --------
 *   Defaults to `30 18 * * *` — 18:30 (Asia/Kolkata by default), 30 minutes
 *   AFTER the database backup (`0 18`). The offset means the two heavy IO
 *   operations don't contend for disk/CPU at the same instant, and the files
 *   archive captures a state consistent-enough with the DB dump taken minutes
 *   earlier. Override cadence with FILE_BACKUP_CRON.
 *
 * Replica safety
 * --------------
 *   Wrapped in `withCronLock('dailyFilesBackup')` — a DIFFERENT lock name from
 *   the DB backup ('dailyDbBackup'), so the two jobs are independent and one
 *   replica can run the files backup while another runs the DB backup.
 *
 * Retention
 * ---------
 *   After a successful archive, prunes scheduled files backups older than
 *   FILE_BACKUP_RETENTION_DAYS (default 30). Manual / uploaded / pre_restore
 *   archives are never auto-pruned.
 *
 * Failure handling
 * ----------------
 *   Errors are logged via safeLogger; the job never crashes the process. A
 *   failed archive leaves a `status=failed` FileBackupRecord row for the UI.
 */

const cron = require('node-cron');
const { withCronLock } = require('./cronLock');
const fileBackupService = require('../services/fileBackupService');
const safeLogger = require('../utils/safeLogger');

const DEFAULT_SCHEDULE = '30 18 * * *'; // 6:30 PM every day

async function runScheduledFilesBackup() {
  const cronExpr = process.env.FILE_BACKUP_CRON || DEFAULT_SCHEDULE;
  safeLogger.info('[DailyFilesBackup] scheduled run starting', { cron: cronExpr });
  try {
    const record = await fileBackupService.createFilesBackup({
      trigger: 'scheduled',
      createdBy: null,
    });
    safeLogger.info('[DailyFilesBackup] scheduled files backup completed', {
      id: record.id, filename: record.filename, sizeBytes: record.sizeBytes,
    });

    try {
      const { deleted } = await fileBackupService.applyRetentionPolicy();
      if (deleted > 0) {
        safeLogger.info('[DailyFilesBackup] retention pruned old scheduled files backups', { deleted });
      }
    } catch (err) {
      safeLogger.warn('[DailyFilesBackup] retention pass failed (non-fatal)', { err });
    }
  } catch (err) {
    safeLogger.error('[DailyFilesBackup] scheduled files backup failed', { err });
  }
}

function startDailyFileBackupJob() {
  if (process.env.FILE_BACKUP_ENABLED === 'false') {
    safeLogger.warn('[DailyFilesBackup] disabled via FILE_BACKUP_ENABLED=false');
    return;
  }

  fileBackupService.ensureDirectories().catch((err) => {
    safeLogger.warn('[DailyFilesBackup] could not pre-create backup dirs (will retry on first run)', { err });
  });

  // Reap orphan rows left in `running` from a previous boot.
  fileBackupService.recoverStaleRunningBackups().catch((err) => {
    safeLogger.warn('[DailyFilesBackup] stale-backup recovery failed (non-fatal)', { err });
  });

  const cronExpr = process.env.FILE_BACKUP_CRON || DEFAULT_SCHEDULE;
  if (!cron.validate(cronExpr)) {
    safeLogger.error('[DailyFilesBackup] invalid FILE_BACKUP_CRON — falling back to default', {
      provided: cronExpr, default: DEFAULT_SCHEDULE,
    });
  }
  const schedule = cron.validate(cronExpr) ? cronExpr : DEFAULT_SCHEDULE;

  // Same timezone convention as the DB backup job: 6:30 PM IST by default.
  const timezone = process.env.BACKUP_CRON_TZ || 'Asia/Kolkata';
  const cronOpts = timezone ? { timezone } : undefined;

  cron.schedule(schedule, () => {
    withCronLock('dailyFilesBackup', runScheduledFilesBackup).catch((err) => {
      safeLogger.error('[DailyFilesBackup] job error', { err });
    });
  }, cronOpts);

  safeLogger.info('[DailyFilesBackup] cron scheduled', {
    schedule, timezone: timezone || '(system)', retentionDays: fileBackupService.RETENTION_DAYS,
  });
  console.log(`[DailyFilesBackup] Cron scheduled: ${schedule} ${timezone ? `(${timezone})` : '(system TZ)'} (replica-safe).`);
}

module.exports = {
  startDailyFileBackupJob,
  runScheduledFilesBackup,
};
