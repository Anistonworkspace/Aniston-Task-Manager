/**
 * Uploaded-files backup service.
 *
 * Mirrors backupService.js (the database-dump service) but for the
 * `uploads/` directory — the physical file bytes (avatars, task
 * attachments, comment attachments, voice-note audio) that `pg_dump`
 * does NOT capture. The database only stores pointers (filename/path)
 * to these files; without this archive a DB restore would leave every
 * attachment row dangling.
 *
 * Why a fully separate service + table (file_backup_records)
 * ----------------------------------------------------------
 *   The database-backup subsystem (backupService.js / backup_records) is
 *   intentionally left UNTOUCHED. A files backup:
 *     • has its own concurrency lock (a running files backup never blocks
 *       a DB backup and vice-versa),
 *     • has its own retention pass,
 *     • is listed from its own table,
 *   so a bug here can never corrupt the DB-backup catalog or its flow.
 *
 * Archive format: gzipped tar (`.tar.gz`) of the uploads directory
 * contents, produced by the pure-JS `tar` npm package. We deliberately do
 * NOT shell out to a system `tar`/`gzip` binary: the production image is
 * Alpine (busybox tar) but local dev is Windows (no gzip on PATH — the
 * reason the DB backup has to route through `docker exec`). The JS `tar`
 * package uses Node's zlib internally, so it behaves identically on every
 * platform with zero external-binary dependency.
 *
 * Restore semantics (overlay, not wipe)
 * -------------------------------------
 *   Restore extracts the archive over the live uploads directory: files
 *   present in the archive are recreated/overwritten; files added AFTER
 *   the backup are left in place. We never delete the uploads dir first —
 *   a true point-in-time wipe-and-replace is far more dangerous and is not
 *   what an operator recovering a lost attachment wants. A pre-restore
 *   safety archive of the CURRENT uploads dir is always taken first.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const tar = require('tar');
const { Op } = require('sequelize');
const { FileBackupRecord } = require('../models');
const { getUploadDir } = require('../middleware/upload');
const safeLogger = require('../utils/safeLogger');

// ─── Configuration ──────────────────────────────────────────────────────
//
// Reuse the same BACKUP_ROOT volume the DB backups live under, but in a
// dedicated `files*` subtree so the two never share a directory.
const backupService = require('./backupService');
const BACKUP_ROOT = backupService.BACKUP_ROOT;

const FILE_BACKUP_DIR = path.join(BACKUP_ROOT, 'files');
const FILE_PRE_RESTORE_DIR = path.join(BACKUP_ROOT, 'files-pre-restore');
const FILE_UPLOAD_INBOX_DIR = path.join(BACKUP_ROOT, 'files-uploads-inbox');

// Retention applies ONLY to scheduled files backups. Manual / pre_restore /
// uploaded archives are never auto-pruned. Independent env from the DB
// retention so ops can tune them separately.
const RETENTION_DAYS = Math.max(
  1,
  parseInt(process.env.FILE_BACKUP_RETENTION_DAYS, 10) || 30
);

// Hard ceiling on a single archive run. uploads/ can be large; default
// generous, overridable.
const BACKUP_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.FILE_BACKUP_TIMEOUT_MS, 10);
  if (Number.isFinite(raw) && raw > 5_000) return raw;
  return process.env.NODE_ENV === 'production' ? 30 * 60 * 1000 : 10 * 60 * 1000;
})();

// gzip compression level for the tar stream. 6 is the zlib default — a good
// size/CPU trade-off. Uploads are mostly already-compressed media (jpg/png/
// pdf), so a higher level buys little.
const GZIP_LEVEL = (() => {
  const raw = parseInt(process.env.FILE_BACKUP_GZIP_LEVEL, 10);
  return Number.isFinite(raw) && raw >= 0 && raw <= 9 ? raw : 6;
})();

// Filename validation regex — defence-in-depth before any path resolution.
const FILENAME_RE = /^files_[a-z_]+_\d{8}_\d{6}_[a-f0-9]{16}\.tar\.gz$/;

// Cap kept in the errorMessage column for failures.
const ERR_KEEP_BYTES = 4 * 1024;

// ─── Directory bootstrap ─────────────────────────────────────────────────

async function ensureDirectories() {
  await fsp.mkdir(FILE_BACKUP_DIR, { recursive: true });
  await fsp.mkdir(FILE_PRE_RESTORE_DIR, { recursive: true });
  await fsp.mkdir(FILE_UPLOAD_INBOX_DIR, { recursive: true });
}

// Reject any path that doesn't resolve inside one of our files-backup roots.
function assertInsideBackupRoot(unsafePath) {
  const resolved = path.resolve(unsafePath);
  const allowedRoots = [FILE_BACKUP_DIR, FILE_PRE_RESTORE_DIR, FILE_UPLOAD_INBOX_DIR];
  const ok = allowedRoots.some((root) => {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    return resolved === root || resolved.startsWith(rootWithSep);
  });
  if (!ok) {
    const err = new Error('Path outside allowed backup directory');
    err.code = 'PATH_TRAVERSAL';
    throw err;
  }
  return resolved;
}

// ─── Filename generation ─────────────────────────────────────────────────

function buildFilename(trigger) {
  const safeTrigger = String(trigger || 'manual').replace(/[^a-z_]/gi, '').toLowerCase() || 'manual';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    '_' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  const rand = crypto.randomBytes(8).toString('hex');
  return `files_${safeTrigger}_${stamp}_${rand}.tar.gz`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

// Resolve the live uploads directory we are backing up. Falls back to the
// repo-relative default when no storage provider is configured.
function resolveUploadsDir() {
  try {
    const dir = getUploadDir();
    if (dir) return path.resolve(dir);
  } catch (_) { /* provider not ready — fall through */ }
  return path.resolve(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
}

