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

jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));

const { Doc, DocVersion, DocMention, Workspace } = require('../../models');
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

describe('listMentionableUsers', () => {
  test('400 when workspaceId query param is missing', async () => {
    const req = { user: CALLER, query: {} };
    const res = mockRes();
    await docCtrl.listMentionableUsers(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Workspace.findByPk).not.toHaveBeenCalled();
  });

  test('403 when caller cannot see the workspace', async () => {
    // The first Workspace.findByPk inside canCallerSeeWorkspace returns a
    // workspace the caller is NOT a member of.
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: 'someone-else',
      workspaceMembers: [],
    }));
    const req = { user: CALLER, query: { workspaceId: 'w1' } };
    const res = mockRes();
    await docCtrl.listMentionableUsers(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('200 returns workspace creator + members (deduped), excludes self, capped at 25', async () => {
    // First findByPk: membership check (caller is a member → allowed)
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: 'creator-id',
      workspaceMembers: [{ id: CALLER.id }],
    }));

    // Build 30 members so we can verify the cap-at-25 trim.
    const members = [];
    for (let i = 0; i < 30; i += 1) {
      members.push({
        id: `member-${i}`,
        name: `Member ${String.fromCharCode(65 + (i % 26))}-${i}`,
        email: `member${i}@x.com`,
        avatar: null,
        isActive: true,
      });
    }
    // Include the caller themselves in the membership list — they MUST be
    // filtered out. Also duplicate the creator inside workspaceMembers to
    // verify dedup.
    const creator = {
      id: 'creator-id',
      name: 'Creator',
      email: 'creator@x.com',
      avatar: null,
      isActive: true,
    };
    members.push({ ...creator }); // dup
    members.push({ id: CALLER.id, name: 'Self', email: 'self@x.com', avatar: null, isActive: true });

    // Second findByPk: full listing
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: 'creator-id',
      workspaceMembers: members,
      creator,
    }));

    const req = { user: CALLER, query: { workspaceId: 'w1' } };
    const res = mockRes();
    await docCtrl.listMentionableUsers(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.users.length).toBeLessThanOrEqual(25);
    // self excluded
    expect(payload.data.users.find((u) => u.id === CALLER.id)).toBeUndefined();
    // creator only appears once
    const creatorRows = payload.data.users.filter((u) => u.id === 'creator-id');
    expect(creatorRows.length).toBeLessThanOrEqual(1);
  });

  test('filters by q substring on name (case-insensitive)', async () => {
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: 'other',
      workspaceMembers: [{ id: CALLER.id }],
    }));
    const candidates = [
      { id: 'm1', name: 'Alice Cooper', email: 'alice@x.com', avatar: null, isActive: true },
      { id: 'm2', name: 'Bob Marley', email: 'bob@x.com', avatar: null, isActive: true },
      { id: 'm3', name: 'Charlie Brown', email: 'charlie@x.com', avatar: null, isActive: true },
    ];
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: 'other',
      workspaceMembers: candidates,
      creator: null,
    }));

    const req = { user: CALLER, query: { workspaceId: 'w1', q: 'ALICE' } };
    const res = mockRes();
    await docCtrl.listMentionableUsers(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.users).toHaveLength(1);
    expect(payload.data.users[0].id).toBe('m1');
  });

  test('filters by q substring on email', async () => {
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: 'other',
      workspaceMembers: [{ id: CALLER.id }],
    }));
    const candidates = [
      { id: 'm1', name: 'Alice', email: 'alice@example.com', avatar: null, isActive: true },
      { id: 'm2', name: 'Bob', email: 'bob@other.com', avatar: null, isActive: true },
    ];
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: 'other',
      workspaceMembers: candidates,
      creator: null,
    }));

    const req = { user: CALLER, query: { workspaceId: 'w1', q: 'example' } };
    const res = mockRes();
    await docCtrl.listMentionableUsers(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.users).toHaveLength(1);
    expect(payload.data.users[0].email).toBe('alice@example.com');
  });

  test('excludes inactive users', async () => {
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: 'other',
      workspaceMembers: [{ id: CALLER.id }],
    }));
    const candidates = [
      { id: 'm1', name: 'Active', email: 'a@x.com', avatar: null, isActive: true },
      { id: 'm2', name: 'Inactive', email: 'i@x.com', avatar: null, isActive: false },
    ];
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: 'other',
      workspaceMembers: candidates,
      creator: null,
    }));

    const req = { user: CALLER, query: { workspaceId: 'w1' } };
    const res = mockRes();
    await docCtrl.listMentionableUsers(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.users).toHaveLength(1);
    expect(payload.data.users[0].id).toBe('m1');
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
