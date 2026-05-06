'use strict';

/**
 * Pure-function tests for server/config/tiers.js.
 *
 * No DB. The only async helper that talks to a model
 * (assertNotLastTier1Change) is exercised against an in-memory stub.
 */

const tiers = require('../../config/tiers');
const {
  TIER_1, TIER_2, TIER_3, TIER_4, ALL_TIERS, TIER_LABELS,
  TierError,
  isValidTier,
  tierFromLegacy, legacyFromTier, resolveTier,
  isTier1, isTier2, isTier3, isTier4,
  hasTierAtLeast, tierLabel,
  assertCanGrantTier, assertNotLastTier1Change,
} = tiers;

// ── Constants ─────────────────────────────────────────────────────────────

describe('tier constants', () => {
  it('exports 1..4', () => {
    expect(TIER_1).toBe(1);
    expect(TIER_2).toBe(2);
    expect(TIER_3).toBe(3);
    expect(TIER_4).toBe(4);
    expect(ALL_TIERS).toEqual([1, 2, 3, 4]);
  });

  it('TIER_LABELS uses display names only', () => {
    expect(TIER_LABELS[1]).toBe('Tier 1');
    expect(TIER_LABELS[2]).toBe('Tier 2');
    expect(TIER_LABELS[3]).toBe('Tier 3');
    expect(TIER_LABELS[4]).toBe('Tier 4');
  });

  it('TIER_LABELS is frozen', () => {
    expect(Object.isFrozen(TIER_LABELS)).toBe(true);
  });

  it('contains no old role names anywhere', () => {
    const dump = JSON.stringify(TIER_LABELS).toLowerCase();
    expect(dump).not.toMatch(/admin|manager|member|super/);
  });
});

// ── isValidTier ───────────────────────────────────────────────────────────

describe('isValidTier', () => {
  it.each([1, 2, 3, 4])('accepts %s', t => {
    expect(isValidTier(t)).toBe(true);
  });
  it.each([0, 5, -1, 1.5, '1', null, undefined, NaN, true, [], {}])('rejects %p', v => {
    expect(isValidTier(v)).toBe(false);
  });
});

// ── tierFromLegacy ────────────────────────────────────────────────────────

describe('tierFromLegacy', () => {
  // Truth table per confirmed mapping:
  //   isSuperAdmin=true               -> Tier 1 (always wins)
  //   role IN ('admin','manager')     -> Tier 2
  //   role = 'assistant_manager'      -> Tier 3
  //   role = 'member' / unknown / null -> Tier 4 (fail safe)
  const cases = [
    // isSuperAdmin always wins
    ['admin',             true,  1],
    ['manager',           true,  1],
    ['assistant_manager', true,  1],
    ['member',            true,  1],
    [null,                true,  1],

    // No flag -> role-based mapping
    ['admin',             false, 2],
    ['manager',           false, 2],
    ['assistant_manager', false, 3],
    ['member',            false, 4],

    // Defensive: unknown / undefined falls to least-privileged
    ['unknown_role',      false, 4],
    [null,                false, 4],
    [undefined,           false, 4],
    [undefined,           undefined, 4],
    ['',                  false, 4],
  ];

  it.each(cases)('(role=%p, isSuperAdmin=%p) -> Tier %i', (role, sa, expected) => {
    expect(tierFromLegacy(role, sa)).toBe(expected);
  });
});

// ── legacyFromTier ────────────────────────────────────────────────────────

describe('legacyFromTier', () => {
  it('Tier 1 -> admin role + isSuperAdmin', () => {
    expect(legacyFromTier(1)).toEqual({ role: 'admin', isSuperAdmin: true });
  });
  it('Tier 2 -> admin (canonical default for fresh writes)', () => {
    expect(legacyFromTier(2)).toEqual({ role: 'admin', isSuperAdmin: false });
  });
  it('Tier 3 -> assistant_manager', () => {
    expect(legacyFromTier(3)).toEqual({ role: 'assistant_manager', isSuperAdmin: false });
  });
  it('Tier 4 -> member', () => {
    expect(legacyFromTier(4)).toEqual({ role: 'member', isSuperAdmin: false });
  });
  it('throws TierError on invalid tier', () => {
    expect(() => legacyFromTier(5)).toThrow(TierError);
    expect(() => legacyFromTier(0)).toThrow(TierError);
    expect(() => legacyFromTier('two')).toThrow(TierError);
  });
});

// ── resolveTier ───────────────────────────────────────────────────────────

