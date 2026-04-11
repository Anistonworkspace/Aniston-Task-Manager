/**
 * Multer upload middleware — refactored to use centralized file-type
 * config and storage-provider abstraction.
 *
 * Exports a factory function `createUpload(category)` that returns
 * a middleware chain tailored to a specific upload category.
 * Also exports the legacy `upload` instance for backward compatibility.
 */

const multer = require('multer');
const path = require('path');
const { getProvider } = require('../services/storage');
const {
  getAllowedMimesForCategory,
  getMaxSizeForCategory,
  BLOCKED_EXTENSIONS,
} = require('../config/fileTypes');
const {
  validateFileType,
  validateFileSize,
  validateMagicBytes,
  cleanupOnError,
} = require('../services/storageService');

// ── Helpers ─────────────────────────────────────────────────────────

/** Resolve the upload directory from the active storage provider. */
function getUploadDir() {
  const provider = getProvider();
  // LocalStorageProvider exposes uploadDir; remote providers still
  // need a temp dir for multer — fall back to OS temp.
  return provider.uploadDir || require('os').tmpdir();
}

// ── Multer disk storage (shared across all categories) ──────────────

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, getUploadDir());
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  },
});

// ── Category-aware file filter factory ──────────────────────────────

function createFileFilter(category) {
  const allowedMimes = getAllowedMimesForCategory(category);
  return (_req, file, cb) => {
    // Quick block on dangerous extensions
    const ext = path.extname(file.originalname || '').toLowerCase().replace(/^\./, '');
    if (BLOCKED_EXTENSIONS.includes(ext)) {
      return cb(
        new multer.MulterError('LIMIT_UNEXPECTED_FILE', `File type .${ext} is blocked for security reasons.`),
        false,
      );
    }
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new multer.MulterError(
          'LIMIT_UNEXPECTED_FILE',
          `File type ${file.mimetype} (.${ext}) is not allowed for this upload. Allowed formats depend on the upload category.`,
        ),
        false,
      );
    }
  };
}

// ── Factory: create a multer instance for a specific category ───────

/**
 * Returns a multer instance configured for the given upload category.
 *
 * @param {string} category - One of the keys from UPLOAD_CATEGORIES
 * @returns {multer.Multer}
 */
function createUpload(category = 'general') {
  return multer({
    storage,
    fileFilter: createFileFilter(category),
    limits: {
      fileSize: getMaxSizeForCategory(category),
      files: 5,
    },
  });
}

// ── Legacy default upload (uses 'general' category) ─────────────────
const upload = createUpload('general');

// ── Multer error handler ────────────────────────────────────────────

const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    let message = 'File upload error.';
    switch (err.code) {
      case 'LIMIT_FILE_SIZE': {
        const category = req._uploadCategory || 'general';
        const maxMB = Math.round(getMaxSizeForCategory(category) / (1024 * 1024));
        message = `File too large. Maximum size is ${maxMB}MB.`;
        break;
      }
      case 'LIMIT_FILE_COUNT':
        message = 'Too many files. Maximum 5 files per upload.';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = err.field || 'Unexpected or unsupported file type.';
        break;
      default:
        message = err.message;
    }
    return res.status(400).json({ success: false, message });
  }
  next(err);
};

// ── Post-upload validation middleware ────────────────────────────────

/**
 * Factory that returns a middleware to validate the uploaded file
 * against the given category's policies (extension, MIME, size, magic bytes).
 *
 * Usage in routes:
 *   router.post('/', setCat('task_attachment'), catUpload.single('file'),
 *     handleMulterError, postUploadValidation('task_attachment'), controller);
 */
function postUploadValidation(category = 'general') {
  return (req, res, next) => {
    if (!req.file) return next();

    // Tag category on request for downstream use
    req._uploadCategory = category;

    // 1. Extension + MIME check (redundant safety — multer filter may miss edge cases)
    const typeResult = validateFileType(req.file, category);
    if (!typeResult.valid) {
      cleanupOnError(req.file);
      return res.status(400).json({ success: false, message: typeResult.message });
    }

    // 2. Size check (multer already enforces, but double-check for category overrides)
    const sizeResult = validateFileSize(req.file, category);
    if (!sizeResult.valid) {
      cleanupOnError(req.file);
      return res.status(400).json({ success: false, message: sizeResult.message });
    }

    // 3. Magic-byte signature check
    const magicResult = validateMagicBytes(req.file.path, req.file.originalname);
    if (!magicResult.valid) {
      cleanupOnError(req.file);
      return res.status(400).json({ success: false, message: magicResult.message });
    }

    next();
  };
}

/**
 * Legacy validateFileSignature middleware — preserved for backward compat.
 * Now delegates to the centralized magic-bytes check.
 */
function validateFileSignature(req, res, next) {
  if (!req.file) return next();
  const result = validateMagicBytes(req.file.path, req.file.originalname);
  if (!result.valid) {
    cleanupOnError(req.file);
    return res.status(400).json({ success: false, message: result.message });
  }
  next();
}

// ── Convenience: set category on req before multer runs ─────────────

function setCategoryMiddleware(category) {
  return (req, _res, next) => {
    req._uploadCategory = category;
    next();
  };
}

// ── Exports ─────────────────────────────────────────────────────────

// uploadDir exported for backward compat (server.js static serving, etc.)
const uploadDir = getUploadDir();

module.exports = {
  upload,                   // legacy default multer instance
  createUpload,             // factory for category-specific multer
  handleMulterError,
  validateFileSignature,    // legacy compat
  postUploadValidation,     // new: full post-upload validation per category
  setCategoryMiddleware,
  uploadDir,
  getUploadDir,
};
