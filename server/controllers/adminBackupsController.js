/**
 * Tier-1 administered database backup management.
 *
 * Every endpoint in this controller is mounted behind `authenticate` +
 * `superAdminOnly` in routes/adminBackups.js. Don't add a route here
 * without that pairing — it's the only auth this surface area has.
 *
 * The controller is intentionally thin: it converts HTTP shape into
 * backupService calls and back. All filesystem touch, child-process
 * spawning, and path-traversal validation live in backupService.
 *
 * Response shape follows the project convention:
 *   { success: true, data: ... }
 *   { success: false, message: '...', code?: '...' }
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const multer = require('multer');
const backupService = require('../services/backupService');
const activityService = require('../services/activityService');
const safeLogger = require('../utils/safeLogger');

// ── Multer for the restore-upload endpoint ──────────────────────────────
//
// We deliberately do NOT reuse the project's general `upload` middleware:
// it's wired to the storage-provider abstraction and validates against
// MIME allowlists for documents/images. Backup uploads need a strict,
// purpose-built path that:
//   • writes to OS tmp (we move it into the backup volume in the service)
//   • caps file size at the configured backup-upload limit
//   • validates extension via filename — MIME for .sql.gz is unreliable
//     (browsers send application/gzip, application/x-gzip, or application/
//     octet-stream depending on the OS).
const MAX_UPLOAD_BYTES = (() => {
  const raw = parseInt(process.env.DB_BACKUP_UPLOAD_MAX_MB, 10);
  // Default 2 GB — production dumps can be hundreds of MB and we want
  // headroom for compressed full snapshots without ops surgery.
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 2048;
  return mb * 1024 * 1024;
})();

const restoreUploadMulter = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = /\.(sql\.gz|gz)$/i.test(file.originalname) ? '.sql.gz' : (ext || '.upload');
      cb(null, `backup_upload_${Date.now()}_${Math.round(Math.random() * 1e9)}${safeExt}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '');
    if (!/\.(sql\.gz|gz)$/i.test(name)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Backup files must end in .sql.gz'));
    }
    cb(null, true);
  },
});

// Exported as middleware the route file can chain in.
const uploadMiddleware = restoreUploadMulter.single('backup');

// ── Helpers ──────────────────────────────────────────────────────────────

// Minimal request-context object stashed onto audit logs. We avoid raw
// req.user/req objects to keep logger output clean and to prevent
// accidental leakage of full session objects into log files.
function auditContext(req) {
  return {
    userId: req.user?.id || null,
    ip: req.ip,
    userAgent: (req.get && req.get('user-agent')) || null,
  };
}

// Map a BackupRecord row to the JSON shape the frontend expects. Strips
// `path` — operators don't need the server-side absolute path and exposing
// it would weaken the abstraction barrier.
function publicShape(record) {
  if (!record) return null;
  const p = record.get ? record.get({ plain: true }) : record;
  return {
    id: p.id,
    filename: p.filename,
    sizeBytes: p.sizeBytes,
    trigger: p.trigger,
    status: p.status,
    // 0-100 advisory progress indicator. Always 100 on completed rows
    // (back-fill in server.js DDL), bumped by the service during runs.
    progressPercent: typeof p.progressPercent === 'number' ? p.progressPercent
      : (p.status === 'completed' ? 100 : 0),
    errorMessage: p.errorMessage,
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    completedAt: p.completedAt,
    restoredAt: p.restoredAt,
  };
}

// ── List backups ─────────────────────────────────────────────────────────

const listBackups = async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const records = await backupService.listBackups({ limit, offset });
    return res.status(200).json({
      success: true,
      data: {
        items: records.map(publicShape),
        retentionDays: backupService.RETENTION_DAYS,
      },
    });
  } catch (err) {
    safeLogger.error('[AdminBackups] list failed', { err });
    return res.status(500).json({ success: false, message: 'Failed to list backups' });
  }
};

// ── Create a manual backup ───────────────────────────────────────────────
//
// Returns 202 with the in-flight record. The job is awaited inline (so the
// client can poll for completion via the list endpoint) but the response
// fires after the row + file are durable. If the dump takes longer than
// the proxy timeout, the row still completes and the client's next list
// poll will show status='completed'.

const createBackup = async (req, res) => {
  try {
    const ctx = auditContext(req);
    safeLogger.warn('[AdminBackups] manual backup triggered', ctx);

    const record = await backupService.createBackup({
      trigger: 'manual',
      createdBy: req.user.id,
    });

    activityService.logActivity({
      action: 'created',
      description: `Manual database backup: ${record.filename}`,
      entityType: 'backup',
      entityId: record.id,
      userId: req.user.id,
    });

    return res.status(201).json({ success: true, data: publicShape(record) });
  } catch (err) {
    // Concurrency: another backup is already in flight. Map to 409 so the
    // frontend can distinguish "real failure" from "wait for the running
    // one" and avoid showing a scary red toast for a benign condition.
    if (err && err.code === 'BACKUP_ALREADY_RUNNING') {
      safeLogger.info('[AdminBackups] manual backup rejected — already running', {
        runningId: err.runningBackupId, by: req.user?.id,
      });
      return res.status(409).json({
        success: false,
        code: 'BACKUP_ALREADY_RUNNING',
        message: err.message,
        data: { runningBackupId: err.runningBackupId },
      });
    }
    safeLogger.error('[AdminBackups] manual backup failed', { err });
    // Surface the actionable message (e.g. "pg_dump not found — set
    // DB_BACKUP_VIA_DOCKER=…") directly to the Tier-1 operator. The route is
    // already gated behind superAdminOnly so this is not a privilege leak,
    // and burying the cause in /server/logs/error.log made remote debugging
    // unnecessarily hard for the very users authorised to act on it.
    const friendly = (err && err.message) ? String(err.message).slice(0, 600) : 'Backup failed';
    return res.status(500).json({
      success: false,
      message: friendly,
    });
  }
};

// ── Download ─────────────────────────────────────────────────────────────

const downloadBackup = async (req, res) => {
  const id = req.params.id;
  try {
    const { record, absolutePath, sizeBytes } = await backupService.getDownloadInfo({ recordId: id });

    activityService.logActivity({
      action: 'downloaded',
      description: `Downloaded database backup: ${record.filename}`,
      entityType: 'backup',
      entityId: record.id,
      userId: req.user.id,
    });

    safeLogger.info('[AdminBackups] download', {
      recordId: id, by: req.user.id, ip: req.ip,
    });

    // application/octet-stream (not application/gzip) so Windows doesn't
    // map the response to a registered .gz handler (e.g. WinRAR). When
    // Chromium sees application/gzip it asks the OS for the .gz handler
    // and the Save-As dialog strips ".gz" from the visible filename,
    // leaving the operator with a "<name>.sql" file that's actually gzip.
    // octet-stream keeps the dialog generic so the full ".sql.gz" name is
    // preserved verbatim.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(sizeBytes));
    // Always force a download — backups should never render inline.
    // Provide both `filename=` (legacy/ASCII) and `filename*=` (RFC 5987)
    // forms. The starred form takes precedence in every modern browser and
    // is parsed strictly, so Chromium can't reinterpret the last extension.
    const safeName = record.filename.replace(/["\\]/g, '_');
    const encodedName = encodeURIComponent(record.filename);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`
    );
    res.setHeader('Cache-Control', 'no-store');
    // Defence-in-depth: tell Chromium not to sniff the bytes and guess a
    // different content type that might re-trigger the WinRAR mapping.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const stream = fs.createReadStream(absolutePath);
    stream.on('error', (err) => {
      safeLogger.error('[AdminBackups] download stream error', { recordId: id, err });
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Backup not found' });
    if (err.code === 'BACKUP_NOT_READY') return res.status(409).json({ success: false, message: 'Backup is not in a completed state' });
    if (err.code === 'FILE_MISSING') return res.status(410).json({ success: false, message: 'Backup file no longer exists on disk' });
    if (err.code === 'PATH_TRAVERSAL') return res.status(400).json({ success: false, message: 'Invalid backup path' });
    safeLogger.error('[AdminBackups] download failed', { recordId: id, err });
    return res.status(500).json({ success: false, message: 'Download failed' });
  }
};

// ── Delete ───────────────────────────────────────────────────────────────

const deleteBackup = async (req, res) => {
  const id = req.params.id;
  try {
    safeLogger.warn('[AdminBackups] delete triggered', {
      recordId: id, by: req.user.id, ip: req.ip,
    });

    // Fetch first so we can log the filename in the activity row even
    // after the row is gone.
    const { BackupRecord } = require('../models');
    const existing = await BackupRecord.findByPk(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Backup not found' });

    await backupService.deleteBackup({ recordId: id, actingUser: req.user });

    activityService.logActivity({
      action: 'deleted',
      description: `Deleted database backup: ${existing.filename}`,
      entityType: 'backup',
      entityId: id,
      userId: req.user.id,
    });

    return res.status(200).json({ success: true, data: { id } });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Backup not found' });
    if (err.code === 'PATH_TRAVERSAL') return res.status(400).json({ success: false, message: 'Invalid backup path' });
    safeLogger.error('[AdminBackups] delete failed', { recordId: id, err });
    return res.status(500).json({ success: false, message: 'Delete failed' });
  }
};

// ── Restore from an existing record ──────────────────────────────────────
//
// Requires a typed confirmation phrase in the request body. The same gate
// is enforced in the UI; the backend check is the authoritative one and
// must NEVER be removed because the UI lives.

const RESTORE_CONFIRM_PHRASE = 'RESTORE DATABASE';

function hasValidConfirmation(req) {
  const phrase = String(req.body?.confirmation || req.body?.confirm || '').trim();
  return phrase === RESTORE_CONFIRM_PHRASE;
}

const restoreBackup = async (req, res) => {
  const id = req.params.id;
  if (!hasValidConfirmation(req)) {
    return res.status(400).json({
      success: false,
      code: 'CONFIRMATION_REQUIRED',
      message: `Restore requires confirmation. Send body { "confirmation": "${RESTORE_CONFIRM_PHRASE}" }.`,
    });
  }

  try {
    safeLogger.warn('[AdminBackups] restore triggered', {
      recordId: id, by: req.user.id, ip: req.ip, userAgent: req.get && req.get('user-agent'),
    });

    activityService.logActivity({
      action: 'restore_initiated',
      description: `Initiated restore from backup ${id}`,
      entityType: 'backup',
      entityId: id,
      userId: req.user.id,
      meta: { ip: req.ip, userAgent: req.get && req.get('user-agent') },
    });

    const result = await backupService.restoreFromRecord({
      recordId: id,
      actingUser: req.user,
    });

    activityService.logActivity({
      action: 'restore_completed',
      description: `Restored database from backup ${result.record.filename}`,
      entityType: 'backup',
      entityId: id,
      userId: req.user.id,
      meta: { preRestoreId: result.preRestoreId },
    });

    return res.status(200).json({
      success: true,
      data: {
        record: publicShape(result.record),
        preRestoreBackupId: result.preRestoreId,
      },
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ success: false, message: 'Backup not found' });
    if (err.code === 'BACKUP_NOT_READY') return res.status(409).json({ success: false, message: 'Backup is not in a completed state' });
    if (err.code === 'PATH_TRAVERSAL') return res.status(400).json({ success: false, message: 'Invalid backup path' });
    if (err.code === 'RESTORE_FAILED') {
      activityService.logActivity({
        action: 'restore_failed',
        description: `Restore failed: ${err.message?.slice(0, 200)}`,
        entityType: 'backup',
        entityId: id,
        userId: req.user.id,
        meta: { preRestoreId: err.preRestoreId || null },
      });
      return res.status(500).json({
        success: false,
        message: 'Restore failed. Pre-restore safety backup is preserved.',
        data: { preRestoreBackupId: err.preRestoreId || null },
      });
    }
    safeLogger.error('[AdminBackups] restore failed', { recordId: id, err });
    return res.status(500).json({ success: false, message: 'Restore failed' });
  }
};

// ── Restore from a freshly uploaded file ─────────────────────────────────
//
// Two-step: multer accepts the file into a temp location, the service moves
// it into the upload-inbox dir + validates, then performs the restore.
// We could split this into two endpoints (upload + restore) — kept as one
// because operators uploading a foreign dump almost always want to restore
// immediately, and an orphaned upload sitting around is just dead weight.

const restoreUpload = async (req, res) => {
  if (!hasValidConfirmation(req)) {
    // Note: in multipart/form-data the confirmation comes alongside the file.
    return res.status(400).json({
      success: false,
      code: 'CONFIRMATION_REQUIRED',
      message: `Restore requires confirmation field "confirmation" = "${RESTORE_CONFIRM_PHRASE}".`,
    });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded (field name must be "backup")' });
  }

  let uploaded = null;
  try {
    safeLogger.warn('[AdminBackups] upload-restore triggered', {
      by: req.user.id, ip: req.ip, originalName: req.file.originalname,
    });

    uploaded = await backupService.acceptUpload({
      tempPath: req.file.path,
      originalName: req.file.originalname,
      actingUser: req.user,
    });

    activityService.logActivity({
      action: 'upload_accepted',
      description: `Uploaded backup file ${req.file.originalname} (${uploaded.filename})`,
      entityType: 'backup',
      entityId: uploaded.id,
      userId: req.user.id,
      meta: { ip: req.ip },
    });

    const result = await backupService.restoreFromRecord({
      recordId: uploaded.id,
      actingUser: req.user,
    });

    activityService.logActivity({
      action: 'restore_completed',
      description: `Restored database from uploaded file ${req.file.originalname}`,
      entityType: 'backup',
      entityId: uploaded.id,
      userId: req.user.id,
      meta: { preRestoreId: result.preRestoreId, original: req.file.originalname },
    });

    return res.status(200).json({
      success: true,
      data: {
        uploaded: publicShape(uploaded),
        record: publicShape(result.record),
        preRestoreBackupId: result.preRestoreId,
      },
    });
  } catch (err) {
    // Attach the uploaded record id (when we have it) so the error branch
    // below can log a properly-anchored Activity row.
    if (uploaded && !err.uploadedRecordId) err.uploadedRecordId = uploaded.id;
    // Clean up the multer temp file if the service didn't take ownership.
    try {
      if (req.file && req.file.path) {
        await fsp.unlink(req.file.path).catch(() => {});
      }
    } catch (_) { /* ignore */ }

    if (err.code === 'BAD_EXTENSION') return res.status(400).json({ success: false, message: err.message });
    if (err.code === 'BAD_GZIP') return res.status(400).json({ success: false, message: 'Uploaded file is corrupt or not a valid gzip stream.' });
    if (err.code === 'EMPTY_FILE') return res.status(400).json({ success: false, message: 'Uploaded file is empty.' });
    if (err.code === 'RESTORE_FAILED') {
      // We only have an entityId to log if acceptUpload already produced
      // an `uploaded` record. When it did, err.uploadedRecordId is set
      // by the service; otherwise skip the activity row (the safeLogger
      // line below carries the full diagnostic).
      const failedEntityId = err.uploadedRecordId || null;
      if (failedEntityId) {
        activityService.logActivity({
          action: 'restore_failed',
          description: `Restore from uploaded file failed: ${(err.message || '').slice(0, 200)}`,
          entityType: 'backup',
          entityId: failedEntityId,
          userId: req.user.id,
          meta: { preRestoreId: err.preRestoreId || null },
        });
      }
      safeLogger.error('[AdminBackups] upload-restore: restore step failed', { err });
      return res.status(500).json({
        success: false,
        message: 'Restore failed. Pre-restore safety backup is preserved.',
        data: { preRestoreBackupId: err.preRestoreId || null },
      });
    }
    safeLogger.error('[AdminBackups] upload-restore failed', { err });
    return res.status(500).json({ success: false, message: 'Upload-restore failed' });
  }
};

module.exports = {
  listBackups,
  createBackup,
  downloadBackup,
  deleteBackup,
  restoreBackup,
  restoreUpload,
  uploadMiddleware,
  // Exported for tests so they can assert what the route file requires:
  RESTORE_CONFIRM_PHRASE,
};
