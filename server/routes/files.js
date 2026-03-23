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

// ─── POST /api/files/upload-general (no taskId required) ─────
router.post('/upload-general', upload.single('file'), handleMulterError, (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ success: true, data: { url: fileUrl, filename: req.file.filename, originalName: req.file.originalname, size: req.file.size } });
});

// ─── GET /api/files?taskId=<uuid> ────────────────────────────
router.get('/', getFiles);

// ─── DELETE /api/files/:id ───────────────────────────────────
router.delete('/:id', deleteFile);

// ─── GET /api/files/:id/download ─────────────────────────────
router.get('/:id/download', downloadFile);

module.exports = router;
