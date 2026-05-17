'use strict';

/**
 * Tests for server/middleware/staticAuth.js — Phase 2.4 of the QA
 * remediation plan (docs/qa-audit-2026-05-17.md → §22 P0 item #4).
 * Previously 0% coverage.
 *
 * This middleware is the safety net for direct /uploads/<filename> requests.
 * If it fails open, any authenticated user could fetch any uploaded file by
 * guessing/leaking the filename. The tests cover EVERY branch:
 *   - token source (cookie / Bearer / ?token=) precedence
 *   - refresh-token rejection
 *   - user lookup / isActive
 *   - avatar bypass
 *   - super admin bypass
 *   - attachment lookup (not found = 403)
 *   - uploader bypass
 *   - canAccessTask via taskVisibility + DependencyRequest fallback
 *   - task_files.download permission engine gate
 *   - Content-Disposition: attachment header forced on non-avatar paths
 */

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../models', () => ({
  User: { findByPk: jest.fn() },
  FileAttachment: { findOne: jest.fn() },
  DependencyRequest: { count: jest.fn() },
}));
jest.mock('../../utils/authCookies', () => ({
  getAccessTokenFromRequest: jest.fn(),
}));
jest.mock('../../services/taskVisibilityService', () => ({
  canViewTask: jest.fn(),
}));
jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn(),
}));
jest.mock('../../utils/safeLogger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const { User, FileAttachment, DependencyRequest } = require('../../models');
const { getAccessTokenFromRequest } = require('../../utils/authCookies');
const taskVisibility = require('../../services/taskVisibilityService');
const { hasPermission } = require('../../services/permissionEngine');
const { authenticateForStatic } = require('../../middleware/staticAuth');

function mockReq(overrides = {}) {
  return {
    headers: {},
    query: {},
    path: '/uploads/somefile.png',
    url: '/uploads/somefile.png',
    ...overrides,
  };
}

function mockRes() {
  const headers = {};
  const res = {
    status: jest.fn(function (c) { res.statusCode = c; return this; }),
    json: jest.fn(function (b) { res.body = b; return this; }),
    setHeader: jest.fn((k, v) => { headers[k] = v; }),
    _headers: headers,
  };
  return res;
}

const ACTIVE_USER = { id: 'u-1', role: 'member', tier: 4, isSuperAdmin: false, isActive: true };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret';
});

// ─── Token sourcing ────────────────────────────────────────────

describe('authenticateForStatic — token sourcing', () => {
  it('returns 401 when no token is found in cookie, header, or query', async () => {
    getAccessTokenFromRequest.mockReturnValue(null);
    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'Authentication required to access uploaded files.' });
  });

  it('prefers the cookie/header token over the query-string fallback', async () => {
    getAccessTokenFromRequest.mockReturnValue('from-cookie');
    jwt.verify.mockReturnValue({ id: 'u-1', type: 'access' });
    User.findByPk.mockResolvedValue(ACTIVE_USER);
    hasPermission.mockResolvedValue(true);

    const req = mockReq({ query: { token: 'from-query' }, path: '/avatars/me.png', url: '/avatars/me.png' });
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(jwt.verify).toHaveBeenCalledWith('from-cookie', 'test-secret');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to query-string token only when cookie/header missing', async () => {
    getAccessTokenFromRequest.mockReturnValue(null);
    jwt.verify.mockReturnValue({ id: 'u-1' });
    User.findByPk.mockResolvedValue(ACTIVE_USER);

    const req = mockReq({ query: { token: 'from-query' }, path: '/avatars/me.png', url: '/avatars/me.png' });
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(jwt.verify).toHaveBeenCalledWith('from-query', 'test-secret');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects empty-string query tokens (not a valid fallback)', async () => {
    getAccessTokenFromRequest.mockReturnValue(null);
    const req = mockReq({ query: { token: '' } });
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(jwt.verify).not.toHaveBeenCalled();
  });
});

// ─── Token validation ──────────────────────────────────────────