// Returns the active storage-provider name ('local', 's3', …) or null. Used
// only to warn when a files backup is run against a non-local provider — in
// that case the upload bytes live in object storage, not on this disk, so the
// archive would be near-empty and misleading. We still proceed (archiving
// whatever the provider's local temp/cache dir holds) but log loudly.
function activeProviderName() {
  try {
    return require('./storage').getProvider().name || null;
  } catch (_) {
    return null;
  }
}

// Count files + total bytes under a directory, so we can (a) skip an empty
// uploads dir gracefully and (b) anchor the progress estimate. Bounded
// recursion; symlinks are not followed (tar below also won't follow them).
async function measureDir(dir) {
  let files = 0;
  let bytes = 0;
  async function walk(d) {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        files += 1;
        try {
          const st = await fsp.stat(full);
          bytes += st.size;
        } catch (_) { /* race: file removed mid-walk — ignore */ }
      }
    }
  }
  await walk(dir);
  return { files, bytes };
}

// ─── Core: create a files backup ─────────────────────────────────────────
//
// tar.gz the uploads directory CONTENTS (relative to the uploads dir itself,
// so restore extracts cleanly back into it). Marks the row completed only
// after the archive passes validation (exists + non-empty + gzip-decodable).

async function createFilesBackup({ trigger = 'manual', createdBy = null } = {}) {
  await ensureDirectories();

  if (!['scheduled', 'manual', 'pre_restore'].includes(trigger)) {
    throw new Error(`Invalid trigger: ${trigger}`);
  }

  // Concurrency lock — scoped to THIS table only, so it is fully independent
  // from database backups. pre_restore is exempt (it's part of an atomic
  // restore the operator explicitly initiated).
  if (trigger !== 'pre_restore') {
    const inFlight = await FileBackupRecord.findOne({ where: { status: 'running' } });
    if (inFlight) {
      const err = new Error(
        `Another files backup is already running (id=${inFlight.id}, started ${new Date(inFlight.createdAt).toISOString()}). Wait for it to finish.`
      );
      err.code = 'BACKUP_ALREADY_RUNNING';
      err.runningBackupId = inFlight.id;
      throw err;
    }
  }

  const uploadsDir = resolveUploadsDir();
  // Make sure the source exists — a missing uploads dir is not an error
  // (fresh install), we just archive an empty tree.
  await fsp.mkdir(uploadsDir, { recursive: true }).catch(() => {});

  // Warn if uploads are NOT on local disk (e.g. STORAGE_PROVIDER=s3): the
  // bytes live in object storage and this archive won't contain them. The
  // backup still runs (over whatever local temp/cache dir the provider uses)
  // so the operator gets a record, but the log makes the limitation explicit.
  const provider = activeProviderName();
  if (provider && provider !== 'local') {
    safeLogger.warn('[FileBackupService] uploads are on a non-local storage provider — files archive may be near-empty', {
      provider, uploadsDir,
    });
  }

  const filename = buildFilename(trigger);
  const targetDir = trigger === 'pre_restore' ? FILE_PRE_RESTORE_DIR : FILE_BACKUP_DIR;
  const fullPath = path.join(targetDir, filename);
  assertInsideBackupRoot(fullPath);

  const record = await FileBackupRecord.create({
    filename,
    path: fullPath,
    trigger,
    status: 'running',
    createdBy,
    progressPercent: 0,
  });

  safeLogger.info('[FileBackupService] files backup started', {
    id: record.id, filename, trigger, createdBy, uploadsDir, timeoutMs: BACKUP_TIMEOUT_MS,
  });

  // ── Throttled progress writer (same shape as backupService) ──────────
  let lastPersistedPct = 0;
  let lastWriteAt = 0;
  let pendingPct = null;
  let writeInFlight = false;
  async function updateProgress(pct) {
    const clamped = Math.max(0, Math.min(100, Math.floor(pct)));
    if (clamped <= lastPersistedPct) return;
    pendingPct = clamped;
    const now = Date.now();
    if (writeInFlight) return;
    if (now - lastWriteAt < 1000 && clamped < 100) return;
    writeInFlight = true;
    try {
      const val = pendingPct;
      pendingPct = null;
      lastWriteAt = Date.now();
      lastPersistedPct = val;
      await FileBackupRecord.update({ progressPercent: val }, { where: { id: record.id } });
    } catch (_) { /* advisory */ } finally {
      writeInFlight = false;
      if (pendingPct != null && pendingPct > lastPersistedPct) {
        setTimeout(() => updateProgress(pendingPct), 1000);
      }
    }
  }

  let timedOut = false;
  let timeoutHandle = null;

  try {
    await updateProgress(5);

    // Count files for the audit note and to handle an empty tree gracefully.
    const { files } = await measureDir(uploadsDir);

    // Size anchor for a smooth progress bar: the most recent completed
    // archive's compressed size. tar v7's `onentry` does NOT fire in create
    // mode, so (like the DB backup) we estimate progress by polling the
    // OUTPUT file's growth against this anchor rather than counting entries.
    const sizeAnchor = await FileBackupRecord.findOne({
      where: { status: 'completed' },
      order: [['createdAt', 'DESC']],
      attributes: ['sizeBytes'],
    }).catch(() => null);
    const anchorBytes = sizeAnchor?.sizeBytes ? Number(sizeAnchor.sizeBytes) : 0;

    await updateProgress(10);

    // Poll the growing archive file for a 10→80 progress estimate. Cleared in
    // the finally below so it never outlives the create.
    const progressTimer = setInterval(() => {
      fsp.stat(fullPath).then((s) => {
        if (anchorBytes > 0) {
          const frac = Math.min(1, s.size / anchorBytes);
          updateProgress(10 + Math.floor(70 * frac)); // 10 → 80
        } else if (s.size > 0 && lastPersistedPct < 30) {
          updateProgress(30); // no anchor — hold mid-bar until checkpoints take over
        }
      }).catch(() => { /* file not created yet — ignore */ });
    }, 700);

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      safeLogger.warn('[FileBackupService] files backup timed out', { id: record.id });
    }, BACKUP_TIMEOUT_MS);

    // tar.create with `file` returns a Promise that resolves when the archive
    // is fully written and closed. `filter` soft-aborts adding new entries if
    // the timeout fired; the post-create check below then fails the run so a
    // truncated archive is never marked completed.
    // Archive the directory CONTENTS via '.' (relative to cwd=uploadsDir) so
    // restore extracts cleanly back into uploads/. '.' also tolerates an
    // empty uploads dir — an explicit empty entry list throws "no paths
    // specified". `filter` excludes nothing in the normal path; it soft-aborts
    // (returns false) once the timeout fires.
    try {
      await tar.create(
        {
          gzip: { level: GZIP_LEVEL },
          file: fullPath,
          cwd: uploadsDir,
          follow: false,   // archive symlinks as links, don't escape the tree
          portable: true,  // stable headers; tolerate files vanishing mid-run
          filter: () => !timedOut,
        },
        ['.']
      );
    } finally {
      clearInterval(progressTimer);
    }

    clearTimeout(timeoutHandle); timeoutHandle = null;
    if (timedOut) throw new Error(`Files backup exceeded ${BACKUP_TIMEOUT_MS / 1000}s timeout and was aborted.`);

    await updateProgress(88);

    // Validate: file exists + non-empty. (A valid gzip of an empty tar is
    // ~45 bytes, so size 0 always means a real failure.)
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`Archive file invalid: size=${stat.size}`);
    }

    // Integrity: stream the archive through tar's parser (which gunzips +
    // validates the tar structure). Throws on CRC/truncation errors.
    await updateProgress(94);
    await validateArchive(fullPath);

    record.sizeBytes = stat.size;
    record.status = 'completed';
    record.completedAt = new Date();
    record.progressPercent = 100;
    // Stash a tiny audit note: how many files were archived.
    record.errorMessage = `files=${files}`;
    await record.save();

    safeLogger.info('[FileBackupService] files backup completed', {
      id: record.id, filename, sizeBytes: stat.size, files, trigger,
      durationMs: Date.now() - new Date(record.createdAt).getTime(),
    });

    return record;
  } catch (err) {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    // Clean up the partial archive so a half-written file can't be restored.
    try { await fsp.unlink(fullPath); } catch (_) { /* ignore */ }

    const message = (err && err.message) ? String(err.message).slice(0, ERR_KEEP_BYTES) : 'Unknown files-backup failure';
    record.status = 'failed';
    record.errorMessage = message;
    record.completedAt = new Date();
    try { await record.save(); } catch (_) { /* secondary */ }

    safeLogger.error('[FileBackupService] files backup failed', { id: record.id, filename, trigger, err, timedOut });

    const friendly = new Error(message);
    friendly.code = err && err.code;
    friendly.cause = err;
    throw friendly;
  }
}

