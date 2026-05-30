'use strict';

/**
 * Unit tests for the Phase G doc-collab service.
 *
 * Surfaces under test:
 *   - POST /api/docs-collab/ticket
 *       - 400 missing docId
 *       - 404 unknown doc
 *       - 403 archived doc
 *       - 403 caller outside workspace
 *       - 200 happy path signs a JWT with the right purpose + docId
 *   - buildHocuspocusConfig(deps).onAuthenticate
 *       - rejects token with wrong purpose
 *       - rejects token whose docId doesn't match documentName
 *       - resolves a valid ticket
 *   - buildHocuspocusConfig(deps).onLoadDocument
 *       - returns empty Y.doc when yjsState null AND contentJson empty
 *       - throws "not migrated" when yjsState null AND contentJson has content
 *       - returns hydrated Y.doc when yjsState non-null
 *   - buildHocuspocusConfig(deps).onStoreDocument
 *       - persists encoded state into the DB
 *
 * Mock strategy: Y and Doc are jest mocks so the test does NOT spin up a
 * real Hocuspocus instance. The route is exercised directly via Express
 * + supertest with mocked models.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

const jwt = require('jsonwebtoken');

// ─── Mock the models barrel before anything pulls it in ───────────────
jest.mock('../../models', () => ({
  Doc: { findByPk: jest.fn(), update: jest.fn() },
  Workspace: { findByPk: jest.fn() },
  User: { findByPk: jest.fn() },
  // feat/docs-personal-notion Phase 3 — ticket endpoint + onAuthenticate
  // gate on docAccessSvc.hasDocAccess (which reads DocAccess.findOne).
  // Default findOne returns null; tests that exercise the happy path
  // either use a super-admin user or set the doc's ownerUserId to the
  // caller's id (matches resolveOwnerId fallback).
  DocAccess: { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn() },
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

// Auth middleware passthrough: tests inject req.user directly via the
// fake auth wrapper below. We still mock the middleware module so that
// requiring it (via routes/docCollab.js → middleware/auth.js → models)
// does not blow up.
jest.mock('../../middleware/auth', () => ({
  authenticate: (req, _res, next) => next(),
}));

const { Doc, Workspace, User, DocAccess } = require('../../models');
const docCollab = require('../../services/docCollabService');

// ─── Reusable user/doc/workspace fixtures ─────────────────────────────

const MEMBER = { id: 'u-member', role: 'member', isSuperAdmin: false };
const OUTSIDER = { id: 'u-outsider', role: 'member', isSuperAdmin: false };
const ADMIN = { id: 'u-admin', role: 'admin', isSuperAdmin: false };

function makeDoc(overrides = {}) {
  return {
    id: 'd1',
    workspaceId: 'w1',
    isArchived: false,
    yjsState: null,
    contentJson: { type: 'doc', content: [] },
    ...overrides,
  };
}

function makeWorkspace(overrides = {}) {
  return {
    id: 'w1',
    createdBy: ADMIN.id,
    workspaceMembers: [{ id: MEMBER.id }],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  docCollab.__resetForTests();
});

// ─── isContentJsonEmptyOrTrivial (also covers the migrate-policy gate)

describe('isContentJsonEmptyOrTrivial', () => {
  test('treats {} / null / {content:[]} as empty', () => {
    expect(docCollab.isContentJsonEmptyOrTrivial(null)).toBe(true);
    expect(docCollab.isContentJsonEmptyOrTrivial({})).toBe(true);
    expect(docCollab.isContentJsonEmptyOrTrivial({ type: 'doc', content: [] })).toBe(true);
  });
  test('treats single empty paragraph as empty (Tiptap default)', () => {
    expect(docCollab.isContentJsonEmptyOrTrivial({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    })).toBe(true);
    expect(docCollab.isContentJsonEmptyOrTrivial({
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    })).toBe(true);
  });
  test('treats real text as non-empty', () => {
    expect(docCollab.isContentJsonEmptyOrTrivial({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    })).toBe(false);
  });
  test('treats multiple nodes as non-empty even if each is trivial', () => {
    expect(docCollab.isContentJsonEmptyOrTrivial({
      type: 'doc',
      content: [{ type: 'paragraph' }, { type: 'paragraph' }],
    })).toBe(false);
  });
});

// ─── Ticket endpoint ──────────────────────────────────────────────────

describe('POST /api/docs-collab/ticket', () => {
  // Lazy-import the route + Express so the mocks above are in place.
  const express = require('express');
  const docCollabRoutes = require('../../routes/docCollab');

  function buildApp(user) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api/docs-collab', docCollabRoutes);
    return app;
  }

  const request = require('supertest');

  test('400 when docId missing', async () => {
    const res = await request(buildApp(MEMBER))
      .post('/api/docs-collab/ticket')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('404 when doc not found', async () => {
    Doc.findByPk.mockResolvedValue(null);
    const res = await request(buildApp(MEMBER))
      .post('/api/docs-collab/ticket')
      .send({ docId: 'd-missing' });
    expect(res.status).toBe(404);
  });

  test('403 when doc is archived', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc({ isArchived: true }));
    const res = await request(buildApp(MEMBER))
      .post('/api/docs-collab/ticket')
      .send({ docId: 'd1' });
    expect(res.status).toBe(403);
  });

  test('403 when caller has no doc_access grant', async () => {
    // Phase 3: workspace/board/role no longer auto-grant — without an
    // explicit doc_access row OR ownership, OUTSIDER is denied.
    Doc.findByPk.mockResolvedValue(makeDoc({ ownerUserId: 'someone-else' }));
    DocAccess.findOne.mockResolvedValue(null);
    const res = await request(buildApp(OUTSIDER))
      .post('/api/docs-collab/ticket')
      .send({ docId: 'd1' });
    expect(res.status).toBe(403);
  });

  test('200 happy path: owner can mint a ticket', async () => {
    // Phase 3: owner match via ownerUserId. (Pre-Phase-3 this test used a
    // generic workspace member — that no longer grants access.)
    Doc.findByPk.mockResolvedValue(makeDoc({ ownerUserId: MEMBER.id }));
    const res = await request(buildApp(MEMBER))
      .post('/api/docs-collab/ticket')
      .send({ docId: 'd1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.expiresIn).toBe(60);
    const decoded = jwt.verify(res.body.data.ticket, process.env.JWT_SECRET);
    expect(decoded.purpose).toBe('doc-collab-ws');
    expect(decoded.docId).toBe('d1');
    expect(decoded.id).toBe(MEMBER.id);
  });

  test('200 super-admin bypasses access checks (17.7a)', async () => {
    // Phase 3: admin role no longer auto-grants. Only super-admin does
    // (per decision 17.7a).
    Doc.findByPk.mockResolvedValue(makeDoc({ ownerUserId: 'someone-else' }));
    const SUPER = { id: 'u-super', role: 'admin', isSuperAdmin: true };
    const res = await request(buildApp(SUPER))
      .post('/api/docs-collab/ticket')
      .send({ docId: 'd1' });
    expect(res.status).toBe(200);
  });
});

// ─── buildHocuspocusConfig — pure factory ─────────────────────────────

describe('buildHocuspocusConfig', () => {
  // Minimal Y.js stand-in. Hooks never inspect the returned values
  // structurally beyond what onStoreDocument calls — see assertions.
  function makeY() {
    return {
      Doc: jest.fn(function YDoc() { this._kind = 'YDoc'; }),
      applyUpdate: jest.fn(),
      encodeStateAsUpdate: jest.fn(() => new Uint8Array([1, 2, 3])),
    };
  }

  function buildConfig(yLib) {
    return docCollab.buildHocuspocusConfig({
      Y: yLib || makeY(),
      jwt,
      Doc,
      Workspace,
      User,
      jwtSecret: process.env.JWT_SECRET,
    });
  }

  function signTicket(payload, ttl = '60s') {
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ttl });
  }

  // ── onAuthenticate ────────────────────────────────────────────────

  test('onAuthenticate rejects token with wrong purpose', async () => {
    const token = signTicket({ id: MEMBER.id, docId: 'd1', purpose: 'meeting-ws', role: 'member' });
    await expect(buildConfig().onAuthenticate({ token, documentName: 'd1' }))
      .rejects.toThrow('Wrong token purpose');
  });

  test('onAuthenticate rejects mismatched docId', async () => {
    const token = signTicket({ id: MEMBER.id, docId: 'd-other', purpose: 'doc-collab-ws', role: 'member' });
    await expect(buildConfig().onAuthenticate({ token, documentName: 'd1' }))
      .rejects.toThrow('Token/document mismatch');
  });

  test('onAuthenticate rejects garbage token', async () => {
    await expect(buildConfig().onAuthenticate({ token: 'not-a-jwt', documentName: 'd1' }))
      .rejects.toThrow('Invalid token');
  });

  test('onAuthenticate rejects when doc archived', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc({ isArchived: true }));
    const token = signTicket({ id: MEMBER.id, docId: 'd1', purpose: 'doc-collab-ws', role: 'member' });
    await expect(buildConfig().onAuthenticate({ token, documentName: 'd1' }))
      .rejects.toThrow('Doc is archived');
  });

  test('onAuthenticate rejects when caller has no doc_access', async () => {
    // Phase 3: no doc_access row + not owner + not super-admin → denied.
    Doc.findByPk.mockResolvedValue(makeDoc({ ownerUserId: 'other' }));
    DocAccess.findOne.mockResolvedValue(null);
    const token = signTicket({ id: OUTSIDER.id, docId: 'd1', purpose: 'doc-collab-ws', role: 'member' });
    await expect(buildConfig().onAuthenticate({ token, documentName: 'd1' }))
      .rejects.toThrow('Access denied');
  });

  test('onAuthenticate resolves with userId + docId on happy path', async () => {
    // Phase 3: owner can authenticate without an explicit doc_access row.
    Doc.findByPk.mockResolvedValue(makeDoc({ ownerUserId: MEMBER.id }));
    const token = signTicket({
      id: MEMBER.id,
      docId: 'd1',
      purpose: 'doc-collab-ws',
      role: 'member',
      isSuperAdmin: false,
    });
    const ctx = await buildConfig().onAuthenticate({ token, documentName: 'd1' });
    expect(ctx).toEqual({ user: { id: MEMBER.id }, docId: 'd1' });
  });

  // ── onLoadDocument ───────────────────────────────────────────────

  test('onLoadDocument returns empty Y.doc when yjsState null and contentJson empty', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc()); // empty content, null state
    const Y = makeY();
    const ydoc = await buildConfig(Y).onLoadDocument({ documentName: 'd1' });
    expect(Y.Doc).toHaveBeenCalledTimes(1);
    expect(Y.applyUpdate).not.toHaveBeenCalled();
    expect(ydoc._kind).toBe('YDoc');
  });

  test('onLoadDocument throws when yjsState null and contentJson has real content', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc({
      contentJson: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'real content' }] },
      ] },
    }));
    await expect(buildConfig().onLoadDocument({ documentName: 'd1' }))
      .rejects.toThrow(/not migrated for collab/i);
  });

  test('onLoadDocument applies update when yjsState non-null', async () => {
    const stateBytes = Buffer.from([4, 5, 6, 7]);
    Doc.findByPk.mockResolvedValue(makeDoc({ yjsState: stateBytes }));
    const Y = makeY();
    const ydoc = await buildConfig(Y).onLoadDocument({ documentName: 'd1' });
    expect(Y.Doc).toHaveBeenCalledTimes(1);
    expect(Y.applyUpdate).toHaveBeenCalledTimes(1);
    const [, bytesArg] = Y.applyUpdate.mock.calls[0];
    expect(bytesArg).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytesArg)).toEqual([4, 5, 6, 7]);
    expect(ydoc._kind).toBe('YDoc');
  });

  test('onLoadDocument returns empty Y.doc when row missing (defensive fallback)', async () => {
    Doc.findByPk.mockResolvedValue(null);
    const Y = makeY();
    const ydoc = await buildConfig(Y).onLoadDocument({ documentName: 'd-vanished' });
    expect(ydoc._kind).toBe('YDoc');
    expect(Y.applyUpdate).not.toHaveBeenCalled();
  });

  // ── onStoreDocument ──────────────────────────────────────────────

  test('onStoreDocument persists encoded state to the docs row', async () => {
    Doc.update.mockResolvedValue([1]);
    const Y = makeY();
    Y.encodeStateAsUpdate.mockReturnValue(new Uint8Array([9, 9, 9]));
    const fakeYdoc = {};
    await buildConfig(Y).onStoreDocument({ documentName: 'd1', document: fakeYdoc });
    expect(Y.encodeStateAsUpdate).toHaveBeenCalledWith(fakeYdoc);
    expect(Doc.update).toHaveBeenCalledTimes(1);
    const [updates, opts] = Doc.update.mock.calls[0];
    expect(opts).toEqual({ where: { id: 'd1' } });
    expect(Buffer.isBuffer(updates.yjsState)).toBe(true);
    expect(Array.from(updates.yjsState)).toEqual([9, 9, 9]);
  });
});

// ─── canSeeWorkspace ──────────────────────────────────────────────────

describe('canSeeWorkspace', () => {
  test('super-admin sees everything (no DB load required)', async () => {
    const ok = await docCollab.canSeeWorkspace(
      { Workspace, User },
      { id: 'su', isSuperAdmin: true, role: 'admin' },
      'w1'
    );
    expect(ok).toBe(true);
    expect(Workspace.findByPk).not.toHaveBeenCalled();
  });

  test('admin/manager role bypasses membership check', async () => {
    const ok = await docCollab.canSeeWorkspace(
      { Workspace, User },
      ADMIN,
      'w1'
    );
    expect(ok).toBe(true);
    expect(Workspace.findByPk).not.toHaveBeenCalled();
  });

  test('member sees workspace they belong to', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const ok = await docCollab.canSeeWorkspace(
      { Workspace, User },
      MEMBER,
      'w1'
    );
    expect(ok).toBe(true);
  });

  test('outsider does not see workspace they have no membership in', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: 'other',
      workspaceMembers: [],
    }));
    const ok = await docCollab.canSeeWorkspace(
      { Workspace, User },
      OUTSIDER,
      'w1'
    );
    expect(ok).toBe(false);
  });
});
