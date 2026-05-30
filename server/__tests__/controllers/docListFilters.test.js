'use strict';

/**
 * Phase 8 — listPersonalDocs filter chips + caller-relation enrichment.
 *
 * Tests:
 *   - filter='owned'     → narrows where.ownerUserId = caller.id
 *   - filter='shared'    → narrows to docIds where caller has
 *                          manual_share or legacy_workspace access
 *   - filter='mentioned' → narrows to docIds where caller has mention access
 *   - callerRelation populated correctly per row:
 *       owner / mentioned / shared / legacy / super_admin
 *   - super-admin sees all docs, gets 'super_admin' relation when not owner
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-key';

jest.mock('../../models', () => ({
  Doc: { findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn() },
  DocVersion: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), count: jest.fn() },
  DocMention: { findAll: jest.fn().mockResolvedValue([]) },
  DocTaskReference: { findAll: jest.fn().mockResolvedValue([]) },
  DocAccess: { findAll: jest.fn(), findOne: jest.fn() },
  Workspace: { findByPk: jest.fn() },
  User: { findByPk: jest.fn(), findAll: jest.fn() },
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));

const { Op } = require('sequelize');
const { Doc, DocAccess } = require('../../models');
const docCtrl = require('../../controllers/docController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const CALLER = { id: 'u-me', name: 'Me', isSuperAdmin: false };
const SUPER = { id: 'u-super', name: 'Super', isSuperAdmin: true };

// Build a Doc row that serializes cleanly via .toJSON.
function makeDoc({ id, ownerUserId = null, createdBy = null, isArchived = false }) {
  return {
    id,
    title: `Doc ${id}`,
    ownerUserId,
    createdBy,
    isArchived,
    contentText: '',
    toJSON() {
      return {
        id: this.id,
        title: this.title,
        ownerUserId: this.ownerUserId,
        createdBy: this.createdBy,
        isArchived: this.isArchived,
      };
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  Doc.findAll.mockResolvedValue([]);
  DocAccess.findAll.mockResolvedValue([]);
});

describe('Phase 8 — listPersonalDocs filter chips', () => {
  test("filter='owned' narrows where.ownerUserId to the caller", async () => {
    // getMyVisibleDocIds path: owner-only docs + access rows. We mock the
    // initial "owned" Doc.findAll lookup inside getMyVisibleDocIds + the
    // final Doc.findAll for the response.
    Doc.findAll
      .mockResolvedValueOnce([{ id: 'd1' }, { id: 'd2' }]) // getMyVisibleDocIds owner query
      .mockResolvedValueOnce([makeDoc({ id: 'd1', ownerUserId: CALLER.id })]); // final response
    DocAccess.findAll
      .mockResolvedValueOnce([]) // getMyVisibleDocIds shared query
      .mockResolvedValueOnce([]); // per-doc access enrichment

    const req = { user: CALLER, query: { filter: 'owned' } };
    const res = mockRes();
    await docCtrl.listPersonalDocs(req, res);

    // The FINAL Doc.findAll call is the response one — its where carries
    // ownerUserId narrow.
    const calls = Doc.findAll.mock.calls;
    const responseCall = calls[calls.length - 1][0];
    expect(responseCall.where.ownerUserId).toBe(CALLER.id);
  });

  test("filter='shared' resolves visibleIds from manual_share + legacy_workspace doc_access rows", async () => {
    DocAccess.findAll
      .mockResolvedValueOnce([
        { docId: 'd1', accessLevel: 'comment', source: 'manual_share' },
        { docId: 'd2', accessLevel: 'view',    source: 'legacy_workspace' },
      ]);
    Doc.findAll.mockResolvedValue([
      makeDoc({ id: 'd1', ownerUserId: 'owner1' }),
      makeDoc({ id: 'd2', ownerUserId: 'owner2' }),
    ]);

    const req = { user: CALLER, query: { filter: 'shared' } };
    const res = mockRes();
    await docCtrl.listPersonalDocs(req, res);

    // The DocAccess.findAll for 'shared' must request manual_share AND
    // legacy_workspace via Op.in.
    const accessCall = DocAccess.findAll.mock.calls[0][0];
    expect(accessCall.where.userId).toBe(CALLER.id);
    expect(accessCall.where.source[Op.in]).toEqual(['manual_share', 'legacy_workspace']);

    // Response shape: both docs included.
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.docs).toHaveLength(2);
  });

  test("filter='mentioned' resolves visibleIds from mention source only", async () => {
    DocAccess.findAll.mockResolvedValueOnce([
      { docId: 'dm1', accessLevel: 'comment', source: 'mention' },
    ]);
    Doc.findAll.mockResolvedValue([
      makeDoc({ id: 'dm1', ownerUserId: 'someone-else' }),
    ]);

    const req = { user: CALLER, query: { filter: 'mentioned' } };
    const res = mockRes();
    await docCtrl.listPersonalDocs(req, res);

    const accessCall = DocAccess.findAll.mock.calls[0][0];
    expect(accessCall.where.userId).toBe(CALLER.id);
    expect(accessCall.where.source).toBe('mention'); // not an Op.in, just the single source
  });

  test('callerRelation is populated correctly per row', async () => {
    // getMyVisibleDocIds — owner = d-own; shared via DocAccess = d-shared,
    // d-mentioned, d-legacy.
    Doc.findAll
      .mockResolvedValueOnce([{ id: 'd-own' }]) // owner query inside getMyVisibleDocIds
      .mockResolvedValueOnce([ // response query
        makeDoc({ id: 'd-own',       ownerUserId: CALLER.id }),
        makeDoc({ id: 'd-shared',    ownerUserId: 'owner-x' }),
        makeDoc({ id: 'd-mentioned', ownerUserId: 'owner-y' }),
        makeDoc({ id: 'd-legacy',    ownerUserId: 'owner-z' }),
      ]);
    DocAccess.findAll
      .mockResolvedValueOnce([ // shared lookup inside getMyVisibleDocIds
        { docId: 'd-shared' }, { docId: 'd-mentioned' }, { docId: 'd-legacy' },
      ])
      .mockResolvedValueOnce([ // per-doc access enrichment
        { docId: 'd-shared',    accessLevel: 'edit',    source: 'manual_share' },
        { docId: 'd-mentioned', accessLevel: 'comment', source: 'mention' },
        { docId: 'd-legacy',    accessLevel: 'view',    source: 'legacy_workspace' },
      ]);

    const req = { user: CALLER, query: {} };
    const res = mockRes();
    await docCtrl.listPersonalDocs(req, res);

    const docs = res.json.mock.calls[0][0].data.docs;
    const byId = Object.fromEntries(docs.map((d) => [d.id, d]));
    expect(byId['d-own'].callerRelation).toBe('owner');
    expect(byId['d-shared'].callerRelation).toBe('shared');
    expect(byId['d-mentioned'].callerRelation).toBe('mentioned');
    expect(byId['d-legacy'].callerRelation).toBe('legacy');
    // callerAccessLevel surfaces alongside.
    expect(byId['d-shared'].callerAccessLevel).toBe('edit');
    expect(byId['d-own'].callerAccessLevel).toBe('owner');
  });

  test('super-admin viewing another user\'s doc gets relation=super_admin', async () => {
    // Super-admin path: getMyVisibleDocIds returns every doc id.
    Doc.findAll
      .mockResolvedValueOnce([{ id: 'd1' }, { id: 'd2' }]) // super-admin: all docs
      .mockResolvedValueOnce([
        makeDoc({ id: 'd1', ownerUserId: 'someone-else' }),
        makeDoc({ id: 'd2', ownerUserId: SUPER.id }), // their own doc
      ]);
    // No doc_access rows for super-admin.
    DocAccess.findAll.mockResolvedValue([]);

    const req = { user: SUPER, query: {} };
    const res = mockRes();
    await docCtrl.listPersonalDocs(req, res);

    const docs = res.json.mock.calls[0][0].data.docs;
    const byId = Object.fromEntries(docs.map((d) => [d.id, d]));
    expect(byId.d1.callerRelation).toBe('super_admin');
    expect(byId.d2.callerRelation).toBe('owner'); // they ARE the owner of d2
  });
});
