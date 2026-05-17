'use strict';

/**
 * Tests for server/middleware/upload.js — Phase 2.5 of the QA remediation
 * plan (docs/qa-audit-2026-05-17.md → §22 P0 item #5). Previously 0%
 * coverage on the middleware itself (the storageService validators it
 * delegates to are tested in upload.validators.test.js, but the
 * orchestration here had no tests).
 *
 * Coverage focus:
 *   - handleMulterError for every MulterError code branch
 *   - postUploadValidation: each of the 4 validators called in order,
 *     short-circuits on first failure, calls cleanupOnError once
 *   - validateFileSignature legacy delegate
 *   - setCategoryMiddleware sets req._uploadCategory
 *   - createUpload returns something multer-shaped
 *   - getUploadDir falls back to OS tempdir when provider has no uploadDir
 *
 * Mocks: storage provider + the 5 validator/cleanup functions exported
 * from storageService. We DO NOT mock multer itself — handleMulterError
 * needs `err instanceof multer.MulterError` to hold true.
 */

jest.mock('../../services/storage', () => ({
  getProvider: jest.fn(),
}));

jest.mock('../../config/fileTypes', () => ({
  getAllowedMimesForCategory: jest.fn(() => ['image/png', 'image/jpeg', 'image/svg+xml']),
  getMaxSizeForCategory: jest.fn(() => 25 * 1024 * 1024),
  BLOCKED_EXTENSIONS: ['exe', 'html', 'js', 'sh', 'bat'],
}));

jest.mock('../../services/storageService', () => ({
  validateFileType: jest.fn(() => ({ valid: true })),
  validateFileSize: jest.fn(() => ({ valid: true })),
  validateMagicBytes: jest.fn(() => ({ valid: true })),
  validateSvgSafety: jest.fn(() => ({ valid: true })),
  cleanupOnError: jest.fn(),
}));

const multer = require('multer');
const { getProvider } = require('../../services/storage');
const {
  validateFileType,
  validateFileSize,
  validateMagicBytes,
  validateSvgSafety,
  cleanupOnError,
} = require('../../services/storageService');

// Provide a default LocalStorageProvider-shaped stub before requiring the
// module under test — getUploadDir runs at module load.
getProvider.mockReturnValue({ uploadDir: '/tmp/test-uploads' });

const {
  createUpload,
  handleMulterError,
  validateFileSignature,
  postUploadValidation,
  setCategoryMiddleware,
  getUploadDir,
} = require('../../middleware/upload');

function mockRes() {
  const res = {
    status: jest.fn(function (c) { res.statusCode = c; return this; }),
    json: jest.fn(function (b) { res.body = b; return this; }),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Re-set the defaults that beforeEach('clearAllMocks') wiped
  validateFileType.mockReturnValue({ valid: true });
  validateFileSize.mockReturnValue({ valid: true });
  validateMagicBytes.mockReturnValue({ valid: true });
  validateSvgSafety.mockReturnValue({ valid: true });
  getProvider.mockReturnValue({ uploadDir: '/tmp/test-uploads' });
});

// ─── handleMulterError ──────────────────────────────────────────

