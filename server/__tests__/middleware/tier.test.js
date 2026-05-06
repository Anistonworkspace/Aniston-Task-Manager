'use strict';

/**
 * Tests for server/middleware/tier.js — requireTier and requireTierAtLeast.
 *
 * No DB. No mocks of upstream code. Mocks only the Express req/res/next
 * triple, mirroring the convention used by __tests__/middleware/auth.test.js.
 *
 * Console output is silenced for the unauthorized-attempt log line so the
 * test run stays clean.
 */

const { requireTier, requireTierAtLeast } = require('../../middleware/tier');

function buildMocks(reqOverrides = {}) {
  const req = {
    method: 'GET',
    originalUrl: '/api/test',
    headers: {},
    user: null,
    ...reqOverrides,
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

const makeUser = (overrides = {}) => ({
  id: 'u1',
  isActive: true,
  ...overrides,
});

let warnSpy;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ── requireTier ─────────────────────────────────────────────────────────

describe('requireTier(n)', () => {
  it('rejects construction with an invalid tier', () => {
    expect(() => requireTier(0)).toThrow(/invalid tier/);
    expect(() => requireTier(5)).toThrow(/invalid tier/);
    expect(() => requireTier('one')).toThrow(/invalid tier/);
  });

  it('returns 401 when req.user is missing', () => {
    const { req, res, next } = buildMocks({ user: null });
    requireTier(1)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'UNAUTH' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('Tier 1 user passes requireTier(1)', () => {
    const { req, res, next } = buildMocks({ user: makeUser({ tier: 1 }) });
    requireTier(1)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('Tier 2 user FAILS requireTier(1)', () => {
    const { req, res, next } = buildMocks({ user: makeUser({ tier: 2 }) });
    requireTier(1)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'TIER_DENIED' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('legacy isSuperAdmin user (no tier column) passes requireTier(1)', () => {
    // Migration 014 not yet applied: tier missing, falls back to legacy.
    const { req, res, next } = buildMocks({ user: makeUser({ isSuperAdmin: true, role: 'admin' }) });
    requireTier(1)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('legacy admin user (no tier, role=admin) FAILS requireTier(1)', () => {
    const { req, res, next } = buildMocks({ user: makeUser({ role: 'admin' }) });
    requireTier(1)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts an array of allowed tiers (T1 OR T3)', () => {
    const guard = requireTier([1, 3]);

    // T1 passes
    const a = buildMocks({ user: makeUser({ tier: 1 }) });
    guard(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalledTimes(1);

    // T3 passes
    const b = buildMocks({ user: makeUser({ tier: 3 }) });
    guard(b.req, b.res, b.next);
    expect(b.next).toHaveBeenCalledTimes(1);

    // T2 fails
    const c = buildMocks({ user: makeUser({ tier: 2 }) });
    guard(c.req, c.res, c.next);
    expect(c.res.status).toHaveBeenCalledWith(403);
    expect(c.next).not.toHaveBeenCalled();

    // T4 fails
    const d = buildMocks({ user: makeUser({ tier: 4 }) });
    guard(d.req, d.res, d.next);
    expect(d.res.status).toHaveBeenCalledWith(403);
    expect(d.next).not.toHaveBeenCalled();
  });

  it('logs an audit line on denial', () => {
    const { req, res, next } = buildMocks({ user: makeUser({ tier: 4 }) });
    requireTier(1)(req, res, next);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Unauthorized access attempt.*tier=4/)
    );
  });
});

// ── requireTierAtLeast ──────────────────────────────────────────────────

describe('requireTierAtLeast(n)', () => {
  it('rejects construction with an invalid tier', () => {
    expect(() => requireTierAtLeast(0)).toThrow(/invalid tier/);
    expect(() => requireTierAtLeast(5)).toThrow(/invalid tier/);
  });

  it('returns 401 when req.user is missing', () => {
    const { req, res, next } = buildMocks({ user: null });
    requireTierAtLeast(2)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('Tier 1 passes every level', () => {
    for (const n of [1, 2, 3, 4]) {
      const { req, res, next } = buildMocks({ user: makeUser({ tier: 1 }) });
      requireTierAtLeast(n)(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('Tier 2 passes 2/3/4, fails 1', () => {
    for (const n of [2, 3, 4]) {
      const { req, res, next } = buildMocks({ user: makeUser({ tier: 2 }) });
      requireTierAtLeast(n)(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
    const { req, res, next } = buildMocks({ user: makeUser({ tier: 2 }) });
    requireTierAtLeast(1)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('Tier 4 passes only 4', () => {
    for (const n of [1, 2, 3]) {
      const { req, res, next } = buildMocks({ user: makeUser({ tier: 4 }) });
      requireTierAtLeast(n)(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
    const { req, res, next } = buildMocks({ user: makeUser({ tier: 4 }) });
    requireTierAtLeast(4)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('legacy fallback: role=manager (no tier) passes requireTierAtLeast(2)', () => {
    const { req, res, next } = buildMocks({ user: makeUser({ role: 'manager' }) });
    requireTierAtLeast(2)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('legacy fallback: role=member fails requireTierAtLeast(3)', () => {
    const { req, res, next } = buildMocks({ user: makeUser({ role: 'member' }) });
    requireTierAtLeast(3)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('error response contains TIER_DENIED machine code', () => {
    const { req, res, next } = buildMocks({ user: makeUser({ tier: 4 }) });
    requireTierAtLeast(1)(req, res, next);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, code: 'TIER_DENIED' })
    );
  });
});
