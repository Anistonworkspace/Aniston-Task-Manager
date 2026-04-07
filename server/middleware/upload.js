const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Allowed MIME types
const ALLOWED_MIMETYPES = [
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Text
  'text/plain',
  'text/csv',
  'text/markdown',
  // Archives
  'application/zip',
  'application/x-rar-compressed',
  'application/gzip',
  // Code / data
  'application/json',
  'application/xml',
  'text/xml',
];

// Max file size: 25 MB
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || 25 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new multer.MulterError(
        'LIMIT_UNEXPECTED_FILE',
        `File type ${file.mimetype} is not allowed. Allowed types: images, documents, text, archives.`
      ),
      false
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 5, // Max 5 files per request
  },
});

/**
 * Multer error handling middleware.
 * Place this AFTER the upload middleware in the route chain.
 */
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    let message = 'File upload error.';
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        message = `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / (1024 * 1024))}MB.`;
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Too many files. Maximum 5 files per upload.';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = err.field || 'Unexpected file type.';
        break;
      default:
        message = err.message;
    }
    return res.status(400).json({ success: false, message });
  }
  next(err);
};

/**
 * Validate uploaded file's magic bytes match declared MIME type.
 * Middleware to use AFTER multer processes the upload.
 */
const MAGIC_BYTES = {
  'image/jpeg': [Buffer.from([0xFF, 0xD8, 0xFF])],
  'image/png': [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
  'image/gif': [Buffer.from('GIF87a'), Buffer.from('GIF89a')],
  'application/pdf': [Buffer.from('%PDF')],
  'application/zip': [Buffer.from([0x50, 0x4B, 0x03, 0x04])],
};

function validateFileSignature(req, res, next) {
  if (!req.file) return next();
  const filePath = path.join(uploadDir, req.file.filename);
  try {
    const buffer = fs.readFileSync(filePath, { length: 8 });
    const signatures = MAGIC_BYTES[req.file.mimetype];
    if (signatures) {
      const valid = signatures.some(sig => buffer.slice(0, sig.length).equals(sig));
      if (!valid) {
        fs.unlinkSync(filePath);
        return res.status(400).json({ success: false, message: 'File content does not match declared type. Upload rejected.' });
      }
    }
  } catch (e) {
    // File read failed — reject the upload
    try { fs.unlinkSync(filePath); } catch {}
    return res.status(400).json({ success: false, message: 'File validation failed' });
  }
  next();
}

module.exports = { upload, handleMulterError, validateFileSignature, uploadDir };
