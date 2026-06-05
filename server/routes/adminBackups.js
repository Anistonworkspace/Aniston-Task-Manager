/**
 * Tier-1 (Super Admin) database backup routes.
 *
 * Every endpoint is gated by `authenticate` + `superAdminOnly`. The latter
 * resolves to `resolveTier(user) === TIER_1` — regular admins (T2) are
 * explicitly excluded. This is the only auth surface this module has;
 * never relax it.
 *
 * Endpoint mounting point (see server.js): /api/admin/backups
 *   GET    /database                       — list backups
 *   POST   /database                       — trigger a manual backup
 *   GET    /database/:id/download          — stream the file to the browser
 *   DELETE /database/:id                   — delete a single backup
 *   POST   /database/:id/restore           — restore from an existing record
 *                                            (body: { confirmation: "RESTORE DATABASE" })
 *   POST   /database/restore-upload        — multipart upload + restore
 *                                            (field "backup", plus confirmation)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, superAdminOnly } = require('../middleware/auth');
const {
  listBackups,
  createBackup,
  downloadBackup,
  deleteBackup,
  restoreBackup,
  restoreUpload,
  uploadMiddleware,
  listFileBackups,
  createFileBackup,
  downloadFileBackup,
  deleteFileBackup,
  restoreFileBackup,
  restoreFileUpload,
  filesUploadMiddleware,
} = require('../controllers/adminBackupsController');

const router = express.Router();

// Aggressive rate limit on the destructive endpoints — even for Tier 1.
// A misclick spam on Create-DB-Backup would consume disk and IO; restore
// loops would thrash the DB. Limits are generous enough for normal ops.
const mutatingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many backup operations. Slow down.' },
});

const restoreLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many restore attempts. Slow down.' },
});

// All routes require Tier 1. authenticate must run first so superAdminOnly
// can read req.user. Order is non-negotiable.
router.use(authenticate, superAdminOnly);

// List
router.get('/database', listBackups);

// Create a manual backup
router.post('/database', mutatingLimiter, createBackup);

// Download
router.get('/database/:id/download', downloadBackup);

// Delete a single backup
router.delete('/database/:id', mutatingLimiter, deleteBackup);

// Restore from an existing record. Requires { confirmation: "RESTORE DATABASE" }.
router.post('/database/:id/restore', restoreLimiter, restoreBackup);

// Restore from an uploaded file. multer accepts ONE file under field "backup".
// `restoreUpload` handles validation (extension, gzip integrity, etc.) inside
// the service layer — see backupService.acceptUpload.
router.post('/database/restore-upload', restoreLimiter, uploadMiddleware, restoreUpload);

// ── Files backups (uploads/ tar.gz archives) ──────────────────────────────
// Fully parallel surface to /database, backed by fileBackupService +
// file_backup_records. Same Tier-1 gate (router.use above), same limiters.
//   GET    /files                 — list files backups
//   POST   /files                 — trigger a manual files backup
//   GET    /files/:id/download    — stream the .tar.gz to the browser
//   DELETE /files/:id             — delete a single files backup
//   POST   /files/:id/restore     — restore uploads from a record
//                                   (body: { confirmation: "RESTORE FILES" })
//   POST   /files/restore-upload  — multipart upload + restore (field "backup")
router.get('/files', listFileBackups);
router.post('/files', mutatingLimiter, createFileBackup);
router.get('/files/:id/download', downloadFileBackup);
router.delete('/files/:id', mutatingLimiter, deleteFileBackup);
router.post('/files/:id/restore', restoreLimiter, restoreFileBackup);
router.post('/files/restore-upload', restoreLimiter, filesUploadMiddleware, restoreFileUpload);

module.exports = router;