describe('resolveTier', () => {
  it('returns user.tier when present and valid', () => {
    expect(resolveTier({ tier: 2, role: 'member', isSuperAdmin: false })).toBe(2);
    expect(resolveTier({ tier: 1 })).toBe(1);
  });
  it('falls back to legacy when tier is invalid or missing', () => {
    expect(resolveTier({ tier: 99, role: 'admin', isSuperAdmin: true })).toBe(1);
    expect(resolveTier({ tier: null, role: 'manager' })).toBe(2);
    expect(resolveTier({ role: 'assistant_manager' })).toBe(3);
    expect(resolveTier({ role: 'member' })).toBe(4);
  });
  it('returns Tier 4 (fail-safe) when user is null/undefined', () => {
    expect(resolveTier(null)).toBe(4);
    expect(resolveTier(undefined)).toBe(4);
  });
  it('returns Tier 4 when neither tier nor role are recognized', () => {
    expect(resolveTier({})).toBe(4);
    expect(resolveTier({ role: 'unknown' })).toBe(4);
  });
});

// ── isTierN ───────────────────────────────────────────────────────────────

describe('isTierN helpers', () => {
  it('classify users from the new tier column', () => {
    expect(isTier1({ tier: 1 })).toBe(true);
    expect(isTier2({ tier: 2 })).toBe(true);
    expect(isTier3({ tier: 3 })).toBe(true);
    expect(isTier4({ tier: 4 })).toBe(true);
    expect(isTier1({ tier: 2 })).toBe(false);
    expect(isTier4({ tier: 1 })).toBe(false);
  });

  it('classify users via legacy fallback', () => {
    expect(isTier1({ isSuperAdmin: true })).toBe(true);
    expect(isTier2({ role: 'manager' })).toBe(true);
    expect(isTier2({ role: 'admin' })).toBe(true);
    expect(isTier3({ role: 'assistant_manager' })).toBe(true);
    expect(isTier4({ role: 'member' })).toBe(true);
    expect(isTier4({})).toBe(true); // unknown -> Tier 4
  });

  it('Tier 1 takes precedence over legacy role even when both set', () => {
    expect(isTier1({ tier: 1, role: 'member', isSuperAdmin: true })).toBe(true);
  });
});

// ── hasTierAtLeast ────────────────────────────────────────────────────────

describe('hasTierAtLeast', () => {
  it('Tier 1 satisfies every requirement', () => {
    const u = { tier: 1 };
    expect(hasTierAtLeast(u, 1)).toBe(true);
    expect(hasTierAtLeast(u, 2)).toBe(true);
    expect(hasTierAtLeast(u, 3)).toBe(true);
    expect(hasTierAtLeast(u, 4)).toBe(true);
  });
  it('Tier 2 satisfies Tier 2 / 3 / 4', () => {
    const u = { tier: 2 };
    expect(hasTierAtLeast(u, 1)).toBe(false);
    expect(hasTierAtLeast(u, 2)).toBe(true);
    expect(hasTierAtLeast(u, 3)).toBe(true);
    expect(hasTierAtLeast(u, 4)).toBe(true);
  });
  it('Tier 3 satisfies Tier 3 / 4', () => {
    const u = { tier: 3 };
    expect(hasTierAtLeast(u, 2)).toBe(false);
    expect(hasTierAtLeast(u, 3)).toBe(true);
    expect(hasTierAtLeast(u, 4)).toBe(true);
  });
  it('Tier 4 satisfies only Tier 4', () => {
    const u = { tier: 4 };
    expect(hasTierAtLeast(u, 1)).toBe(false);
    expect(hasTierAtLeast(u, 2)).toBe(false);
    expect(hasTierAtLeast(u, 3)).toBe(false);
    expect(hasTierAtLeast(u, 4)).toBe(true);
  });
  it('throws TierError on invalid required tier', () => {
    expect(() => hasTierAtLeast({ tier: 1 }, 5)).toThrow(TierError);
    expect(() => hasTierAtLeast({ tier: 1 }, 'two')).toThrow(TierError);
    expect(() => hasTierAtLeast({ tier: 1 }, 0)).toThrow(TierError);
  });
});

// ── tierLabel ─────────────────────────────────────────────────────────────

describe('tierLabel', () => {
  it('returns canonical labels', () => {
    expect(tierLabel(1)).toBe('Tier 1');
    expect(tierLabel(2)).toBe('Tier 2');
    expect(tierLabel(3)).toBe('Tier 3');
    expect(tierLabel(4)).toBe('Tier 4');
  });
  it('falls back gracefully for unknown values', () => {
    expect(tierLabel(99)).toBe('Tier 99');
  });
});

// ── assertCanGrantTier ────────────────────────────────────────────────────