// Validate a .tar.gz by fully reading it through tar's gunzip+parse pipeline.
// Resolves on success; rejects on any decode/structure error.
function validateArchive(archivePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(archivePath);
    const parser = new tar.Parser({ gzip: true });
    stream.on('error', reject);
    parser.on('error', reject);
    parser.on('end', resolve);
    // Drain entries — we don't need them, just confirm they decode.
    parser.on('entry', (entry) => entry.resume());
    stream.pipe(parser);
  });
}

// ─── Core: restore from a files backup (overlay) ─────────────────────────

async function restoreFilesFromRecord({ recordId, actingUser, options = {} }) {
  const record = await FileBackupRecord.findByPk(recordId);
  if (!record) {
    const err = new Error('Files backup not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (record.status !== 'completed') {
    const err = new Error('Files backup is not in a completed state');
    err.code = 'BACKUP_NOT_READY';
    throw err;
  }

  const resolved = assertInsideBackupRoot(record.path);
  const uploadsDir = resolveUploadsDir();
  await fsp.mkdir(uploadsDir, { recursive: true }).catch(() => {});

  safeLogger.warn('[FileBackupService] files restore initiated', {
    recordId, filename: record.filename, by: actingUser?.id,
  });

  // 1) Pre-restore safety archive of CURRENT uploads. Abort before touching
  // disk if it fails.
  let preRestore = null;
  if (options.skipPreRestoreBackup !== true) {
    preRestore = await createFilesBackup({
      trigger: 'pre_restore',
      createdBy: actingUser?.id || null,
    });
  }

  // 2) Extract the archive over the uploads dir (overlay — see file header).
  try {
    await tar.extract({
      file: resolved,
      cwd: uploadsDir,
      // Defence in depth: refuse absolute paths / `..` escapes inside the
      // archive (tar strips these by default, but be explicit).
      strip: 0,
      preservePaths: false,
      // Don't clobber newer files outside the archive; entries in the
      // archive still overwrite their counterparts.
    });
  } catch (err) {
    const e = new Error(`Files restore extraction failed: ${(err.message || '').slice(0, ERR_KEEP_BYTES)}`);
    e.code = 'RESTORE_FAILED';
    e.preRestoreId = preRestore?.id || null;
    throw e;
  }

  record.restoredAt = new Date();
  await record.save();

  safeLogger.warn('[FileBackupService] files restore completed', {
    recordId, filename: record.filename, by: actingUser?.id, preRestoreId: preRestore?.id,
  });

  return { record, preRestoreId: preRestore?.id || null };
}

// ─── Uploads: persist + validate an operator-supplied archive ────────────

async function acceptUpload({ tempPath, originalName, actingUser }) {
  await ensureDirectories();

  const safeOriginalName = String(originalName || '').slice(0, 255);
  if (!/\.(tar\.gz|tgz)$/i.test(safeOriginalName)) {
    const err = new Error('Uploaded file must end in .tar.gz');
    err.code = 'BAD_EXTENSION';
    throw err;
  }

  const filename = buildFilename('uploaded');
  const dest = path.join(FILE_UPLOAD_INBOX_DIR, filename);
  assertInsideBackupRoot(dest);

  try {
    await fsp.rename(tempPath, dest);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await new Promise((resolve, reject) => {
        const rd = fs.createReadStream(tempPath);
        const wr = fs.createWriteStream(dest, { mode: 0o600 });
        rd.on('error', reject);
        wr.on('error', reject);
        wr.on('finish', resolve);
        rd.pipe(wr);
      });
      try { await fsp.unlink(tempPath); } catch (_) { /* ignore */ }
    } else {
      throw err;
    }
  }
  try { await fsp.chmod(dest, 0o600); } catch (_) { /* not fatal */ }

  // Validate the archive decodes before exposing it as a restore target.
  try {
    await validateArchive(dest);
  } catch (err) {
    try { await fsp.unlink(dest); } catch (_) { /* ignore */ }
    const e = new Error('Uploaded file is corrupt or not a valid .tar.gz archive.');
    e.code = 'BAD_ARCHIVE';
    throw e;
  }

  const stat = await fsp.stat(dest);
  if (stat.size === 0) {
    try { await fsp.unlink(dest); } catch (_) { /* ignore */ }
    const err = new Error('Uploaded file is empty');
    err.code = 'EMPTY_FILE';
    throw err;
  }

  const record = await FileBackupRecord.create({
    filename,
    path: dest,
    sizeBytes: stat.size,
    trigger: 'uploaded',
    status: 'completed',
    completedAt: new Date(),
    errorMessage: `original=${safeOriginalName}`,
    createdBy: actingUser?.id || null,
  });

  safeLogger.info('[FileBackupService] upload accepted', {
    id: record.id, filename, sizeBytes: stat.size, by: actingUser?.id, original: safeOriginalName,
  });

  return record;
}

