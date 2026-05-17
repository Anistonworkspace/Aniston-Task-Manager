'use strict';

/**
 * Unit tests for docController (Doc Editor Phase B).
 *
 * Covers the 8 HTTP endpoints exposed for collaborative documents:
 *   listDocs, createDoc, getDoc, updateDoc,
 *   archiveDoc, restoreDoc, listVersions, restoreVersion.
 *
 * All Sequelize models and side-effect services are mocked. No real
 * DB or socket I/O.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

const { Op } = require('sequelize');

// ─── Mocks (must be declared before any require of the mocked modules) ──────

jest.mock('../../models', () => ({
  Doc: {
    findByPk: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
  },
  DocVersion: {
    findByPk: jest.fn(),
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  },
  Workspace: {
    findByPk: jest.fn(),
  },
  User: {},
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

const { Doc, DocVersion, Workspace } = require('../../models');
const safeLogger = require('../../utils/safeLogger');
const activityService = require('../../services/activityService');
const docCtrl = require('../../controllers/docController');

// ─── helpers ────────────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const ADMIN = { id: 'u-admin', role: 'admin', isSuperAdmin: false };
const MANAGER = { id: 'u-manager', role: 'manager', isSuperAdmin: false };
const MEMBER = { id: 'u-member', role: 'member', isSuperAdmin: false };
const SUPER = { id: 'u-super', role: 'admin', isSuperAdmin: true };
const OWNER = { id: 'u-owner', role: 'member', isSuperAdmin: false };
const OTHER = { id: 'u-other', role: 'member', isSuperAdmin: false };

function makeWorkspace(overrides = {}) {
  return {
    id: 'w1',
    name: 'Test WS',
    createdBy: 'u-admin',
    workspaceMembers: [],
    ...overrides,
  };
}

function makeDoc(overrides = {}) {
  const doc = {
    id: 'd1',
    workspaceId: 'w1',
    title: 'X',
    slug: 'x',
    contentJson: { type: 'doc', content: [] },
    contentText: '',
    sharePolicy: 'workspace',
    isArchived: false,
    archivedAt: null,
    archivedBy: null,
    createdBy: OWNER.id,
    lastEditedBy: OWNER.id,
    lastEditedAt: new Date('2026-05-01T00:00:00Z'),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  doc.toJSON = function () {
    // Return a shallow copy stripped of mock functions.
    const out = {};
    for (const k of Object.keys(this)) {
      if (typeof this[k] !== 'function') out[k] = this[k];
    }
    return out;
  };
  return doc;
}

function makeVersion(overrides = {}) {
  return {
    id: 'v1',
    docId: 'd1',
    contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old' }] }] },
    contentText: 'old',
    savedBy: OWNER.id,
    note: null,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── listDocs ───────────────────────────────────────────────────────────────

describe('listDocs', () => {
  test('403 when caller cannot see workspace (no membership match)', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: 'someone-else',
      workspaceMembers: [],
    }));
    const req = { user: MEMBER, params: { workspaceId: 'w1' }, query: {} };
    const res = mockRes();
    await docCtrl.listDocs(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Doc.findAll).not.toHaveBeenCalled();
  });

  test('200 returns docs array when admin bypasses membership check', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: 'someone-else',
      workspaceMembers: [],
    }));
    const docs = [makeDoc({ id: 'd1', title: 'A' }), makeDoc({ id: 'd2', title: 'B' })];
    Doc.findAll.mockResolvedValue(docs);

    const req = { user: ADMIN, params: { workspaceId: 'w1' }, query: {} };
    const res = mockRes();
    await docCtrl.listDocs(req, res);

    expect(Doc.findAll).toHaveBeenCalled();
    const responsePayload = res.json.mock.calls[0][0];
    expect(responsePayload.success).toBe(true);
    expect(Array.isArray(responsePayload.data.docs)).toBe(true);
    expect(responsePayload.data.docs).toHaveLength(2);
    // contentJson must be stripped from list payload
    expect(responsePayload.data.docs[0].contentJson).toBeUndefined();
  });

  test('search query filters by title + contentText with Op.iLike', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Doc.findAll.mockResolvedValue([]);
    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      query: { q: 'roadmap' },
    };
    const res = mockRes();
    await docCtrl.listDocs(req, res);

    const args = Doc.findAll.mock.calls[0][0];
    const where = args.where;
    expect(where[Op.or]).toBeDefined();
    expect(Array.isArray(where[Op.or])).toBe(true);
    // Two clauses: title iLike + contentText iLike
    const clauses = where[Op.or];
    expect(clauses).toHaveLength(2);
    const titleClause = clauses.find((c) => c.title);
    const contentClause = clauses.find((c) => c.contentText);
    expect(titleClause.title[Op.iLike]).toBe('%roadmap%');
    expect(contentClause.contentText[Op.iLike]).toBe('%roadmap%');
  });

  test('default excludes archived; ?archived=1 includes them', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Doc.findAll.mockResolvedValue([]);

    // Default: no archived flag → isArchived: false
    let req = { user: ADMIN, params: { workspaceId: 'w1' }, query: {} };
    let res = mockRes();
    await docCtrl.listDocs(req, res);
    expect(Doc.findAll.mock.calls[0][0].where.isArchived).toBe(false);

    // ?archived=1 → no isArchived filter
    Doc.findAll.mockClear();
    req = { user: ADMIN, params: { workspaceId: 'w1' }, query: { archived: '1' } };
    res = mockRes();
    await docCtrl.listDocs(req, res);
    expect(Doc.findAll.mock.calls[0][0].where.isArchived).toBeUndefined();
  });
});

// ─── createDoc ──────────────────────────────────────────────────────────────

describe('createDoc', () => {
  test('403 when caller cannot see workspace', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: 'someone-else',
      workspaceMembers: [],
    }));
    const req = {
      user: MEMBER,
      params: { workspaceId: 'w1' },
      body: { title: 'New doc' },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Doc.create).not.toHaveBeenCalled();
  });

  test('201 creates doc with provided title and default contentJson', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const created = makeDoc({ id: 'd-new', title: 'Sprint Plan', slug: 'sprint-plan', createdBy: ADMIN.id });
    Doc.create.mockResolvedValue(created);
    Doc.findByPk.mockResolvedValue(created);

    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: 'Sprint Plan' },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const createArgs = Doc.create.mock.calls[0][0];
    expect(createArgs.title).toBe('Sprint Plan');
    expect(createArgs.contentJson).toEqual({ type: 'doc', content: [] });
  });

  test('xss-sanitizes the title (script tags stripped)', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Doc.create.mockImplementation((v) => Promise.resolve(makeDoc({ ...v, id: 'd-new' })));
    Doc.findByPk.mockImplementation(() => Promise.resolve(makeDoc({ id: 'd-new' })));

    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: '<script>alert(1)</script>Hello' },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);

    const createArgs = Doc.create.mock.calls[0][0];
    // xss escapes/strips the raw script tag — should not appear unsanitized
    expect(createArgs.title).not.toContain('<script>');
    expect(createArgs.title.toLowerCase()).toContain('hello');
  });

  test('sets createdBy + lastEditedBy + lastEditedAt to caller', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Doc.create.mockImplementation((v) => Promise.resolve(makeDoc({ ...v, id: 'd-new' })));
    Doc.findByPk.mockImplementation(() => Promise.resolve(makeDoc({ id: 'd-new' })));

    const req = {
      user: MANAGER,
      params: { workspaceId: 'w1' },
      body: { title: 'Hi' },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);

    const createArgs = Doc.create.mock.calls[0][0];
    expect(createArgs.createdBy).toBe(MANAGER.id);
    expect(createArgs.lastEditedBy).toBe(MANAGER.id);
    expect(createArgs.lastEditedAt).toBeInstanceOf(Date);
  });

  test('generates slug from title (lowercase, hyphenated)', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Doc.create.mockImplementation((v) => Promise.resolve(makeDoc({ ...v, id: 'd-new' })));
    Doc.findByPk.mockImplementation(() => Promise.resolve(makeDoc({ id: 'd-new' })));

    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: 'My GREAT Doc!' },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);

    const createArgs = Doc.create.mock.calls[0][0];
    expect(createArgs.slug).toBe('my-great-doc');
  });

  test("defaults title to 'Untitled doc' when body title is empty/null", async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Doc.create.mockImplementation((v) => Promise.resolve(makeDoc({ ...v, id: 'd-new' })));
    Doc.findByPk.mockImplementation(() => Promise.resolve(makeDoc({ id: 'd-new' })));

    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: '' },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);

    const createArgs = Doc.create.mock.calls[0][0];
    expect(createArgs.title).toBe('Untitled doc');

    // Also: missing title entirely
    Doc.create.mockClear();
    const req2 = { user: ADMIN, params: { workspaceId: 'w1' }, body: {} };
    const res2 = mockRes();
    await docCtrl.createDoc(req2, res2);
    const createArgs2 = Doc.create.mock.calls[0][0];
    expect(createArgs2.title).toBe('Untitled doc');
  });

  test("fires logActivity with entityType='doc'", async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Doc.create.mockResolvedValue(makeDoc({ id: 'd-new', title: 'Logged' }));
    Doc.findByPk.mockResolvedValue(makeDoc({ id: 'd-new', title: 'Logged' }));

    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: 'Logged' },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);

    expect(activityService.logActivity).toHaveBeenCalledTimes(1);
    const logArg = activityService.logActivity.mock.calls[0][0];
    expect(logArg.entityType).toBe('doc');
    expect(logArg.action).toBe('created');
    expect(logArg.entityId).toBe('d-new');
    expect(logArg.userId).toBe(ADMIN.id);
  });
});

// ─── getDoc ─────────────────────────────────────────────────────────────────

describe('getDoc', () => {
  test('404 when not found', async () => {
    Doc.findByPk.mockResolvedValue(null);
    const req = { user: ADMIN, params: { id: 'missing' } };
    const res = mockRes();
    await docCtrl.getDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('403 when caller cannot see the workspace', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc({ workspaceId: 'w1' }));
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: 'someone-else',
      workspaceMembers: [],
    }));
    const req = { user: OTHER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.getDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('200 returns the doc including contentJson when allowed', async () => {
    const doc = makeDoc({
      id: 'd1',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] },
    });
    Doc.findByPk.mockResolvedValue(doc);
    Workspace.findByPk.mockResolvedValue(makeWorkspace());

    const req = { user: ADMIN, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.getDoc(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.doc.id).toBe('d1');
    expect(payload.data.doc.contentJson).toEqual(doc.contentJson);
  });
});

// ─── updateDoc ──────────────────────────────────────────────────────────────

describe('updateDoc', () => {
  test('404 when not found', async () => {
    Doc.findByPk.mockResolvedValue(null);
    const req = { user: ADMIN, params: { id: 'missing' }, body: { title: 'x' } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('403 when caller is not owner / admin / manager', async () => {
    const doc = makeDoc({ createdBy: OWNER.id });
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: OTHER, params: { id: 'd1' }, body: { title: 'Renamed' } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(doc.update).not.toHaveBeenCalled();
  });

  test('owner can edit (admin/manager bypass via canCallerEditDoc)', async () => {
    const doc = makeDoc({ createdBy: OWNER.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc) // initial lookup
      .mockResolvedValueOnce(doc); // reload
    const req = { user: OWNER, params: { id: 'd1' }, body: { title: 'Renamed' } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);
    expect(doc.update).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  test('title-only update does NOT create a version snapshot', async () => {
    const doc = makeDoc();
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);

    const req = { user: ADMIN, params: { id: 'd1' }, body: { title: 'New name' } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    const updateArgs = doc.update.mock.calls[0][0];
    expect(updateArgs.title).toBe('New name');
    expect(updateArgs.contentJson).toBeUndefined();
    expect(DocVersion.create).not.toHaveBeenCalled();
  });

  test('updates contentJson and derives contentText from text nodes', async () => {
    const doc = makeDoc();
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});

    const newJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: newJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    const updateArgs = doc.update.mock.calls[0][0];
    expect(updateArgs.contentJson).toEqual(newJson);
    expect(updateArgs.contentText).toBe('Hello World');
  });

  test('rejects contentJson that is not an object', async () => {
    const doc = makeDoc();
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: 'not-an-object' } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(doc.update).not.toHaveBeenCalled();
  });

  test("rejects contentJson with wrong .type (not 'doc')", async () => {
    const doc = makeDoc();
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: { type: 'paragraph', content: [] } } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(doc.update).not.toHaveBeenCalled();
  });

  test('rejects contentJson larger than 2 MB', async () => {
    const doc = makeDoc();
    Doc.findByPk.mockResolvedValue(doc);
    // Build a JSON object > 2MB
    const bigText = 'a'.repeat(3 * 1024 * 1024);
    const req = {
      user: ADMIN,
      params: { id: 'd1' },
      body: { contentJson: { type: 'doc', content: [{ type: 'text', text: bigText }] } },
    };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(doc.update).not.toHaveBeenCalled();
  });

  test('sets lastEditedBy and lastEditedAt on save', async () => {
    const doc = makeDoc({ createdBy: OWNER.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);

    const req = { user: OWNER, params: { id: 'd1' }, body: { title: 'X' } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    const updateArgs = doc.update.mock.calls[0][0];
    expect(updateArgs.lastEditedBy).toBe(OWNER.id);
    expect(updateArgs.lastEditedAt).toBeInstanceOf(Date);
  });

  test('creates a DocVersion snapshot on the first content save (versionCount === 0)', async () => {
    const doc = makeDoc();
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});

    const newJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }] };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: newJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    expect(DocVersion.create).toHaveBeenCalledTimes(1);
    const versionArgs = DocVersion.create.mock.calls[0][0];
    expect(versionArgs.docId).toBe('d1');
    expect(versionArgs.contentJson).toEqual(newJson);
    expect(versionArgs.contentText).toBe('first');
    expect(versionArgs.savedBy).toBe(ADMIN.id);
  });

  test('accepts valid sharePolicy enum values', async () => {
    const doc = makeDoc();
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);
    const req = { user: ADMIN, params: { id: 'd1' }, body: { sharePolicy: 'public_link' } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    const updateArgs = doc.update.mock.calls[0][0];
    expect(updateArgs.sharePolicy).toBe('public_link');
  });

  test('rejects invalid sharePolicy by silently dropping it (no-op update)', async () => {
    const doc = makeDoc();
    // Only one findByPk needed — early return path before reload.
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: ADMIN, params: { id: 'd1' }, body: { sharePolicy: 'evil-policy' } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    // Invalid enum is filtered out → no fields to update → controller returns success without calling update().
    expect(doc.update).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(400);
  });
});

// ─── archiveDoc ─────────────────────────────────────────────────────────────

describe('archiveDoc', () => {
  test('404 when not found', async () => {
    Doc.findByPk.mockResolvedValue(null);
    const req = { user: ADMIN, params: { id: 'missing' } };
    const res = mockRes();
    await docCtrl.archiveDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('403 when caller cannot edit', async () => {
    const doc = makeDoc({ createdBy: OWNER.id });
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: OTHER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.archiveDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(doc.update).not.toHaveBeenCalled();
  });

  test('sets isArchived=true, archivedAt, archivedBy on archive', async () => {
    const doc = makeDoc({ isArchived: false, createdBy: OWNER.id });
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: OWNER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.archiveDoc(req, res);

    expect(doc.update).toHaveBeenCalledTimes(1);
    const updateArgs = doc.update.mock.calls[0][0];
    expect(updateArgs.isArchived).toBe(true);
    expect(updateArgs.archivedAt).toBeInstanceOf(Date);
    expect(updateArgs.archivedBy).toBe(OWNER.id);
  });

  test('no-op (success) when already archived', async () => {
    const doc = makeDoc({ isArchived: true, createdBy: OWNER.id });
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: OWNER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.archiveDoc(req, res);

    expect(doc.update).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
  });
});

// ─── restoreDoc ─────────────────────────────────────────────────────────────

describe('restoreDoc', () => {
  test('403 when caller cannot edit', async () => {
    const doc = makeDoc({ isArchived: true, createdBy: OWNER.id });
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: OTHER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.restoreDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(doc.update).not.toHaveBeenCalled();
  });

  test('sets isArchived=false on restore', async () => {
    const doc = makeDoc({ isArchived: true, createdBy: OWNER.id, archivedAt: new Date(), archivedBy: OWNER.id });
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: OWNER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.restoreDoc(req, res);

    expect(doc.update).toHaveBeenCalledTimes(1);
    const updateArgs = doc.update.mock.calls[0][0];
    expect(updateArgs.isArchived).toBe(false);
    expect(updateArgs.archivedAt).toBeNull();
    expect(updateArgs.archivedBy).toBeNull();
  });

  test('no-op when already not-archived', async () => {
    const doc = makeDoc({ isArchived: false, createdBy: OWNER.id });
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: OWNER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.restoreDoc(req, res);

    expect(doc.update).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
  });
});

// ─── listVersions ───────────────────────────────────────────────────────────

describe('listVersions', () => {
  test('404 when doc missing', async () => {
    Doc.findByPk.mockResolvedValue(null);
    const req = { user: ADMIN, params: { id: 'missing' } };
    const res = mockRes();
    await docCtrl.listVersions(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('403 when caller cannot see workspace', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc({ workspaceId: 'w1' }));
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: 'someone-else',
      workspaceMembers: [],
    }));
    const req = { user: OTHER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.listVersions(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(DocVersion.findAll).not.toHaveBeenCalled();
  });

  test('200 returns versions array with attributes excluding contentJson', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc({ workspaceId: 'w1' }));
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const versions = [makeVersion({ id: 'v1' }), makeVersion({ id: 'v2' })];
    DocVersion.findAll.mockResolvedValue(versions);

    const req = { user: ADMIN, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.listVersions(req, res);

    expect(DocVersion.findAll).toHaveBeenCalled();
    const args = DocVersion.findAll.mock.calls[0][0];
    expect(args.attributes).toBeDefined();
    expect(args.attributes).not.toContain('contentJson');
    expect(args.attributes).toEqual(expect.arrayContaining(['id', 'note', 'savedBy', 'createdAt']));

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.versions).toHaveLength(2);
  });
});

// ─── restoreVersion ─────────────────────────────────────────────────────────

describe('restoreVersion', () => {
  test('404 when doc missing', async () => {
    Doc.findByPk.mockResolvedValue(null);
    const req = { user: ADMIN, params: { id: 'missing', versionId: 'v1' } };
    const res = mockRes();
    await docCtrl.restoreVersion(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('404 when version missing', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    DocVersion.findOne.mockResolvedValue(null);
    const req = { user: ADMIN, params: { id: 'd1', versionId: 'missing-version' } };
    const res = mockRes();
    await docCtrl.restoreVersion(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('403 when caller cannot edit', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc({ createdBy: OWNER.id }));
    const req = { user: OTHER, params: { id: 'd1', versionId: 'v1' } };
    const res = mockRes();
    await docCtrl.restoreVersion(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(DocVersion.findOne).not.toHaveBeenCalled();
  });

  test('restores contentJson + contentText from the version', async () => {
    const doc = makeDoc({ createdBy: OWNER.id });
    Doc.findByPk.mockResolvedValue(doc);
    const oldJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'restored' }] }] };
    const version = makeVersion({ id: 'v1', contentJson: oldJson, contentText: 'restored' });
    DocVersion.findOne.mockResolvedValue(version);
    DocVersion.create.mockResolvedValue({});

    const req = { user: OWNER, params: { id: 'd1', versionId: 'v1' } };
    const res = mockRes();
    await docCtrl.restoreVersion(req, res);

    expect(doc.update).toHaveBeenCalledTimes(1);
    const updateArgs = doc.update.mock.calls[0][0];
    expect(updateArgs.contentJson).toEqual(oldJson);
    expect(updateArgs.contentText).toBe('restored');
    expect(updateArgs.lastEditedBy).toBe(OWNER.id);
    expect(updateArgs.lastEditedAt).toBeInstanceOf(Date);
  });

  test('creates a new DocVersion entry with note=\'Restored from version <id>\'', async () => {
    const doc = makeDoc({ createdBy: OWNER.id });
    Doc.findByPk.mockResolvedValue(doc);
    const version = makeVersion({ id: 'v-original' });
    DocVersion.findOne.mockResolvedValue(version);
    DocVersion.create.mockResolvedValue({});

    const req = { user: OWNER, params: { id: 'd1', versionId: 'v-original' } };
    const res = mockRes();
    await docCtrl.restoreVersion(req, res);

    expect(DocVersion.create).toHaveBeenCalledTimes(1);
    const versionArgs = DocVersion.create.mock.calls[0][0];
    expect(versionArgs.note).toBe('Restored from version v-original');
    expect(versionArgs.docId).toBe('d1');
    expect(versionArgs.savedBy).toBe(OWNER.id);
  });
});

// ─── migrateDocToCollab (Phase G follow-up) ────────────────────────────────

describe('migrateDocToCollab', () => {
  test('404 when doc not found', async () => {
    Doc.findByPk.mockResolvedValue(null);
    const req = { user: ADMIN, params: { id: 'missing' } };
    const res = mockRes();
    await docCtrl.migrateDocToCollab(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('403 when caller is not owner / admin', async () => {
    const doc = makeDoc({ createdBy: OWNER.id });
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: OTHER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.migrateDocToCollab(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(doc.update).not.toHaveBeenCalled();
  });

  test('400 when doc is archived', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id, isArchived: true });
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: ADMIN, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.migrateDocToCollab(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(doc.update).not.toHaveBeenCalled();
  });

  test('idempotent: doc with existing yjsState short-circuits without snapshot or reset', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id, yjsState: Buffer.from([1, 2, 3]) });
    Doc.findByPk.mockResolvedValue(doc);
    const req = { user: ADMIN, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.migrateDocToCollab(req, res);
    expect(DocVersion.create).not.toHaveBeenCalled();
    expect(doc.update).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.alreadyMigrated).toBe(true);
  });

  test('happy path: snapshots contentJson, resets yjsState + contentJson, returns alreadyMigrated=false', async () => {
    const original = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }] };
    const doc = makeDoc({
      createdBy: ADMIN.id,
      contentJson: original,
      contentText: 'hello world',
      yjsState: null,
    });
    Doc.findByPk.mockResolvedValue(doc);
    DocVersion.create.mockResolvedValue({ id: 'v-snap-1' });
    const req = { user: ADMIN, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.migrateDocToCollab(req, res);

    // 1. Snapshot was taken with the ORIGINAL contentJson.
    expect(DocVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd1',
      contentJson: original,
      note: 'Pre-collab-migration snapshot',
      savedBy: ADMIN.id,
    }));

    // 2. Doc was updated with a fresh yjsState (Buffer with bytes) +
    //    replacement contentJson + new contentText.
    expect(doc.update).toHaveBeenCalledTimes(1);
    const args = doc.update.mock.calls[0][0];
    expect(Buffer.isBuffer(args.yjsState)).toBe(true);
    expect(args.yjsState.length).toBeGreaterThan(0);
    expect(args.contentJson?.type).toBe('doc');
    expect(args.contentText).toMatch(/version history/i);
    expect(args.lastEditedBy).toBe(ADMIN.id);
    expect(args.lastEditedAt).toBeInstanceOf(Date);

    // 3. Activity logged.
    expect(activityService.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'migrated',
      entityType: 'doc',
      entityId: 'd1',
      userId: ADMIN.id,
    }));

    // 4. Response shape.
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.alreadyMigrated).toBe(false);
  });
});
