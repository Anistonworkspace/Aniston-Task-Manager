'use strict';

/**
 * Unit tests for the Phase D Slice 1 mention features in docController.
 *
 * Three surfaces are covered:
 *   1. __extractMentions(contentJson) — pure helper exported for tests.
 *   2. listMentionableUsers(req, res) — GET /api/docs/mentionable endpoint.
 *   3. syncDocMentionsAndNotify fan-out triggered by createDoc / updateDoc
 *      (fire-and-forget — tests yield one microtask before asserting).
 *
 * All Sequelize models and the notification service are mocked. No real
 * DB or socket I/O.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

const { Op } = require('sequelize');

// ─── Mocks (declared BEFORE the controller is required so the lazy
//     `require('../services/notificationService')` inside the controller
//     picks up our mock) ─────────────────────────────────────────────────────

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
  DocMention: {
    findAll: jest.fn(),
    create: jest.fn(),
    destroy: jest.fn(),
  },
  // Phase 5 — doc_access write/delete after mention sync, gated by the
  // safe rule (only source='mention' rows are pruned).
  DocAccess: {
    findOne: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    destroy: jest.fn(),
  },
  Workspace: {
    findByPk: jest.fn(),
  },
  // Phase 5 — active-user validation before any mention row is created.
  // Default echoes every requested userId back as active; specific tests
  // can override to simulate deactivated users.
  User: {
    findAll: jest.fn(),
    findByPk: jest.fn(),
  },
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

jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));

// Phase 5 — mention sync emits realtime `doc:access:granted` /
// `doc:access:revoked` to the affected user. Mocked at the module level
// so the controller's lazy `require('../services/socketService')` picks
// up the jest.fn instead of trying to instantiate a real socket.io server.
jest.mock('../../services/socketService', () => ({
  emitToUsers: jest.fn(),
}));

const { Doc, DocVersion, DocMention, DocAccess, User, Workspace } = require('../../models');
const notificationService = require('../../services/notificationService');
const docCtrl = require('../../controllers/docController');

const { __extractMentions } = docCtrl;

// ─── shared helpers ────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

// Yield twice so the fire-and-forget syncDocMentionsAndNotify Promise
// (which itself awaits findAll, then create, then createNotification)
// has a chance to settle before assertions run.
async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';
const BAD_UUID = 'not-a-uuid';

const ADMIN = { id: 'u-admin', name: 'Admin', role: 'admin', isSuperAdmin: false };
const MANAGER = { id: 'u-manager', name: 'Manager', role: 'manager', isSuperAdmin: false };
const MEMBER = { id: 'u-member', name: 'Mem', role: 'member', isSuperAdmin: false };
const CALLER = { id: 'u-caller', name: 'Caller', role: 'member', isSuperAdmin: false };

function makeWorkspace(overrides = {}) {
  return {
    id: 'w1',
    name: 'Test WS',
    createdBy: ADMIN.id,
    workspaceMembers: [],
    creator: null,
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
    createdBy: ADMIN.id,
    lastEditedBy: ADMIN.id,
    lastEditedAt: new Date('2026-05-01T00:00:00Z'),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  doc.toJSON = function () {
    const out = {};
    for (const k of Object.keys(this)) {
      if (typeof this[k] !== 'function') out[k] = this[k];
    }
    return out;
  };
  return doc;
}

function mention(id, label) {
  return { type: 'mention', attrs: { id, label: label || id } };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible defaults — individual tests override.
  DocMention.findAll.mockResolvedValue([]);
  DocMention.create.mockResolvedValue({});
  DocMention.destroy.mockResolvedValue(0);
  notificationService.createNotification.mockResolvedValue({});
  // Phase 5 — default User.findAll echoes every requested id back as
  // active+approved. Tests that want to simulate a deactivated user
  // override per-test.
  User.findAll.mockImplementation((opts) => {
    const ids = (opts && opts.where && opts.where.id && opts.where.id[Op.in]) || [];
    return Promise.resolve(ids.map((id) => ({ id })));
  });
  // Phase 5 — doc_access default state: no existing rows, no upsert race.
  DocAccess.findOne.mockResolvedValue(null);
  DocAccess.findAll.mockResolvedValue([]);
  DocAccess.create.mockResolvedValue({ id: 'a-new' });
  DocAccess.destroy.mockResolvedValue(0);
});

// ───────────────────────────────────────────────────────────────────────────
// __extractMentions (pure helper)
// ───────────────────────────────────────────────────────────────────────────

describe('__extractMentions', () => {
  test('returns [] for null, undefined, non-object, or no content', () => {
    expect(__extractMentions(null)).toEqual([]);
    expect(__extractMentions(undefined)).toEqual([]);
    expect(__extractMentions('not-an-object')).toEqual([]);
    expect(__extractMentions(42)).toEqual([]);
    // Object with no `content` key — walker returns immediately.
    expect(__extractMentions({ type: 'doc' })).toEqual([]);
  });

  test('returns [] for a doc with no mention nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'No mentions here' }] },
      ],
    };
    expect(__extractMentions(doc)).toEqual([]);
  });

  test('extracts a single mention inside a paragraph', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hi ' },
            mention(UUID_A, 'Alice'),
            { type: 'text', text: '!' },
          ],
        },
      ],
    };
    const out = __extractMentions(doc);
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe(UUID_A);
    expect(typeof out[0].anchorOffset).toBe('number');
  });

  test('dedupes when the same user is mentioned twice', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [mention(UUID_A, 'Alice'), { type: 'text', text: ' and ' }, mention(UUID_A, 'Alice')] },
      ],
    };
    const out = __extractMentions(doc);
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe(UUID_A);
  });

  test('drops mentions with non-UUID ids but keeps valid ones', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            mention(BAD_UUID, 'Bad'),
            mention(UUID_A, 'Alice'),
            mention('', 'Empty'),
          ],
        },
      ],
    };
    const out = __extractMentions(doc);
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe(UUID_A);
  });

  test('walks nested structures (mention inside listItem inside bulletList)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'cc ' },
                    mention(UUID_B, 'Bob'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = __extractMentions(doc);
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe(UUID_B);
  });

  test('anchorOffset increases monotonically with text length before each mention', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello world ' }, // 12 chars
            mention(UUID_A, 'Alice'),               // first mention — offset 12
            { type: 'text', text: ' and then some more text ' },
            mention(UUID_B, 'Bob'),                 // second mention — strictly greater
          ],
        },
      ],
    };
    const out = __extractMentions(doc);
    expect(out).toHaveLength(2);
    expect(out[0].userId).toBe(UUID_A);
    expect(out[1].userId).toBe(UUID_B);
    expect(out[0].anchorOffset).toBe(12);
    expect(out[1].anchorOffset).toBeGreaterThan(out[0].anchorOffset);
  });

  test('ignores mention nodes with missing or empty attrs.id', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention' }, // no attrs at all
            { type: 'mention', attrs: {} }, // empty attrs
            { type: 'mention', attrs: { id: '' } }, // empty id
            { type: 'mention', attrs: { id: null } }, // null id
            mention(UUID_A, 'Alice'),
          ],
        },
      ],
    };
    const out = __extractMentions(doc);
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe(UUID_A);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// listMentionableUsers
// ───────────────────────────────────────────────────────────────────────────

describe('listMentionableUsers (legacy endpoint — Phase 4 delegation)', () => {
  // feat/docs-personal-notion Phase 4 — this endpoint is now a thin
  // delegation to userMentionController.searchMentionableUsers. The
  // workspace-scoped semantics it used to enforce (creator + members +
  // dedup + cap + self-exclude + name/email filter) live in the global
  // controller now and are covered by
  //   server/__tests__/controllers/userMentionController.test.js
  // The single delegation test below verifies the legacy /api/docs/mentionable
  // path still works AND ignores the old workspaceId query param.

  test('delegates to global searchMentionableUsers (workspaceId ignored)', async () => {
    // The User model isn't in this file's mock barrel (the original suite
    // tested workspace-scoped logic via Workspace.findByPk only). Stub it
    // inline so the delegation can run.
    const models = require('../../models');
    if (!models.User || typeof models.User.findAll !== 'function') {
      models.User = { findAll: jest.fn() };
    }
    models.User.findAll = jest.fn().mockResolvedValue([
      { id: 'u1', name: 'Alice', email: 'alice@x.com', avatar: null },
    ]);

    const req = { user: CALLER, query: { workspaceId: 'IGNORED', q: 'al' } };
    const res = mockRes();
    await docCtrl.listMentionableUsers(req, res);

    expect(models.User.findAll).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.users).toEqual([
      { id: 'u1', name: 'Alice', email: 'alice@x.com', avatar: null },
    ]);
    // Workspace lookup is NOT consulted anymore — workspaceId is a no-op.
    expect(Workspace.findByPk).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Notification fan-out via createDoc / updateDoc
// ───────────────────────────────────────────────────────────────────────────

describe('mention sync via createDoc', () => {
  test('inserts a DocMention row AND calls createNotification with the right idempotencyKey', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    const created = makeDoc({ id: 'd-new', title: 'Greetings', createdBy: ADMIN.id });
    Doc.create.mockResolvedValue(created);
    Doc.findByPk.mockResolvedValue(created);
    DocMention.findAll.mockResolvedValue([]);

    const contentJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hi ' }, mention(UUID_A, 'Alice')] },
      ],
    };
    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: 'Greetings', contentJson },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    await flushAsync();

    expect(DocMention.create).toHaveBeenCalledTimes(1);
    const insertArgs = DocMention.create.mock.calls[0][0];
    expect(insertArgs.docId).toBe('d-new');
    expect(insertArgs.mentionedUserId).toBe(UUID_A);
    expect(insertArgs.mentionedByUserId).toBe(ADMIN.id);

    expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
    const notifArgs = notificationService.createNotification.mock.calls[0][0];
    expect(notifArgs.userId).toBe(UUID_A);
    expect(notifArgs.type).toBe('doc_mention');
    expect(notifArgs.entityType).toBe('doc');
    expect(notifArgs.entityId).toBe('d-new');
    expect(notifArgs.idempotencyKey).toBe(`doc-mention:d-new:${UUID_A}`);
  });

  test('does NOT call createNotification when the doc has no mentions', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    const created = makeDoc({ id: 'd-new', title: 'Plain', createdBy: ADMIN.id });
    Doc.create.mockResolvedValue(created);
    Doc.findByPk.mockResolvedValue(created);
    DocMention.findAll.mockResolvedValue([]);

    const contentJson = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'no mentions here' }] }],
    };
    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: 'Plain', contentJson },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    await flushAsync();

    expect(DocMention.create).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  test('still returns 201 if DocMention.findAll rejects (fire-and-forget catch)', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    const created = makeDoc({ id: 'd-new', title: 'Boom', createdBy: ADMIN.id });
    Doc.create.mockResolvedValue(created);
    Doc.findByPk.mockResolvedValue(created);
    DocMention.findAll.mockRejectedValue(new Error('DB down'));

    const contentJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [mention(UUID_A, 'Alice')] },
      ],
    };
    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: 'Boom', contentJson },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);
    // Must still succeed
    expect(res.status).toHaveBeenCalledWith(201);

    await flushAsync();
    // No notification because the sync threw before it could fire
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});

describe('mention sync via updateDoc', () => {
  test('adds a new mention vs existing rows → inserts and notifies once', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc)  // initial lookup
      .mockResolvedValueOnce(doc); // reload
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});

    // Existing: UUID_A. Incoming: UUID_A + UUID_B. So only UUID_B should
    // be inserted and notified.
    DocMention.findAll.mockResolvedValue([
      { id: 'mention-row-a', mentionedUserId: UUID_A },
    ]);

    const newJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [mention(UUID_A, 'Alice'), { type: 'text', text: ' and ' }, mention(UUID_B, 'Bob')] },
      ],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: newJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    await flushAsync();

    expect(DocMention.create).toHaveBeenCalledTimes(1);
    const insertArgs = DocMention.create.mock.calls[0][0];
    expect(insertArgs.mentionedUserId).toBe(UUID_B);

    expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
    expect(notificationService.createNotification.mock.calls[0][0].userId).toBe(UUID_B);
    expect(notificationService.createNotification.mock.calls[0][0].idempotencyKey)
      .toBe(`doc-mention:d1:${UUID_B}`);
  });

  test('re-saving WITHOUT changing mentions → does NOT re-notify or re-insert', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});

    // Existing already contains UUID_A and the incoming JSON has only UUID_A —
    // so no insert, no destroy, no notification.
    DocMention.findAll.mockResolvedValue([
      { id: 'mention-row-a', mentionedUserId: UUID_A },
    ]);

    const sameMentionJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'still mentioning ' }, mention(UUID_A, 'Alice')] },
      ],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: sameMentionJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    await flushAsync();

    expect(DocMention.create).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(DocMention.destroy).not.toHaveBeenCalled();
  });

  test('removing a mention → calls DocMention.destroy but does NOT un-notify', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});

    // Existing has UUID_A + UUID_B. Incoming only has UUID_A. UUID_B should
    // be destroyed; no notification calls (deletions don't un-notify).
    DocMention.findAll.mockResolvedValue([
      { id: 'row-a', mentionedUserId: UUID_A },
      { id: 'row-b', mentionedUserId: UUID_B },
    ]);

    const trimmedJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [mention(UUID_A, 'Alice')] },
      ],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: trimmedJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    await flushAsync();

    expect(DocMention.destroy).toHaveBeenCalledTimes(1);
    const destroyArgs = DocMention.destroy.mock.calls[0][0];
    expect(destroyArgs.where.docId).toBe('d1');
    // The Op.in clause should target UUID_B (and only UUID_B)
    expect(destroyArgs.where.mentionedUserId[Op.in]).toEqual([UUID_B]);

    // No notification fired (re-add UUID_A is unchanged; removed UUID_B is silent)
    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(DocMention.create).not.toHaveBeenCalled();
  });

  test('still returns 200 if DocMention.findAll rejects (fire-and-forget catch)', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});
    DocMention.findAll.mockRejectedValue(new Error('mention table broken'));

    const newJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [mention(UUID_A, 'Alice')] },
      ],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: newJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);
    // Save still succeeds — no 500/400
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);

    await flushAsync();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 5 — mention → doc_access wiring
// ───────────────────────────────────────────────────────────────────────────

describe('mention → doc_access wiring (Phase 5)', () => {
  // socketService is mocked at file-level (see top of file). We pull the
  // reference here so each test can assert on its emitToUsers calls.
  const socketService = require('../../services/socketService');

  test('newly inserted mention → upsertAccess(comment, mention) + emits doc:access:granted', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk.mockResolvedValueOnce(doc).mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});
    DocMention.findAll.mockResolvedValue([]); // no existing mentions

    // upsertAccess flow: findOne → null (no row) → create
    DocAccess.findOne.mockResolvedValue(null);
    DocAccess.create.mockResolvedValue({ id: 'a-new' });

    const json = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [mention(UUID_A, 'Alice')] }],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: json } };
    await docCtrl.updateDoc(req, mockRes());
    await flushAsync();

    expect(DocAccess.create).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd1',
      userId: UUID_A,
      accessLevel: 'comment',
      source: 'mention',
      grantedByUserId: ADMIN.id,
    }));
    expect(socketService.emitToUsers).toHaveBeenCalledWith(
      'doc:access:granted',
      expect.objectContaining({ docId: 'd1', source: 'mention' }),
      [UUID_A],
    );
  });

  test('mention upgrade is a no-op when user already has higher access (no downgrade)', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk.mockResolvedValueOnce(doc).mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});
    DocMention.findAll.mockResolvedValue([]);

    // User already has 'edit' — upsertAccess returns { created:false, upgraded:false }
    DocAccess.findOne.mockResolvedValue({
      accessLevel: 'edit',
      update: jest.fn().mockResolvedValue(undefined),
    });

    const json = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [mention(UUID_A, 'Alice')] }],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: json } };
    await docCtrl.updateDoc(req, mockRes());
    await flushAsync();

    expect(DocAccess.create).not.toHaveBeenCalled();
    // No realtime emit fires when nothing actually changed.
    const grantedCalls = socketService.emitToUsers.mock.calls
      .filter((c) => c[0] === 'doc:access:granted');
    expect(grantedCalls).toHaveLength(0);
  });

  test('removed mention with source=mention → deletes doc_access + emits doc:access:revoked', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk.mockResolvedValueOnce(doc).mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});
    // Existing has UUID_B mention; incoming has no mentions → UUID_B removed.
    DocMention.findAll.mockResolvedValue([
      { id: 'row-b', mentionedUserId: UUID_B },
    ]);
    // doc_access lookup says UUID_B's row has source='mention' → safe to delete.
    DocAccess.findAll.mockResolvedValue([{ userId: UUID_B }]);
    DocAccess.destroy.mockResolvedValue(1);

    const emptyJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'no mentions' }] }] };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: emptyJson } };
    await docCtrl.updateDoc(req, mockRes());
    await flushAsync();

    expect(DocMention.destroy).toHaveBeenCalled();
    // The mention-removal query selects rows with source='mention' only.
    // (updateDoc also issues an unrelated DocAccess.findAll to resolve
    // doc:updated fan-out recipients, so locate the mention call by its
    // WHERE clause rather than assuming it's the first findAll.)
    const findAllArgs = DocAccess.findAll.mock.calls
      .map((c) => c[0])
      .find((args) => args?.where?.source === 'mention');
    expect(findAllArgs).toBeDefined();
    expect(findAllArgs.where.source).toBe('mention');
    expect(findAllArgs.where.docId).toBe('d1');
    // The destroy query targets the same source='mention' subset.
    expect(DocAccess.destroy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ docId: 'd1', source: 'mention' }),
    }));
    expect(socketService.emitToUsers).toHaveBeenCalledWith(
      'doc:access:revoked',
      expect.objectContaining({ docId: 'd1', source: 'mention' }),
      [UUID_B],
    );
  });

  test('removed mention whose access row is source=manual_share → access SURVIVES (safe rule)', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk.mockResolvedValueOnce(doc).mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});
    DocMention.findAll.mockResolvedValue([
      { id: 'row-b', mentionedUserId: UUID_B },
    ]);
    // doc_access lookup returns EMPTY — because the only row for UUID_B has
    // source='manual_share' (not 'mention'), so the WHERE source='mention'
    // query finds nothing.
    DocAccess.findAll.mockResolvedValue([]);

    const emptyJson = { type: 'doc', content: [{ type: 'paragraph' }] };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: emptyJson } };
    await docCtrl.updateDoc(req, mockRes());
    await flushAsync();

    // DocMention row was destroyed (back-ref) but doc_access stays.
    expect(DocMention.destroy).toHaveBeenCalled();
    expect(DocAccess.destroy).not.toHaveBeenCalled();
    // No revoked emit because no access actually went away.
    const revokedCalls = socketService.emitToUsers.mock.calls
      .filter((c) => c[0] === 'doc:access:revoked');
    expect(revokedCalls).toHaveLength(0);
  });

  test('mention pointing at an inactive user is silently dropped (no row, no grant, no notify)', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk.mockResolvedValueOnce(doc).mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});
    DocMention.findAll.mockResolvedValue([]);

    // Override the default echo-all User.findAll to return NO active rows —
    // simulating "the mentioned user was just deactivated".
    User.findAll.mockResolvedValueOnce([]);

    const json = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [mention(UUID_A, 'GhostUser')] }],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: json } };
    await docCtrl.updateDoc(req, mockRes());
    await flushAsync();

    expect(DocMention.create).not.toHaveBeenCalled();
    expect(DocAccess.create).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  test('self-mention is ignored — owner never gets a doc_access row for their own doc', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk.mockResolvedValueOnce(doc).mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});
    DocMention.findAll.mockResolvedValue([]);

    const json = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [mention(ADMIN.id, 'Me')] }],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: json } };
    await docCtrl.updateDoc(req, mockRes());
    await flushAsync();

    expect(DocMention.create).not.toHaveBeenCalled();
    expect(DocAccess.create).not.toHaveBeenCalled();
  });

  test('only mention-source access rows are pruned (multi-source removal is filtered server-side)', async () => {
    // Setup: removing 2 users at once. Server returns only the one whose
    // source='mention'; the other has source='manual_share' and won't appear
    // in the findAll result → only the mention-source row is destroyed.
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk.mockResolvedValueOnce(doc).mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});
    DocMention.findAll.mockResolvedValue([
      { id: 'row-b', mentionedUserId: UUID_B },
      { id: 'row-c', mentionedUserId: UUID_C },
    ]);
    // Only UUID_B's access row has source='mention'. UUID_C is manual_share.
    DocAccess.findAll.mockResolvedValue([{ userId: UUID_B }]);

    const emptyJson = { type: 'doc', content: [{ type: 'paragraph' }] };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: emptyJson } };
    await docCtrl.updateDoc(req, mockRes());
    await flushAsync();

    expect(DocAccess.destroy).toHaveBeenCalledTimes(1);
    // Targeted emit only to the user whose access actually went away.
    const revokedCalls = socketService.emitToUsers.mock.calls
      .filter((c) => c[0] === 'doc:access:revoked');
    expect(revokedCalls).toHaveLength(1);
    expect(revokedCalls[0][2]).toEqual([UUID_B]); // recipient list
  });
});