// ─── Delete ──────────────────────────────────────────────────────────────

async function deleteFileBackup({ recordId, actingUser }) {
  const record = await FileBackupRecord.findByPk(recordId);
  if (!record) {
    const err = new Error('Files backup not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  let resolved;
  try {
    resolved = assertInsideBackupRoot(record.path);
  } catch (err) {
    safeLogger.error('[FileBackupService] delete blocked — path outside backup root', {
      recordId, path: record.path,
    });
    throw err;
  }

  try {
    await fsp.unlink(resolved);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    safeLogger.warn('[FileBackupService] file already gone; removing row', { recordId, path: resolved });
  }

  await record.destroy();
  safeLogger.info('[FileBackupService] files backup deleted', {
    recordId, filename: record.filename, by: actingUser?.id,
  });
  return { id: recordId };
}

// ─── Download info ─────────────────────────────────────────────────────────

async function getDownloadInfo({ recordId }) {
  const record = await FileBackupRecord.findByPk(recordId);
  if (!record) {
    const err = new Error('Files backup not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (record.status !== 'completed') {
    const err = new Error('Files backup is not in a completed state');
    err.code = 'BACKUP_NOT_READY';
    throw err;
  }
  const resolved = assertInsideBackupRoot(record.path);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) {
    const err = new Error('Archive file missing on disk');
    err.code = 'FILE_MISSING';
    throw err;
  }
  return { record, absolutePath: resolved, sizeBytes: stat.size };
}

// ─── Retention ─────────────────────────────────────────────────────────────

async function applyRetentionPolicy() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await FileBackupRecord.findAll({
    where: {
      trigger: 'scheduled',
      createdAt: { [Op.lt]: cutoff },
    },
    order: [['createdAt', 'ASC']],
  });

  let deleted = 0;
  for (const record of candidates) {
    try {
      await deleteFileBackup({ recordId: record.id, actingUser: null });
      deleted++;
    } catch (err) {
      safeLogger.warn('[FileBackupService] retention delete failed', { recordId: record.id, err });
    }
  }
  if (deleted > 0) {
    safeLogger.info('[FileBackupService] retention pass complete', { deleted, retentionDays: RETENTION_DAYS });
  }
  return { deleted, retentionDays: RETENTION_DAYS };
}

// ─── Startup recovery ───────────────────────────────────────────────────────

async function recoverStaleRunningBackups({ minAgeSeconds = 60 } = {}) {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000);
  const stale = await FileBackupRecord.findAll({
    where: { status: 'running', createdAt: { [Op.lt]: cutoff } },
  });
  if (stale.length === 0) return { recovered: 0 };

  for (const row of stale) {
    row.status = 'failed';
    row.errorMessage = 'Files backup was interrupted before completion (server restart or crash).';
    row.completedAt = new Date();
    try {
      const resolved = assertInsideBackupRoot(row.path);
      await fsp.unlink(resolved).catch(() => {});
    } catch (_) { /* path outside backup root — skip cleanup */ }
    try { await row.save(); } catch (_) { /* secondary */ }
  }
  safeLogger.warn('[FileBackupService] stale running files backups recovered', {
    count: stale.length, ids: stale.map((r) => r.id),
  });
  return { recovered: stale.length };
}

// ─── Listing ────────────────────────────────────────────────────────────────

async function listBackups({ limit = 100, offset = 0 } = {}) {
  return FileBackupRecord.findAll({
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });
}

module.exports = {
  // Config & paths
  BACKUP_ROOT,
  FILE_BACKUP_DIR,
  FILE_PRE_RESTORE_DIR,
  FILE_UPLOAD_INBOX_DIR,
  RETENTION_DAYS,
  BACKUP_TIMEOUT_MS,
  FILENAME_RE,

  // Operations
  ensureDirectories,
  resolveUploadsDir,
  createFilesBackup,
  restoreFilesFromRecord,
  acceptUpload,
  deleteFileBackup,
  getDownloadInfo,
  applyRetentionPolicy,
  listBackups,
  recoverStaleRunningBackups,
};
