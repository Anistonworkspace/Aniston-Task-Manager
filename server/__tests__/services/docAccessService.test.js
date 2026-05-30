'use strict';

/**
 * docAccessService — unit tests for the Phase 2 canonical access resolver.
 *
 * The resolver rule under test:
 *   hasDocAccess(user, doc) = user.isSuperAdmin
 *                          OR doc.ownerUserId === user.id
 *                          OR EXISTS(doc_access WHERE docId=doc.id AND userId=user.id)
 *
 * Tests stub the Sequelize models — no real DB. This mirrors the pattern
 * the rest of the server-side test suite uses (CLAUDE.md "All mock-DB; no
 * real Postgres").
 */

jest.mock('../../models', () => ({
  Doc:       { findAll: jest.fn(), findByPk: jest.fn() },
  DocAccess: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() },
}));

const { Doc, DocAccess } = require('../../models');
const {
  getMyVisibleDocIds,
  hasDocAccess,
  getDocAccessLevel,
  upsertAccess,
  levelRank,
} = require('../../services/docAccessService');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('docAccessService.hasDocAccess', () => {
  test('returns false when user is null', async () => {
    expect(await hasDocAccess(null, { id: 'd1', ownerUserId: 'u1' })).toBe(false);
  });

  test('super-admin bypasses access checks (no DB hit)', async () => {
    const user = { id: 'sa', isSuperAdmin: true };
    expect(await hasDocAccess(user, { id: 'd1', ownerUserId: 'someone_else' })).toBe(true);
    expect(DocAccess.findOne).not.toHaveBeenCalled();
  });

  test('owner has access without a doc_access row', async () => {
    const user = { id: 'u1' };
    expect(await hasDocAccess(user, { id: 'd1', ownerUserId: 'u1' })).toBe(true);
    expect(DocAccess.findOne).not.toHaveBeenCalled();
  });

  test('non-owner with doc_access row → true', async () => {
    const user = { id: 'u2' };
    DocAccess.findOne.mockResolvedValueOnce({ id: 'a1' });
    expect(await hasDocAccess(user, { id: 'd1', ownerUserId: 'u1' })).toBe(true);
    expect(DocAccess.findOne).toHaveBeenCalledWith({
      where: { docId: 'd1', userId: 'u2' },
      attributes: ['id'],
    });
  });

  test('non-owner without doc_access row → false', async () => {
    const user = { id: 'u3' };
    DocAccess.findOne.mockResolvedValueOnce(null);
    expect(await hasDocAccess(user, { id: 'd1', ownerUserId: 'u1' })).toBe(false);
  });

  test('accepts a docId string (one extra lookup)', async () => {
    const user = { id: 'u2' };
    Doc.findByPk.mockResolvedValueOnce({ ownerUserId: 'u1' });
    DocAccess.findOne.mockResolvedValueOnce({ id: 'a1' });
    expect(await hasDocAccess(user, 'd1')).toBe(true);
    // Phase 3 — attributes include createdBy so the resolver can fall back
    // when ownerUserId hasn't been backfilled (resilience during the
    // Phase 2 deploy window).
    expect(Doc.findByPk).toHaveBeenCalledWith('d1', { attributes: ['ownerUserId', 'createdBy'] });
  });

  test('returns false when doc id resolves to nothing', async () => {
    Doc.findByPk.mockResolvedValueOnce(null);
    expect(await hasDocAccess({ id: 'u1' }, 'missing')).toBe(false);
  });
});

