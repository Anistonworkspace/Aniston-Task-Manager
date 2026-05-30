'use strict';

/**
 * Phase 9 — privacy & sharing integration tests.
 *
 * Maps to the user's testing checklist:
 *   Personal privacy:
 *     - User A creates doc → User B cannot see it (list + read + AI)
 *     - User B cannot find it via the picker / search
 *   Mention sharing:
 *     - User A mentions User B → B gets access automatically
 *     - User B sees the doc under "Mentioned me" filter
 *     - User C still cannot see it
 *     - Removing the mention removes the mention-source access row
 *   Manual sharing (safe-rule overlap):
 *     - Removing a mention does NOT strip access if the user also has
 *       a manual_share row.
 *
 * These tests drive the actual controller handlers with mocked Sequelize
 * models. They verify the end-to-end behavior wired across Phases 2–5
 * (doc_access, mention sync, list filter, hasDocAccess gate).
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key';

jest.mock('../../models', () => ({
  Doc: { findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn() },
  DocVersion: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), count: jest.fn().mockResolvedValue(0) },
  DocMention: { findAll: jest.fn().mockResolvedValue([]), create: jest.fn(), destroy: jest.fn() },
  DocTaskReference: { findAll: jest.fn().mockResolvedValue([]), create: jest.fn(), destroy: jest.fn() },
  DocAccess: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), destroy: jest.fn() },
  Workspace: { findByPk: jest.fn() },
  User: { findByPk: jest.fn(), findAll: jest.fn() },
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/socketService', () => ({ emitToUsers: jest.fn() }));

const { Op } = require('sequelize');
const { Doc, DocMention, DocAccess, User } = require('../../models');
const docCtrl = require('../../controllers/docController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

// UUID-shaped IDs — extractMentions enforces UUID regex before creating
// any DocMention rows, so mention-flow tests need real-shape user IDs.
const USER_A = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Alice', isSuperAdmin: false };
const USER_B = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Bob',   isSuperAdmin: false };
const USER_C = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'Char',  isSuperAdmin: false };

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible defaults — most calls return empty so tests overlay only the
  // specific shape they need.
  Doc.findAll.mockResolvedValue([]);
  DocAccess.findAll.mockResolvedValue([]);
  DocAccess.findOne.mockResolvedValue(null);
  DocMention.findAll.mockResolvedValue([]);
  User.findAll.mockImplementation((opts) => {
    const ids = (opts && opts.where && opts.where.id && opts.where.id[Op.in]) || [];
    // Default: every requested user is active+approved.
    return Promise.resolve(ids.map((id) => ({ id })));
  });
});

describe('Phase 9 — Personal privacy: User A creates doc, User B cannot see it', () => {
  test('listPersonalDocs as User B does NOT return User A\'s doc', async () => {
    // User B's getMyVisibleDocIds: no owned docs, no access rows → []
    Doc.findAll.mockResolvedValue([]); // owner query inside getMyVisibleDocIds
    DocAccess.findAll.mockResolvedValue([]); // access query

    const req = { user: USER_B, query: {} };
    const res = mockRes();
    await docCtrl.listPersonalDocs(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.docs).toEqual([]);
  });

  test('getDoc as User B with a docId they don\'t own → 403', async () => {
    // The doc exists; User A owns it.
    Doc.findByPk.mockResolvedValue({
      id: 'd-private',
      ownerUserId: USER_A.id,
      title: 'Alice\'s secret',
      toJSON() { return { id: this.id, title: this.title, ownerUserId: this.ownerUserId }; },
    });
    DocAccess.findOne.mockResolvedValue(null); // User B has no grant

    const req = { user: USER_B, params: { id: 'd-private' } };
    const res = mockRes();
    await docCtrl.getDoc(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('AI summarize gate denies User B on User A\'s doc', async () => {
    // Use the AI controller's summarizeDocEndpoint path.
    jest.mock('../../services/aiSummaryService', () => ({}), { virtual: false });
    Doc.findByPk.mockResolvedValue({
      id: 'd-private',
      ownerUserId: USER_A.id,
      title: 'Secret',
    });
    DocAccess.findOne.mockResolvedValue(null);

    const aiCtrl = require('../../controllers/aiController');
    const req = { user: USER_B, params: { id: 'd-private' }, body: {} };
    const res = mockRes();
    await aiCtrl.summarizeDocEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      message: expect.stringMatching(/do not have access/i),
    }));
  });
});

describe('Phase 9 — Mention sharing: full flow A mentions B', () => {
  test('mention writes DocMention + DocAccess row + emits doc:access:granted', async () => {
    // Setup: A's doc exists, mention sync drives a fresh PATCH.
    const docInstance = {
      id: 'd-alice',
      ownerUserId: USER_A.id,
      contentFormat: 'tiptap_json',
      contentJson: { type: 'doc', content: [] },
      title: 'Alice doc',
      isArchived: false,
      legacyContentJson: null,
      update: jest.fn().mockResolvedValue(undefined),
      toJSON() { return { id: this.id }; },
    };
    Doc.findByPk.mockResolvedValue(docInstance);

    const mentionContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [
          { type: 'mention', attrs: { id: USER_B.id, label: 'Bob' } },
        ] },
      ],
    };

    // DocMention starts empty (no prior mention of B). DocAccess starts empty.
    DocMention.findAll.mockResolvedValue([]);
    DocAccess.findOne.mockResolvedValue(null);
    DocAccess.create.mockResolvedValue({ id: 'a-new' });
    DocMention.create.mockResolvedValue({ id: 'm-new' });

    // User.findAll returns USER_B as active (default impl handles this).
    User.findAll.mockResolvedValue([{ id: USER_B.id }]);

    const req = {
      user: USER_A,
      params: { id: 'd-alice' },
      body: { contentJson: mentionContent },
    };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);
    // Mention sync is fire-and-forget — give it a tick to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // A DocMention row was created targeting USER_B.
    expect(DocMention.create).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd-alice',
      mentionedUserId: USER_B.id,
      mentionedByUserId: USER_A.id,
    }));
    // A DocAccess(comment, mention) row was created for USER_B.
    expect(DocAccess.create).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd-alice',
      userId: USER_B.id,
      accessLevel: 'comment',
      source: 'mention',
      grantedByUserId: USER_A.id,
    }));
    // doc:access:granted was emitted to USER_B only.
    const socketService = require('../../services/socketService');
    const grantedCalls = socketService.emitToUsers.mock.calls
      .filter((c) => c[0] === 'doc:access:granted');
    expect(grantedCalls).toHaveLength(1);
    expect(grantedCalls[0][2]).toEqual([USER_B.id]);
  });

  test('after mention, User B\'s list-with-filter=mentioned returns the doc', async () => {
    // User B's mention-source DocAccess lookup returns the new grant.
    DocAccess.findAll
      .mockResolvedValueOnce([ // filter='mentioned' lookup
        { docId: 'd-alice', accessLevel: 'comment', source: 'mention' },
      ])
      .mockResolvedValueOnce([ // per-doc enrichment
        { docId: 'd-alice', accessLevel: 'comment', source: 'mention' },
      ]);
    Doc.findAll.mockResolvedValue([
      {
        id: 'd-alice', ownerUserId: USER_A.id, title: 'Alice doc',
        toJSON() { return { id: this.id, ownerUserId: this.ownerUserId, title: this.title }; },
      },
    ]);

    const req = { user: USER_B, query: { filter: 'mentioned' } };
    const res = mockRes();
    await docCtrl.listPersonalDocs(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.data.docs).toHaveLength(1);
    expect(payload.data.docs[0].id).toBe('d-alice');
    expect(payload.data.docs[0].callerRelation).toBe('mentioned');
    expect(payload.data.docs[0].callerAccessLevel).toBe('comment');
  });

  test('User C (not mentioned, no access) still cannot see the doc', async () => {
    // User C: empty getMyVisibleDocIds → empty list.
    Doc.findAll.mockResolvedValue([]);
    DocAccess.findAll.mockResolvedValue([]);

    const req = { user: USER_C, query: {} };
    const res = mockRes();
    await docCtrl.listPersonalDocs(req, res);

    expect(res.json.mock.calls[0][0].data.docs).toEqual([]);
  });
});

describe('Phase 9 — Safe rule: manual_share survives mention removal', () => {
  test('removing the mention does NOT delete access when source is manual_share', async () => {
    const docInstance = {
      id: 'd-alice',
      ownerUserId: USER_A.id,
      contentFormat: 'tiptap_json',
      contentJson: { type: 'doc', content: [] },
      title: 'Alice doc',
      isArchived: false,
      legacyContentJson: null,
      update: jest.fn().mockResolvedValue(undefined),
      toJSON() { return { id: this.id }; },
    };
    Doc.findByPk.mockResolvedValue(docInstance);

    // BEFORE: USER_B was mentioned (DocMention exists) AND had a manual_share
    // row (override path: source='manual_share' instead of 'mention').
    DocMention.findAll.mockResolvedValue([
      { id: 'm-existing', mentionedUserId: USER_B.id },
    ]);

    // NEW save: no mentions in the body.
    const emptyContent = { type: 'doc', content: [{ type: 'paragraph' }] };

    // Phase 5 batch query: DocAccess.findAll(source='mention') for removed
    // mention userIds. Returns EMPTY because USER_B's row is source='manual_share'.
    DocAccess.findAll.mockResolvedValue([]); // no mention-source row to prune
    DocMention.destroy.mockResolvedValue(1);

    const req = {
      user: USER_A,
      params: { id: 'd-alice' },
      body: { contentJson: emptyContent },
    };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // DocMention row was destroyed (back-ref cleanup).
    expect(DocMention.destroy).toHaveBeenCalled();
    // BUT DocAccess.destroy was NOT called — safe rule preserves the
    // manual_share grant.
    expect(DocAccess.destroy).not.toHaveBeenCalled();
    // No doc:access:revoked event fired either.
    const socketService = require('../../services/socketService');
    const revokedCalls = socketService.emitToUsers.mock.calls
      .filter((c) => c[0] === 'doc:access:revoked');
    expect(revokedCalls).toHaveLength(0);
  });

  test('mention removal DOES delete access when source is mention (the basic case)', async () => {
    const docInstance = {
      id: 'd-alice',
      ownerUserId: USER_A.id,
      contentFormat: 'tiptap_json',
      contentJson: { type: 'doc', content: [] },
      title: 'Alice doc',
      isArchived: false,
      legacyContentJson: null,
      update: jest.fn().mockResolvedValue(undefined),
      toJSON() { return { id: this.id }; },
    };
    Doc.findByPk.mockResolvedValue(docInstance);

    DocMention.findAll.mockResolvedValue([
      { id: 'm-existing', mentionedUserId: USER_B.id },
    ]);
    // Phase 5 batch query returns USER_B's mention-source row.
    DocAccess.findAll.mockResolvedValue([{ userId: USER_B.id }]);
    DocAccess.destroy.mockResolvedValue(1);
    DocMention.destroy.mockResolvedValue(1);

    const emptyContent = { type: 'doc', content: [{ type: 'paragraph' }] };
    const req = {
      user: USER_A,
      params: { id: 'd-alice' },
      body: { contentJson: emptyContent },
    };
    await docCtrl.updateDoc(req, mockRes());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Both DocMention AND DocAccess rows destroyed.
    expect(DocMention.destroy).toHaveBeenCalled();
    expect(DocAccess.destroy).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        docId: 'd-alice',
        source: 'mention',
      }),
    }));
    // doc:access:revoked emitted to USER_B only.
    const socketService = require('../../services/socketService');
    const revokedCalls = socketService.emitToUsers.mock.calls
      .filter((c) => c[0] === 'doc:access:revoked');
    expect(revokedCalls).toHaveLength(1);
    expect(revokedCalls[0][2]).toEqual([USER_B.id]);
  });
});

describe('Phase 9 — Inactive users excluded from mention path', () => {
  test('mentioning a deactivated user is silently dropped (no row, no access, no notify)', async () => {
    const docInstance = {
      id: 'd-alice',
      ownerUserId: USER_A.id,
      contentFormat: 'tiptap_json',
      contentJson: { type: 'doc', content: [] },
      title: 'Alice doc',
      isArchived: false,
      legacyContentJson: null,
      update: jest.fn().mockResolvedValue(undefined),
      toJSON() { return { id: this.id }; },
    };
    Doc.findByPk.mockResolvedValue(docInstance);
    DocMention.findAll.mockResolvedValue([]);

    // The active-user validation returns EMPTY — simulating a deactivated
    // or pending user. Phase 5 logic must drop the mention entirely.
    User.findAll.mockResolvedValue([]);

    const mentionContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'mention', attrs: { id: USER_B.id, label: 'Inactive Bob' } },
      ] }],
    };
    const req = {
      user: USER_A,
      params: { id: 'd-alice' },
      body: { contentJson: mentionContent },
    };
    await docCtrl.updateDoc(req, mockRes());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Nothing written, nothing emitted.
    expect(DocMention.create).not.toHaveBeenCalled();
    expect(DocAccess.create).not.toHaveBeenCalled();
    const socketService = require('../../services/socketService');
    expect(socketService.emitToUsers).not.toHaveBeenCalled();
  });
});
