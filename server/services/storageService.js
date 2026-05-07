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

/**
 * Validate that an SVG file is free of executable / XSS-vector content.
 *
 * Why this exists
 * ---------------
 * SVG is XML and the browser will execute scripts inside one when the file
 * is rendered inline (e.g. <img> with `data:` URL bypass, direct GET to a
 * stored .svg, or any place we render the source). Simple magic-byte checks
 * can't see this — the audit (S-3) flagged it as the open XSS vector on
 * uploads.
 *
 * What we reject (and why)
 * ------------------------
 *   - `<script ...>` ............. inline script execution
 *   - `<foreignObject>` .......... allows embedding arbitrary HTML/iframe
 *   - `on*="..."` event handlers . onclick/onload/onerror/etc. → JS execution
 *   - `javascript:` URIs ......... in href/src/xlink:href
 *   - `<!ENTITY ...>` / `[...]>` . external XML entity reference (XXE)
 *
 * What we DON'T do
 * ----------------
 *   - We do not parse XML rigorously. A determined attacker can probably
 *     find an obscure SVG construct that bypasses the regex set. This
 *     check is defense-in-depth, layered with `authenticateForStatic` on
 *     /uploads (so anonymous users can't fetch the SVG to render it
 *     anywhere off-platform). For a hardened deployment, the long-term
 *     fix is `Content-Disposition: attachment` on /uploads responses for
 *     image/svg+xml — that prevents inline render entirely.
 *
 * Returns { valid: boolean, message?: string }.
 */
function validateSvgSafety(filePath, originalName) {
  const ext = path.extname(originalName || '').toLowerCase().replace(/^\./, '');
  if (ext !== 'svg') return { valid: true };

  // Cap the read at 1 MiB. Real-world SVGs almost never exceed that, and a
  // 50 MB SVG bomb would be a separate DoS vector handled by the size limit
  // before us. If the file is bigger we still scan the prefix — anything
  // dangerous tends to live near the top.
  const MAX_SCAN_BYTES = 1024 * 1024;
  let text;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(MAX_SCAN_BYTES);
    const read = fs.readSync(fd, buf, 0, MAX_SCAN_BYTES, 0);
    fs.closeSync(fd);
    text = buf.slice(0, read).toString('utf8');
  } catch {
    return { valid: false, message: 'Could not validate SVG content.' };
  }

  // Quick sanity: the file should look like XML/SVG. A binary masquerading
  // as .svg would fail this and is rejected.
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (!/^(<\?xml|<!--|<!DOCTYPE|<svg)/i.test(trimmed)) {
    return { valid: false, message: 'SVG file does not contain valid SVG/XML content.' };
  }

  // Pattern set. Each regex is tested against the full text. We do NOT lower-
  // case the source first; the regexes already use `i` where the SVG/HTML
  // spec is case-insensitive. JS event handler names are case-insensitive in
  // HTML so the `on\w+` match catches `OnClick`, `onClick`, etc.
  const banned = [
    { re: /<\s*script\b/i,                          reason: '<script> tag' },
    { re: /<\s*foreignObject\b/i,                   reason: '<foreignObject> element' },
    { re: /\son[a-z]+\s*=/i,                        reason: 'inline event handler attribute' },
    { re: /(?:href|src|xlink:href)\s*=\s*["']?\s*javascript:/i, reason: 'javascript: URI' },
    { re: /<!ENTITY\b/i,                            reason: 'XML entity declaration (XXE risk)' },
    { re: /<!DOCTYPE[^>]*\[/i,                      reason: 'inline DTD with subset (XXE risk)' },
  ];
  for (const { re, reason } of banned) {
    if (re.test(text)) {
      return {
        valid: false,
        message: `SVG rejected: contains ${reason}. Save the file as PNG/JPG or strip the offending content.`,
      };
    }
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
  validateSvgSafety,
  storeFile,
  deleteFile,
  fileExists,
  resolveFile,
  getFileUrl,
  normalizeMetadata,
  cleanupOnError,
};