describe('handleMulterError', () => {
  it('maps LIMIT_FILE_SIZE to 400 with the category-specific MB message', () => {
    const err = new multer.MulterError('LIMIT_FILE_SIZE');
    const req = { _uploadCategory: 'task_attachment' };
    const res = mockRes();
    const next = jest.fn();
    handleMulterError(err, req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/File too large/);
    expect(res.body.message).toMatch(/MB/);
  });

  it('maps LIMIT_FILE_SIZE with no category to the "general" default message', () => {
    const err = new multer.MulterError('LIMIT_FILE_SIZE');
    const req = {}; // no _uploadCategory
    const res = mockRes(); const next = jest.fn();
    handleMulterError(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toMatch(/File too large/);
  });

  it('maps LIMIT_FILE_COUNT to "Too many files. Maximum 5"', () => {
    const err = new multer.MulterError('LIMIT_FILE_COUNT');
    const res = mockRes(); const next = jest.fn();
    handleMulterError(err, {}, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toBe('Too many files. Maximum 5 files per upload.');
  });

  it('maps LIMIT_UNEXPECTED_FILE to the err.field message (extension or MIME explanation)', () => {
    const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE');
    err.field = 'File type .exe is blocked for security reasons.';
    const res = mockRes(); const next = jest.fn();
    handleMulterError(err, {}, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toBe('File type .exe is blocked for security reasons.');
  });

  it('maps LIMIT_UNEXPECTED_FILE without err.field to fallback', () => {
    const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE');
    const res = mockRes(); const next = jest.fn();
    handleMulterError(err, {}, res, next);

    expect(res.body.message).toBe('Unexpected or unsupported file type.');
  });

  it('maps an unknown MulterError code to err.message', () => {
    // Construct an unrecognised code; multer.MulterError accepts arbitrary
    // strings. The default branch falls back to err.message verbatim.
    const err = new multer.MulterError('LIMIT_FIELD_KEY');
    const res = mockRes(); const next = jest.fn();
    handleMulterError(err, {}, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toBe(err.message);
  });

  it('forwards non-MulterError to next() (no response sent)', () => {
    const err = new Error('not a multer thing');
    const res = mockRes(); const next = jest.fn();
    handleMulterError(err, {}, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─── postUploadValidation ───────────────────────────────────────

describe('postUploadValidation — orchestration', () => {
  function mockReqWithFile(file = {}) {
    return {
      file: { path: '/tmp/upload-123', originalname: 'foo.png', mimetype: 'image/png', size: 1024, ...file },
    };
  }

  it('skips validation when req.file is missing (multer.fields() path)', () => {
    const fn = postUploadValidation('task_attachment');
    const req = {}; const res = mockRes(); const next = jest.fn();
    fn(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(validateFileType).not.toHaveBeenCalled();
  });

  it('runs all 4 validators in order on success and tags category', () => {
    const fn = postUploadValidation('task_attachment');
    const req = mockReqWithFile(); const res = mockRes(); const next = jest.fn();

    fn(req, res, next);

    expect(req._uploadCategory).toBe('task_attachment');
    expect(validateFileType).toHaveBeenCalledTimes(1);
    expect(validateFileSize).toHaveBeenCalledTimes(1);
    expect(validateMagicBytes).toHaveBeenCalledTimes(1);
    expect(validateSvgSafety).toHaveBeenCalledTimes(1);
    expect(cleanupOnError).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('short-circuits on validateFileType failure and cleans up', () => {
    validateFileType.mockReturnValue({ valid: false, message: 'Bad type.' });
    const fn = postUploadValidation('task_attachment');
    const req = mockReqWithFile(); const res = mockRes(); const next = jest.fn();

    fn(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toEqual({ success: false, message: 'Bad type.' });
    expect(cleanupOnError).toHaveBeenCalledWith(req.file);
    // Later validators should NOT run
    expect(validateFileSize).not.toHaveBeenCalled();
    expect(validateMagicBytes).not.toHaveBeenCalled();
    expect(validateSvgSafety).not.toHaveBeenCalled();
  });

  it('short-circuits on validateFileSize failure', () => {
    validateFileSize.mockReturnValue({ valid: false, message: 'Too big.' });
    const fn = postUploadValidation('avatar');
    const req = mockReqWithFile(); const res = mockRes(); const next = jest.fn();

    fn(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toBe('Too big.');
    expect(cleanupOnError).toHaveBeenCalledWith(req.file);
    expect(validateMagicBytes).not.toHaveBeenCalled();
  });

  it('short-circuits on validateMagicBytes failure (defeats spoofed MIME)', () => {
    validateMagicBytes.mockReturnValue({ valid: false, message: 'Magic bytes mismatch.' });
    const fn = postUploadValidation('task_attachment');
    const req = mockReqWithFile(); const res = mockRes(); const next = jest.fn();

    fn(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toBe('Magic bytes mismatch.');
    expect(cleanupOnError).toHaveBeenCalledWith(req.file);
    expect(validateSvgSafety).not.toHaveBeenCalled();
  });

  it('short-circuits on validateSvgSafety failure (script/XXE in SVG)', () => {
    validateSvgSafety.mockReturnValue({ valid: false, message: 'SVG contains a script tag.' });
    const fn = postUploadValidation('task_attachment');
    const req = mockReqWithFile(); const res = mockRes(); const next = jest.fn();

    fn(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toBe('SVG contains a script tag.');
    expect(cleanupOnError).toHaveBeenCalledWith(req.file);
  });

  it('defaults category to "general" when no argument supplied', () => {
    const fn = postUploadValidation();
    const req = mockReqWithFile(); const res = mockRes(); const next = jest.fn();

    fn(req, res, next);

    expect(req._uploadCategory).toBe('general');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── validateFileSignature (legacy delegate) ────────────────────

describe('validateFileSignature — legacy compat', () => {
  function reqFile() {
    return { path: '/tmp/x', originalname: 'x.png' };
  }

  it('skips when no req.file', () => {
    const req = {}; const res = mockRes(); const next = jest.fn();
    validateFileSignature(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(validateMagicBytes).not.toHaveBeenCalled();
  });

  it('passes when both magic and SVG checks return valid', () => {
    const req = { file: reqFile() }; const res = mockRes(); const next = jest.fn();
    validateFileSignature(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(validateMagicBytes).toHaveBeenCalled();
    expect(validateSvgSafety).toHaveBeenCalled();
  });

  it('cleans up and 400s when magic-bytes check fails', () => {
    validateMagicBytes.mockReturnValue({ valid: false, message: 'magic bad' });
    const req = { file: reqFile() }; const res = mockRes(); const next = jest.fn();
    validateFileSignature(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toBe('magic bad');
    expect(cleanupOnError).toHaveBeenCalledWith(req.file);
  });

  it('cleans up and 400s when SVG safety scan fails', () => {
    validateSvgSafety.mockReturnValue({ valid: false, message: 'svg dangerous' });
    const req = { file: reqFile() }; const res = mockRes(); const next = jest.fn();
    validateFileSignature(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toBe('svg dangerous');
    expect(cleanupOnError).toHaveBeenCalledWith(req.file);
  });
});

// ─── setCategoryMiddleware ──────────────────────────────────────

describe('setCategoryMiddleware', () => {
  it('tags req._uploadCategory and calls next', () => {
    const fn = setCategoryMiddleware('avatar');
    const req = {}; const next = jest.fn();
    fn(req, {}, next);
    expect(req._uploadCategory).toBe('avatar');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── createUpload factory ───────────────────────────────────────

describe('createUpload', () => {
  it('returns a multer instance with .single / .array / .fields methods', () => {
    const u = createUpload('task_attachment');
    expect(typeof u.single).toBe('function');
    expect(typeof u.array).toBe('function');
    expect(typeof u.fields).toBe('function');
  });

  it('defaults to "general" category', () => {
    const u = createUpload();
    expect(u).toBeDefined();
  });
});

// ─── getUploadDir ──────────────────────────────────────────────

describe('getUploadDir', () => {
  it('returns the provider uploadDir when present', () => {
    getProvider.mockReturnValue({ uploadDir: '/var/test-uploads' });
    expect(getUploadDir()).toBe('/var/test-uploads');
  });

  it('falls back to os.tmpdir() when provider has no uploadDir (remote provider)', () => {
    getProvider.mockReturnValue({}); // no uploadDir
    const os = require('os');
    expect(getUploadDir()).toBe(os.tmpdir());
  });
});
