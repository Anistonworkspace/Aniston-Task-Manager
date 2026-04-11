const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  createUpload,
  handleMulterError,
  postUploadValidation,
  setCategoryMiddleware,
} = require('../middleware/upload');
const {
  uploadFile,
  uploadGeneral,
  getFiles,
  deleteFile,
  downloadFile,
} = require('../controllers/fileController');

const router = express.Router();

// All file routes require authentication
router.use(authenticate);

// Category-specific multer instances
const taskUpload = createUpload('task_attachment');
const generalUpload = createUpload('general');
const planUpload = createUpload('plan_attachment');

// ─── POST /api/files (task attachment upload) ───────────────────────
router.post(
  '/',
  setCategoryMiddleware('task_attachment'),
  taskUpload.single('file'),
  handleMulterError,
  postUploadValidation('task_attachment'),
  uploadFile,
);

// ─── POST /api/files/upload-general (no taskId required) ────────────
router.post(
  '/upload-general',
  setCategoryMiddleware('general'),
  generalUpload.single('file'),
  handleMulterError,
  postUploadValidation('general'),
  uploadGeneral,
);

// ─── POST /api/files/upload-plan (director plan attachments) ────────
router.post(
  '/upload-plan',
  setCategoryMiddleware('plan_attachment'),
  planUpload.single('file'),
  handleMulterError,
  postUploadValidation('plan_attachment'),
  uploadGeneral,
);

// ─── GET /api/files?taskId=<uuid> ──────────────────────────────────
router.get('/', getFiles);

// ─── DELETE /api/files/:id ─────────────────────────────────────────
router.delete('/:id', deleteFile);

// ─── GET /api/files/:id/download ───────────────────────────────────
router.get('/:id/download', downloadFile);

module.exports = router;