describe('docAccessService.getMyVisibleDocIds', () => {
  test('super-admin gets every doc id', async () => {
    Doc.findAll.mockResolvedValueOnce([{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }]);
    const ids = await getMyVisibleDocIds({ id: 'sa', isSuperAdmin: true });
    expect(ids.sort()).toEqual(['d1', 'd2', 'd3']);
    expect(Doc.findAll).toHaveBeenCalledWith({ attributes: ['id'], raw: true });
  });

  test('regular user gets union of owned + shared, deduplicated', async () => {
    Doc.findAll.mockResolvedValueOnce([{ id: 'd1' }, { id: 'd2' }]);
    DocAccess.findAll.mockResolvedValueOnce([{ docId: 'd2' }, { docId: 'd5' }]);
    const ids = await getMyVisibleDocIds({ id: 'u1' });
    expect(ids.sort()).toEqual(['d1', 'd2', 'd5']);
  });

  test('returns [] for an unknown user', async () => {
    expect(await getMyVisibleDocIds(null)).toEqual([]);
    expect(Doc.findAll).not.toHaveBeenCalled();
  });
});

describe('docAccessService.upsertAccess', () => {
  test('creates a row when none exists', async () => {
    DocAccess.findOne.mockResolvedValueOnce(null);
    DocAccess.create.mockResolvedValueOnce({ id: 'a1' });
    const result = await upsertAccess({
      docId: 'd1', userId: 'u2', accessLevel: 'comment', source: 'manual_share', grantedByUserId: 'u1',
    });
    expect(result).toEqual({ created: true, upgraded: false });
    expect(DocAccess.create).toHaveBeenCalled();
  });

  test('upgrades level when new level is higher', async () => {
    const existing = { accessLevel: 'view', update: jest.fn().mockResolvedValue(true) };
    DocAccess.findOne.mockResolvedValueOnce(existing);
    const result = await upsertAccess({
      docId: 'd1', userId: 'u2', accessLevel: 'edit', source: 'manual_share',
    });
    expect(result).toEqual({ created: false, upgraded: true });
    expect(existing.update).toHaveBeenCalledWith(expect.objectContaining({ accessLevel: 'edit' }));
  });

  test('does NOT downgrade when new level is lower', async () => {
    const existing = { accessLevel: 'edit', update: jest.fn() };
    DocAccess.findOne.mockResolvedValueOnce(existing);
    const result = await upsertAccess({
      docId: 'd1', userId: 'u2', accessLevel: 'view', source: 'mention',
    });
    expect(result).toEqual({ created: false, upgraded: false });
    expect(existing.update).not.toHaveBeenCalled();
  });

  test('refuses calls missing required fields', async () => {
    await expect(upsertAccess({ userId: 'u', accessLevel: 'view', source: 'x' }))
      .rejects.toThrow(/docId/);
  });
});

describe('docAccessService.levelRank', () => {
  test('owner > edit > comment > view', () => {
    expect(levelRank('owner')).toBeGreaterThan(levelRank('edit'));
    expect(levelRank('edit')).toBeGreaterThan(levelRank('comment'));
    expect(levelRank('comment')).toBeGreaterThan(levelRank('view'));
  });
  test('unknown level → -1', () => {
    expect(levelRank('admin')).toBe(-1);
    expect(levelRank(null)).toBe(-1);
  });
});

describe('docAccessService.getDocAccessLevel', () => {
  test('super-admin sees owner-level everywhere', async () => {
    const level = await getDocAccessLevel({ id: 'sa', isSuperAdmin: true }, { id: 'd1', ownerUserId: 'u1' });
    expect(level).toBe('owner');
  });

  test('owner returns owner', async () => {
    const level = await getDocAccessLevel({ id: 'u1' }, { id: 'd1', ownerUserId: 'u1' });
    expect(level).toBe('owner');
  });

  test('shared user returns their grant level', async () => {
    DocAccess.findOne.mockResolvedValueOnce({ accessLevel: 'edit' });
    const level = await getDocAccessLevel({ id: 'u2' }, { id: 'd1', ownerUserId: 'u1' });
    expect(level).toBe('edit');
  });

  test('no access → null', async () => {
    DocAccess.findOne.mockResolvedValueOnce(null);
    const level = await getDocAccessLevel({ id: 'u3' }, { id: 'd1', ownerUserId: 'u1' });
    expect(level).toBeNull();
  });
});
