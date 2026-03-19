const express = require('express');
const { authenticate } = require('../middleware/auth');
const { upload, handleMulterError } = require('../middleware/upload');
const {
  uploadFile,
  getFiles,
  deleteFile,
  downloadFile,
} = require('../controllers/fileController');

const router = express.Router();

// All file routes require authentication
router.use(authenticate);

// ─── POST /api/files (multipart upload, field name: "file") ──
router.post('/', upload.single('file'), handleMulterError, uploadFile);

// ─── GET /api/files?taskId=<uuid> ────────────────────────────
router.get('/', getFiles);

// ─── DELETE /api/files/:id ───────────────────────────────────
router.delete('/:id', deleteFile);

// ─── GET /api/files/:id/download ─────────────────────────────
router.get('/:id/download', downloadFile);

module.exports = router;