describe('assertCanGrantTier', () => {
  const t1 = { id: 'a1', tier: 1 };
  const t2 = { id: 'a2', tier: 2 };
  const t3 = { id: 'a3', tier: 3 };
  const t4 = { id: 'a4', tier: 4 };
  const target = { id: 'tgt' };

  it('Tier 1 may grant any tier', () => {
    expect(() => assertCanGrantTier(t1, target, 1)).not.toThrow();
    expect(() => assertCanGrantTier(t1, target, 2)).not.toThrow();
    expect(() => assertCanGrantTier(t1, target, 3)).not.toThrow();
    expect(() => assertCanGrantTier(t1, target, 4)).not.toThrow();
  });

  it('Tier 2 may grant only Tier 3 or Tier 4', () => {
    expect(() => assertCanGrantTier(t2, target, 3)).not.toThrow();
    expect(() => assertCanGrantTier(t2, target, 4)).not.toThrow();
    expect(() => assertCanGrantTier(t2, target, 2)).toThrow(TierError);
    expect(() => assertCanGrantTier(t2, target, 1)).toThrow(TierError);
  });

  it('Tier 3 may not grant any tier', () => {
    expect(() => assertCanGrantTier(t3, target, 1)).toThrow(TierError);
    expect(() => assertCanGrantTier(t3, target, 2)).toThrow(TierError);
    expect(() => assertCanGrantTier(t3, target, 3)).toThrow(TierError);
    expect(() => assertCanGrantTier(t3, target, 4)).toThrow(TierError);
  });

  it('Tier 4 may not grant any tier', () => {
    expect(() => assertCanGrantTier(t4, target, 4)).toThrow(TierError);
  });

  it('forbids self-promotion regardless of actor tier', () => {
    const self = { id: 'me', tier: 2 };
    expect(() => assertCanGrantTier(self, self, 1)).toThrow(TierError);
  });

  it('allows self-demotion if other rules permit it', () => {
    // A Tier-1 demoting themselves to Tier 2 is structurally OK at this layer.
    // The "last Tier 1" guard is enforced by assertNotLastTier1Change separately.
    const self = { id: 'me', tier: 1 };
    expect(() => assertCanGrantTier(self, self, 2)).not.toThrow();
  });

  it('rejects invalid tier values', () => {
    expect(() => assertCanGrantTier(t1, target, 0)).toThrow(TierError);
    expect(() => assertCanGrantTier(t1, target, 5)).toThrow(TierError);
    expect(() => assertCanGrantTier(t1, target, 'one')).toThrow(TierError);
  });

  it('rejects unauthenticated actor', () => {
    expect(() => assertCanGrantTier(null, target, 4)).toThrow(/Not authenticated/);
  });

  it('attaches HTTP status + machine code to TierError', () => {
    try {
      assertCanGrantTier(t2, target, 1);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TierError);
      expect(err.status).toBe(403);
      expect(err.code).toBe('TIER_GRANT_TOO_HIGH');
    }
  });
});

// ── assertNotLastTier1Change ──────────────────────────────────────────────

describe('assertNotLastTier1Change', () => {
  function makeUserModelStub(otherActiveT1Count) {
    return {
      count: jest.fn().mockResolvedValue(otherActiveT1Count),
    };
  }
  const t1Target = { id: 't1-target', tier: 1, isSuperAdmin: true };
  const t2Target = { id: 't2-target', tier: 2 };

  it('no-op when target is not Tier 1', async () => {
    const stub = makeUserModelStub(0);
    await expect(assertNotLastTier1Change(t2Target, 'demote', stub)).resolves.toBeUndefined();
    expect(stub.count).not.toHaveBeenCalled();
  });

  it('throws when target is the only active Tier 1 (demote)', async () => {
    const stub = makeUserModelStub(0);
    await expect(assertNotLastTier1Change(t1Target, 'demote', stub))
      .rejects.toThrow(/only Tier 1/);
    expect(stub.count).toHaveBeenCalledTimes(1);
  });

  it('throws with the correct verb for each intent', async () => {
    const stubA = makeUserModelStub(0);
    await expect(assertNotLastTier1Change(t1Target, 'deactivate', stubA))
      .rejects.toThrow(/deactivate/);
    const stubB = makeUserModelStub(0);
    await expect(assertNotLastTier1Change(t1Target, 'delete', stubB))
      .rejects.toThrow(/delete/);
  });

  it('passes when at least one other active Tier 1 exists', async () => {
    const stub = makeUserModelStub(1);
    await expect(assertNotLastTier1Change(t1Target, 'demote', stub)).resolves.toBeUndefined();
  });

  it('queries with the correct WHERE clause', async () => {
    const stub = makeUserModelStub(2);
    await assertNotLastTier1Change(t1Target, 'demote', stub);
    const args = stub.count.mock.calls[0][0];
    expect(args.where.isSuperAdmin).toBe(true);
    expect(args.where.isActive).toBe(true);
    // Op.ne is a Sequelize symbol; existence is enough to assert the
    // exclusion is wired correctly.
    expect(args.where.id).toBeDefined();
  });

  it('throws TierError with code LAST_TIER_1 + status 400', async () => {
    const stub = makeUserModelStub(0);
    try {
      await assertNotLastTier1Change(t1Target, 'demote', stub);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TierError);
      expect(err.code).toBe('LAST_TIER_1');
      expect(err.status).toBe(400);
    }
  });

  it('rejects missing target', async () => {
    const stub = makeUserModelStub(0);
    await expect(assertNotLastTier1Change(null, 'demote', stub))
      .rejects.toThrow(/Target user required/);
  });

  it('rejects missing User model', async () => {
    await expect(assertNotLastTier1Change(t1Target, 'demote', null))
      .rejects.toThrow(/User model/);
  });
});
