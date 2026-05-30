'use strict';

/**
 * Unit tests for the Phase F doc-comments controller.
 *
 * Surfaces under test:
 *   - createComment (top-level + reply, parent validation)
 *   - listComments (nested thread grouping via __nestThreads)
 *   - updateComment (author-only edit, super-admin override, body sanitization)
 *   - deleteComment (soft when replies exist, hard otherwise)
 *   - resolveComment / unresolveComment (atomic field flip)
 *   - RBAC: 403 when caller is not a workspace member
 *
 * All Sequelize models are mocked; no real DB. Notification service is
 * NOT involved (Phase F deliberately ships without notifications).
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  Doc: { findByPk: jest.fn() },
  DocComment: {
    findByPk: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
    destroy: jest.fn(),
  },
  // feat/docs-personal-notion Phase 3 — access table consulted by the
  // canonical resolver (docAccessService.hasDocAccess). Default findOne
  // returns a 'comment'-level grant so existing tests that expect a
  // workspace member to be able to post comments still pass; the explicit
  // "403 when caller is not a workspace member" test mocks findOne to
  // return null to verify the denial path.
  DocAccess: {
    findOne: jest.fn().mockResolvedValue({ accessLevel: 'comment' }),
    findAll: jest.fn().mockResolvedValue([]),
  },
  Workspace: { findByPk: jest.fn() },
  User: {},
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

const { Doc, DocComment, Workspace } = require('../../models');
const ctrl = require('../../controllers/docCommentController');

// ─── shared helpers ────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const ADMIN = { id: 'u-admin', name: 'Admin', role: 'admin', isSuperAdmin: false };
const SUPER = { id: 'u-super', name: 'Super', role: 'admin', isSuperAdmin: true };
const MEMBER = { id: 'u-member', name: 'Mem', role: 'member', isSuperAdmin: false };
const OTHER = { id: 'u-other', name: 'Other', role: 'member', isSuperAdmin: false };
const OUTSIDER = { id: 'u-outsider', name: 'Outsider', role: 'member', isSuperAdmin: false };

function makeWorkspace(overrides = {}) {
  return {
    id: 'w1',
    createdBy: ADMIN.id,
    workspaceMembers: [{ id: MEMBER.id }, { id: OTHER.id }],
    ...overrides,
  };
}

function makeDoc(overrides = {}) {
  return {
    id: 'd1',
    workspaceId: 'w1',
    title: 'Test Doc',
    ...overrides,
  };
}

function makeComment(overrides = {}) {
  const row = {
    id: 'c1',
    docId: 'd1',
    parentId: null,
    authorId: MEMBER.id,
    body: 'hello',
    anchorText: 'selected span',
    anchorFrom: 10,
    anchorTo: 20,
    resolved: false,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: new Date('2026-05-01T00:00:00Z').toISOString(),
    update: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  row.toJSON = function () {
    const out = {};
    for (const k of Object.keys(this)) {
      if (typeof this[k] !== 'function') out[k] = this[k];
    }
    return out;
  };
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ───────────────────────────────────────────────────────────────────────
// createComment
// ───────────────────────────────────────────────────────────────────────

describe('createComment', () => {
  test('creates a top-level comment with the supplied anchor', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const created = makeComment({ id: 'c-new' });
    DocComment.create.mockResolvedValue(created);
    DocComment.findByPk.mockResolvedValueOnce(created); // post-create reload

    const req = {
      user: MEMBER,
      params: { id: 'd1' },
      body: { body: 'looks good', anchorText: 'selected span', anchorFrom: 5, anchorTo: 25 },
    };
    const res = mockRes();
    await ctrl.createComment(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const insertArgs = DocComment.create.mock.calls[0][0];
    expect(insertArgs.docId).toBe('d1');
    expect(insertArgs.parentId).toBeNull();
    expect(insertArgs.authorId).toBe(MEMBER.id);
    expect(insertArgs.body).toBe('looks good');
    expect(insertArgs.anchorText).toBe('selected span');
    expect(insertArgs.anchorFrom).toBe(5);
    expect(insertArgs.anchorTo).toBe(25);
  });

  test('creates a reply with parentId set when parent is valid top-level on same doc', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const parent = makeComment({ id: 'parent-1', parentId: null });
    DocComment.findByPk
      .mockResolvedValueOnce(parent) // parent validation
      .mockResolvedValueOnce(makeComment({ id: 'c-reply', parentId: 'parent-1' })); // post-create reload
    DocComment.create.mockResolvedValue(makeComment({ id: 'c-reply', parentId: 'parent-1' }));

    const req = {
      user: MEMBER,
      params: { id: 'd1' },
      body: { body: 'agreed', anchorText: 'x', parentId: 'parent-1' },
    };
    const res = mockRes();
    await ctrl.createComment(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(DocComment.create.mock.calls[0][0].parentId).toBe('parent-1');
  });

  test('400 when parentId is a reply itself (nested replies forbidden)', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    DocComment.findByPk.mockResolvedValueOnce(
      makeComment({ id: 'reply-1', parentId: 'parent-x' })
    );

    const req = {
      user: MEMBER,
      params: { id: 'd1' },
      body: { body: 'nope', anchorText: 'x', parentId: 'reply-1' },
    };
    const res = mockRes();
    await ctrl.createComment(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(DocComment.create).not.toHaveBeenCalled();
  });

  test('403 when caller has no doc_access grant (and not super-admin)', async () => {
    // Phase 3: this test renamed — workspace membership is no longer the
    // gate. We now drive the denial via DocAccess.findOne returning null.
    Doc.findByPk.mockResolvedValue(makeDoc({ createdBy: 'someone-else' }));
    Workspace.findByPk.mockResolvedValue(makeWorkspace({ createdBy: 'someone-else' }));
    const { DocAccess } = require('../../models');
    DocAccess.findOne.mockResolvedValueOnce(null);

    const req = {
      user: OUTSIDER,
      params: { id: 'd1' },
      body: { body: 'sneak', anchorText: 'x' },
    };
    const res = mockRes();
    await ctrl.createComment(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(DocComment.create).not.toHaveBeenCalled();
  });

  test('sanitizes XSS payloads out of the body', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const created = makeComment({ id: 'c-new' });
    DocComment.create.mockResolvedValue(created);
    DocComment.findByPk.mockResolvedValueOnce(created);

    const req = {
      user: MEMBER,
      params: { id: 'd1' },
      body: {
        body: '<script>alert(1)</script>hello',
        anchorText: 'x',
      },
    };
    const res = mockRes();
    await ctrl.createComment(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const stored = DocComment.create.mock.calls[0][0].body;
    // The xss library escapes (not strips) script tags. Either way, the
    // raw "<script>" opener should not survive verbatim.
    expect(stored).not.toMatch(/<script>/i);
    expect(stored).toMatch(/hello/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// listComments
// ───────────────────────────────────────────────────────────────────────

describe('listComments', () => {
  test('groups flat rows into nested threads by parentId', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());

    const top1 = makeComment({ id: 'top-1', parentId: null, createdAt: '2026-05-03T00:00:00Z' });
    const top2 = makeComment({ id: 'top-2', parentId: null, createdAt: '2026-05-02T00:00:00Z' });
    const r1a = makeComment({ id: 'r1a', parentId: 'top-1', createdAt: '2026-05-03T01:00:00Z' });
    const r1b = makeComment({ id: 'r1b', parentId: 'top-1', createdAt: '2026-05-03T02:00:00Z' });
    const r2a = makeComment({ id: 'r2a', parentId: 'top-2', createdAt: '2026-05-02T01:00:00Z' });
    DocComment.findAll.mockResolvedValue([top1, top2, r1a, r1b, r2a]);

    const req = { user: MEMBER, params: { id: 'd1' } };
    const res = mockRes();
    await ctrl.listComments(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.threads).toHaveLength(2);
    const t1 = payload.data.threads.find((t) => t.id === 'top-1');
    const t2 = payload.data.threads.find((t) => t.id === 'top-2');
    expect(t1.replies.map((r) => r.id)).toEqual(['r1a', 'r1b']);
    expect(t2.replies.map((r) => r.id)).toEqual(['r2a']);
  });
});

// ───────────────────────────────────────────────────────────────────────
// updateComment
// ───────────────────────────────────────────────────────────────────────

describe('updateComment', () => {
  test('author can edit their own comment', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const comment = makeComment({ authorId: MEMBER.id });
    DocComment.findByPk
      .mockResolvedValueOnce(comment) // initial lookup
      .mockResolvedValueOnce({ ...comment, body: 'edited' }); // reload

    const req = {
      user: MEMBER,
      params: { id: 'd1', commentId: 'c1' },
      body: { body: 'edited' },
    };
    const res = mockRes();
    await ctrl.updateComment(req, res);

    expect(comment.update).toHaveBeenCalledWith({ body: 'edited' });
    expect(res.json).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  test('403 when a non-author tries to edit', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const comment = makeComment({ authorId: MEMBER.id });
    DocComment.findByPk.mockResolvedValueOnce(comment);

    const req = {
      user: OTHER,
      params: { id: 'd1', commentId: 'c1' },
      body: { body: 'sneaky edit' },
    };
    const res = mockRes();
    await ctrl.updateComment(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(comment.update).not.toHaveBeenCalled();
  });

  test('super-admin can edit any comment', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const comment = makeComment({ authorId: MEMBER.id });
    DocComment.findByPk
      .mockResolvedValueOnce(comment)
      .mockResolvedValueOnce({ ...comment, body: 'super edit' });

    const req = {
      user: SUPER,
      params: { id: 'd1', commentId: 'c1' },
      body: { body: 'super edit' },
    };
    const res = mockRes();
    await ctrl.updateComment(req, res);

    expect(comment.update).toHaveBeenCalledWith({ body: 'super edit' });
    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});

// ───────────────────────────────────────────────────────────────────────
// deleteComment
// ───────────────────────────────────────────────────────────────────────

describe('deleteComment', () => {
  test('soft-deletes a top-level comment WITH replies (rewrites body to [deleted])', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const top = makeComment({ id: 'top-1', parentId: null, authorId: MEMBER.id });
    DocComment.findByPk.mockResolvedValueOnce(top);
    DocComment.count.mockResolvedValue(3); // has replies

    const req = {
      user: MEMBER,
      params: { id: 'd1', commentId: 'top-1' },
    };
    const res = mockRes();
    await ctrl.deleteComment(req, res);

    expect(top.update).toHaveBeenCalledWith({ body: '[deleted]' });
    expect(top.destroy).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.mode).toBe('soft');
  });

  test('hard-deletes a top-level comment with NO replies', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const top = makeComment({ id: 'top-1', parentId: null, authorId: MEMBER.id });
    DocComment.findByPk.mockResolvedValueOnce(top);
    DocComment.count.mockResolvedValue(0);

    const req = {
      user: MEMBER,
      params: { id: 'd1', commentId: 'top-1' },
    };
    const res = mockRes();
    await ctrl.deleteComment(req, res);

    expect(top.destroy).toHaveBeenCalled();
    expect(top.update).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.mode).toBe('hard');
  });

  test('hard-deletes a reply unconditionally (no soft-delete for child rows)', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const reply = makeComment({ id: 'r1', parentId: 'top-1', authorId: MEMBER.id });
    DocComment.findByPk.mockResolvedValueOnce(reply);

    const req = {
      user: MEMBER,
      params: { id: 'd1', commentId: 'r1' },
    };
    const res = mockRes();
    await ctrl.deleteComment(req, res);

    expect(reply.destroy).toHaveBeenCalled();
    // Reply-deletes never need to count children — assert we didn't waste a query.
    expect(DocComment.count).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// resolve / unresolve
// ───────────────────────────────────────────────────────────────────────

describe('resolveComment / unresolveComment', () => {
  test('resolve flips fields atomically (resolved + resolvedAt + resolvedBy)', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const comment = makeComment({ resolved: false });
    DocComment.findByPk
      .mockResolvedValueOnce(comment)
      .mockResolvedValueOnce({ ...comment, resolved: true });

    const req = {
      user: OTHER,
      params: { id: 'd1', commentId: 'c1' },
    };
    const res = mockRes();
    await ctrl.resolveComment(req, res);

    expect(comment.update).toHaveBeenCalledTimes(1);
    const upd = comment.update.mock.calls[0][0];
    expect(upd.resolved).toBe(true);
    expect(upd.resolvedBy).toBe(OTHER.id);
    expect(upd.resolvedAt).toBeInstanceOf(Date);
  });

  test('unresolve clears resolvedAt and resolvedBy', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const comment = makeComment({
      resolved: true,
      resolvedAt: new Date('2026-05-10T00:00:00Z'),
      resolvedBy: OTHER.id,
    });
    DocComment.findByPk
      .mockResolvedValueOnce(comment)
      .mockResolvedValueOnce({ ...comment, resolved: false, resolvedAt: null, resolvedBy: null });

    const req = {
      user: MEMBER,
      params: { id: 'd1', commentId: 'c1' },
    };
    const res = mockRes();
    await ctrl.unresolveComment(req, res);

    expect(comment.update).toHaveBeenCalledTimes(1);
    const upd = comment.update.mock.calls[0][0];
    expect(upd.resolved).toBe(false);
    expect(upd.resolvedAt).toBeNull();
    expect(upd.resolvedBy).toBeNull();
  });
});
