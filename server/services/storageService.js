/**
 * Centralized storage service.
 *
 * All upload / delete / URL operations go through this service,
 * which delegates to the active StorageProvider.  Controllers and
 * routes never touch the filesystem or provider directly.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getProvider } = require('./storage');
const {
  isExtensionAllowed,
  isMimeAllowed,
  getMagicBytesForExtension,
  getMaxSizeForCategory,
  getAllowedExtensionsLabel,
  BLOCKED_EXTENSIONS,
} = require('../config/fileTypes');

// ── File-name sanitisation ──────────────────────────────────────────

/**
 * Generate a safe, unique filename preserving the original extension.
 */
function generateSafeFilename(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const timestamp = Date.now();
  const rand = crypto.randomBytes(8).toString('hex');
  return `${timestamp}-${rand}${ext}`;
}

/**
 * Sanitise the original filename for safe storage / display.
 * Strips path separators and null bytes.
 */
function sanitizeOriginalName(name) {
  if (!name) return 'unnamed';
  return name
    .replace(/[\\/]/g, '_')   // strip path separators
    .replace(/\0/g, '')       // strip null bytes
    .replace(/\.\./g, '_')    // strip path traversal
    .trim() || 'unnamed';
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Validate file extension + MIME against a category policy.
 * Returns { valid: true } or { valid: false, message: string }.
 */
function validateFileType(file, category) {
  const ext = path.extname(file.originalname || '').toLowerCase().replace(/^\./, '');

  // 1. Block dangerous extensions unconditionally
  if (BLOCKED_EXTENSIONS.includes(ext)) {
    return { valid: false, message: `File type .${ext} is not allowed for security reasons.` };
  }

  // 2. Extension must be in category allowlist
  if (!isExtensionAllowed(ext, category)) {
    return {
      valid: false,
      message: `File type .${ext.toUpperCase()} is not allowed for ${category}. Allowed: ${getAllowedExtensionsLabel(category)}`,
    };
  }

  // 3. MIME must match category allowlist
  if (!isMimeAllowed(file.mimetype, category)) {
    return {
      valid: false,
      message: `MIME type ${file.mimetype} is not accepted for ${category}.`,
    };
  }

  return { valid: true };
}

/**
 * Validate file size against category limit.
 */
function validateFileSize(file, category) {
  const maxBytes = getMaxSizeForCategory(category);
  if (file.size > maxBytes) {
    const maxMB = Math.round(maxBytes / (1024 * 1024));
    return { valid: false, message: `File too large. Maximum size for ${category} is ${maxMB}MB.` };
  }
  return { valid: true };
}

/**
 * Validate file magic bytes match declared extension.
 * Should be called AFTER the file has been written to disk by multer.
 */
function validateMagicBytes(filePath, originalName) {
  const ext = path.extname(originalName || '').toLowerCase().replace(/^\./, '');
  const signatures = getMagicBytesForExtension(ext);

  // No signatures defined for this type → skip (text, code, etc.)
  if (!signatures) return { valid: true };

  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(12);
    fs.readSync(fd, buffer, 0, 12, 0);
    fs.closeSync(fd);

    const match = signatures.some(sig => {
      const slice = buffer.slice(0, sig.length);
      return slice.equals(sig);
    });

    if (!match) {
      return { valid: false, message: 'File content does not match declared type. Upload rejected.' };
    }
  } catch (err) {
    return { valid: false, message: 'File validation failed.' };
  }
  return { valid: true };
}

// ── Store / Delete / URL helpers ────────────────────────────────────

/**
 * Store a file through the active provider.
 * Returns { url, storedPath, provider }.
 */
async function storeFile({ filePath, filename, originalName, mimetype, size, category }) {
  const provider = getProvider();
  const result = await provider.store({ filePath, filename, originalName, mimetype, size, category });
  return { ...result, provider: provider.name };
}

/**
 * Delete a stored file through the active provider.
 */
async function deleteFile(filename, category) {
  const provider = getProvider();
  await provider.remove(filename, category);
}

/**
 * Check if a stored file exists.
 */
async function fileExists(filename, category) {
  const provider = getProvider();
  return provider.exists(filename, category);
}

/**
 * Resolve a stored file to an absolute path or URL (for download).
 */
async function resolveFile(filename, category) {
  const provider = getProvider();
  return provider.resolve(filename, category);
}

/**
 * Get the public/relative URL for a stored file.
 */
function getFileUrl(filename, category) {
  const provider = getProvider();
  return provider.getUrl(filename, category);
}

/**
 * Build a normalized metadata object from a multer file + category.
 */
function normalizeMetadata(multerFile, category) {
  const provider = getProvider();
  return {
    filename: multerFile.filename,
    originalName: sanitizeOriginalName(multerFile.originalname),
    mimetype: multerFile.mimetype,
    size: multerFile.size,
    extension: path.extname(multerFile.originalname || '').toLowerCase().replace(/^\./, ''),
    url: provider.getUrl(multerFile.filename),
    provider: provider.name,
    category: category || 'general',
  };
}

/**
 * Clean up a file after a failed upload — deletes from disk regardless
 * of provider (since multer always writes locally first).
 */
function cleanupOnError(multerFile) {
  if (!multerFile) return;
  try {
    const filePath = multerFile.path || path.join(getProvider().uploadDir || '', multerFile.filename);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Best-effort cleanup
  }
}

module.exports = {
  generateSafeFilename,
  sanitizeOriginalName,
  validateFileType,
  validateFileSize,
  validateMagicBytes,
  storeFile,
  deleteFile,
  fileExists,
  resolveFile,
  getFileUrl,
  normalizeMetadata,
  cleanupOnError,
};
