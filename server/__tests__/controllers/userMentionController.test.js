'use strict';

/**
 * Unit tests for the Phase 4 global active-user mention search.
 *
 * Surface under test: GET /api/users/mentions?q=&limit=
 *
 * Coverage:
 *   - filters: isActive=true AND accountStatus='approved'
 *   - excludes self (req.user.id)
 *   - exposes only safe attrs (id, name, email, avatar)
 *   - q matches name OR email (iLike, case-insensitive)
 *   - default limit 15, capped at 25
 *   - query is trimmed and truncated to 80 chars (defensive)
 *
 * Model layer mocked. No real DB.
 */

process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  User: { findAll: jest.fn() },
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

const { Op } = require('sequelize');
const { User } = require('../../models');
const { searchMentionableUsers } = require('../../controllers/userMentionController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const CALLER = { id: 'u-caller' };

beforeEach(() => {
  jest.clearAllMocks();
  User.findAll.mockResolvedValue([]);
});

describe('searchMentionableUsers', () => {
  test('filters isActive=true AND accountStatus=approved', async () => {
    await searchMentionableUsers({ user: CALLER, query: {} }, mockRes());
    const args = User.findAll.mock.calls[0][0];
    expect(args.where.isActive).toBe(true);
    expect(args.where.accountStatus).toBe('approved');
  });

  test('excludes the caller by id', async () => {
    await searchMentionableUsers({ user: CALLER, query: {} }, mockRes());
    const args = User.findAll.mock.calls[0][0];
    // Op.ne keyed; we read via the Op symbol to confirm the shape.
    expect(args.where.id[Op.ne]).toBe(CALLER.id);
  });

  test('exposes only safe attributes (no role / tier / department)', async () => {
    await searchMentionableUsers({ user: CALLER, query: {} }, mockRes());
    const args = User.findAll.mock.calls[0][0];
    expect(args.attributes).toEqual(['id', 'name', 'email', 'avatar']);
    expect(args.attributes).not.toContain('role');
    expect(args.attributes).not.toContain('tier');
    expect(args.attributes).not.toContain('department');
    expect(args.attributes).not.toContain('isSuperAdmin');
  });

  test('q matches name OR email via iLike', async () => {
    await searchMentionableUsers({ user: CALLER, query: { q: 'sara' } }, mockRes());
    const args = User.findAll.mock.calls[0][0];
    const ors = args.where[Op.or];
    expect(ors).toHaveLength(2);
    // Both clauses use Op.iLike with the wildcard query.
    expect(ors[0].name[Op.iLike]).toBe('%sara%');
    expect(ors[1].email[Op.iLike]).toBe('%sara%');
  });

  test('default limit is 15', async () => {
    await searchMentionableUsers({ user: CALLER, query: {} }, mockRes());
    expect(User.findAll.mock.calls[0][0].limit).toBe(15);
  });

  test('caps limit at 25 even if caller asks for more', async () => {
    await searchMentionableUsers({ user: CALLER, query: { limit: 1000 } }, mockRes());
    expect(User.findAll.mock.calls[0][0].limit).toBe(25);
  });

  test('floors invalid limit to default 15', async () => {
    await searchMentionableUsers({ user: CALLER, query: { limit: 'wat' } }, mockRes());
    expect(User.findAll.mock.calls[0][0].limit).toBe(15);
    await searchMentionableUsers({ user: CALLER, query: { limit: '-5' } }, mockRes());
    expect(User.findAll.mock.calls[1][0].limit).toBe(15);
  });

  test('truncates oversized q strings (defense against pathological input)', async () => {
    const huge = 'x'.repeat(500);
    await searchMentionableUsers({ user: CALLER, query: { q: huge } }, mockRes());
    const args = User.findAll.mock.calls[0][0];
    const namePattern = args.where[Op.or][0].name[Op.iLike];
    // 80 char cap + the % wildcards = max 82 chars
    expect(namePattern.length).toBeLessThanOrEqual(82);
  });

  test('serializes results to only safe pill fields', async () => {
    User.findAll.mockResolvedValue([
      { id: 'u1', name: 'Sara', email: 's@a.com', avatar: 'a.png', role: 'admin', tier: 2 },
      { id: 'u2', name: 'Mike', email: 'm@a.com', avatar: null, role: 'member', tier: 4 },
    ]);
    const res = mockRes();
    await searchMentionableUsers({ user: CALLER, query: { q: 'a' } }, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.users).toEqual([
      { id: 'u1', name: 'Sara', email: 's@a.com', avatar: 'a.png' },
      { id: 'u2', name: 'Mike', email: 'm@a.com', avatar: null },
    ]);
    // Crucially: no role, tier, department, etc. leaked.
    for (const u of payload.data.users) {
      expect(u).not.toHaveProperty('role');
      expect(u).not.toHaveProperty('tier');
    }
  });

  test('handles missing req.user gracefully (no self-exclusion)', async () => {
    await searchMentionableUsers({ query: {} }, mockRes());
    const args = User.findAll.mock.calls[0][0];
    expect(args.where).not.toHaveProperty('id'); // no Op.ne clause
  });

  test('returns 500 on DB failure', async () => {
    User.findAll.mockRejectedValue(new Error('db down'));
    const res = mockRes();
    await searchMentionableUsers({ user: CALLER, query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      message: expect.any(String),
    }));
  });
});