describe('authenticateForStatic — token validation', () => {
  it('rejects refresh tokens (must use access tokens only)', async () => {
    getAccessTokenFromRequest.mockReturnValue('refresh-token-here');
    jwt.verify.mockReturnValue({ id: 'u-1', type: 'refresh' });

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'Refresh tokens are not accepted on /uploads.' });
  });

  it('returns 401 when the user record does not exist', async () => {
    getAccessTokenFromRequest.mockReturnValue('good-token');
    jwt.verify.mockReturnValue({ id: 'ghost' });
    User.findByPk.mockResolvedValue(null);

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid token.' });
  });

  it('returns 401 when the user is inactive', async () => {
    getAccessTokenFromRequest.mockReturnValue('good-token');
    jwt.verify.mockReturnValue({ id: 'u-2' });
    User.findByPk.mockResolvedValue({ ...ACTIVE_USER, id: 'u-2', isActive: false });

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 with "Invalid or expired token" when jwt.verify throws', async () => {
    getAccessTokenFromRequest.mockReturnValue('expired-token');
    jwt.verify.mockImplementation(() => { throw new Error('jwt expired'); });

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid or expired token.' });
  });
});

// ─── Avatar bypass + Content-Disposition header ────────────────

describe('authenticateForStatic — avatar bypass', () => {
  beforeEach(() => {
    getAccessTokenFromRequest.mockReturnValue('good');
    jwt.verify.mockReturnValue({ id: 'u-1' });
    User.findByPk.mockResolvedValue(ACTIVE_USER);
  });

  it('lets through any avatar path without ACL or permission check', async () => {
    const req = mockReq({ path: '/avatars/abc.png', url: '/avatars/abc.png' });
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(FileAttachment.findOne).not.toHaveBeenCalled();
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it('does NOT set Content-Disposition: attachment for avatar paths (used in <img src>)', async () => {
    const req = mockReq({ path: '/avatars/abc.png', url: '/avatars/abc.png' });
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Disposition', expect.anything());
  });

  it('matches /avatars/ case-insensitively', async () => {
    const req = mockReq({ path: '/AVATARS/x.PNG', url: '/AVATARS/x.PNG' });
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('matches the bare /avatars/ root (no leading slash variant)', async () => {
    const req = mockReq({ path: 'avatars/x.png', url: 'avatars/x.png' });
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('authenticateForStatic — Content-Disposition forcing for non-avatar', () => {
  beforeEach(() => {
    getAccessTokenFromRequest.mockReturnValue('good');
    jwt.verify.mockReturnValue({ id: 'u-1' });
    User.findByPk.mockResolvedValue(ACTIVE_USER);
  });

  it('forces Content-Disposition: attachment for ANY non-avatar path before serving', async () => {
    // Super admin bypass means we hit next() quickly without needing the
    // attachment lookup branch — but the header MUST still have been set.
    User.findByPk.mockResolvedValue({ ...ACTIVE_USER, isSuperAdmin: true });
    const req = mockReq({ path: '/uploads/whatever.html', url: '/uploads/whatever.html' });
    const res = mockRes();
    await authenticateForStatic(req, res, jest.fn());
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment');
  });
});

// ─── Super admin bypass ────────────────────────────────────────

describe('authenticateForStatic — super admin bypass', () => {
  it('super admin skips attachment lookup + permission check', async () => {
    getAccessTokenFromRequest.mockReturnValue('good');
    jwt.verify.mockReturnValue({ id: 'sa-1' });
    User.findByPk.mockResolvedValue({ ...ACTIVE_USER, id: 'sa-1', isSuperAdmin: true });

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(FileAttachment.findOne).not.toHaveBeenCalled();
    expect(hasPermission).not.toHaveBeenCalled();
  });
});

// ─── Per-file ACL ──────────────────────────────────────────────

describe('authenticateForStatic — per-file ACL', () => {
  beforeEach(() => {
    getAccessTokenFromRequest.mockReturnValue('good');
    jwt.verify.mockReturnValue({ id: 'u-1' });
    User.findByPk.mockResolvedValue(ACTIVE_USER);
  });

  it('returns 403 when no FileAttachment row matches the filename (orphan file)', async () => {
    FileAttachment.findOne.mockResolvedValue(null);
    const req = mockReq({ path: '/uploads/orphan.png', url: '/uploads/orphan.png' });
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ success: false, message: 'File not found or access denied.' });
  });

  it('uploader bypasses canAccessTask but still must pass task_files.download', async () => {
    FileAttachment.findOne.mockResolvedValue({
      id: 'f-1', taskId: 't-1', uploadedBy: 'u-1', // matches req user
    });
    hasPermission.mockResolvedValue(true);

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    // uploader path means canViewTask should NOT be called
    expect(taskVisibility.canViewTask).not.toHaveBeenCalled();
    expect(hasPermission).toHaveBeenCalledWith(ACTIVE_USER, 'task_files', 'download');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('non-uploader passes when canViewTask returns true + task_files.download granted', async () => {
    FileAttachment.findOne.mockResolvedValue({ id: 'f-1', taskId: 't-1', uploadedBy: 'someone-else' });
    taskVisibility.canViewTask.mockResolvedValue(true);
    hasPermission.mockResolvedValue(true);

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(taskVisibility.canViewTask).toHaveBeenCalledWith(ACTIVE_USER, 't-1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('non-uploader gets 403 when canViewTask is false AND no DependencyRequest', async () => {
    FileAttachment.findOne.mockResolvedValue({ id: 'f-1', taskId: 't-1', uploadedBy: 'other' });
    taskVisibility.canViewTask.mockResolvedValue(false);
    DependencyRequest.count.mockResolvedValue(0);

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ success: false, message: 'You do not have access to this file.' });
  });

  it('non-uploader passes when DependencyRequest membership grants read access', async () => {
    FileAttachment.findOne.mockResolvedValue({ id: 'f-1', taskId: 't-1', uploadedBy: 'other' });
    taskVisibility.canViewTask.mockResolvedValue(false);
    DependencyRequest.count.mockResolvedValue(1); // user has an open dep on the parent
    hasPermission.mockResolvedValue(true);

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to deny when canViewTask throws (logs the error, treats as no access)', async () => {
    FileAttachment.findOne.mockResolvedValue({ id: 'f-1', taskId: 't-1', uploadedBy: 'other' });
    taskVisibility.canViewTask.mockRejectedValue(new Error('db down'));
    DependencyRequest.count.mockResolvedValue(0);

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('absorbs a thrown DependencyRequest.count error (legacy DBs may not have the table)', async () => {
    FileAttachment.findOne.mockResolvedValue({ id: 'f-1', taskId: 't-1', uploadedBy: 'other' });
    taskVisibility.canViewTask.mockResolvedValue(false);
    DependencyRequest.count.mockRejectedValue(new Error('relation does not exist'));

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ─── task_files.download permission gate ───────────────────────

describe('authenticateForStatic — task_files.download gate', () => {
  beforeEach(() => {
    getAccessTokenFromRequest.mockReturnValue('good');
    jwt.verify.mockReturnValue({ id: 'u-1' });
    User.findByPk.mockResolvedValue(ACTIVE_USER);
    FileAttachment.findOne.mockResolvedValue({ id: 'f-1', taskId: 't-1', uploadedBy: 'u-1' });
  });

  it('returns 403 when hasPermission says false', async () => {
    hasPermission.mockResolvedValue(false);

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ success: false, message: 'You do not have permission to download task files.' });
  });

  it('returns 403 when hasPermission throws', async () => {
    hasPermission.mockRejectedValue(new Error('engine borked'));

    const req = mockReq();
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ success: false, message: 'Permission check failed.' });
  });
});

// ─── Path traversal defence ────────────────────────────────────

describe('authenticateForStatic — path sanitization in findAttachmentForPath', () => {
  beforeEach(() => {
    getAccessTokenFromRequest.mockReturnValue('good');
    jwt.verify.mockReturnValue({ id: 'u-1' });
    User.findByPk.mockResolvedValue(ACTIVE_USER);
  });

  it('handles request paths with leading slashes', async () => {
    FileAttachment.findOne.mockResolvedValue({ id: 'f-1', taskId: 't-1', uploadedBy: 'u-1' });
    hasPermission.mockResolvedValue(true);

    const req = mockReq({ path: '///uploads/file.png', url: '///uploads/file.png' });
    const res = mockRes();
    await authenticateForStatic(req, res, jest.fn());

    // Should still look up by basename
    expect(FileAttachment.findOne).toHaveBeenCalled();
  });

  it('returns 403 when the cleaned path becomes empty (just slashes)', async () => {
    FileAttachment.findOne.mockResolvedValue(null);

    const req = mockReq({ path: '/', url: '/' });
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    // No attachment → 403 orphan path
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('treats a DB-level FileAttachment.findOne failure as orphan (denies access)', async () => {
    // Covers the catch block at staticAuth.js:91-92 — if the FileAttachment
    // query itself throws (e.g. transient DB error), we MUST deny rather
    // than fall through. Otherwise a query failure would mean every
    // logged-in user gets the file.
    FileAttachment.findOne.mockRejectedValue(new Error('connection lost'));

    const req = mockReq({ path: '/uploads/whatever.png', url: '/uploads/whatever.png' });
    const res = mockRes(); const next = jest.fn();
    await authenticateForStatic(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ success: false, message: 'File not found or access denied.' });
  });
});
