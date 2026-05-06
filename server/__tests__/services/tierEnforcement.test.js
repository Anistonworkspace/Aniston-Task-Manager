'use strict';

/**
 * Tests for server/services/tierEnforcement.js
 *
 * Verifies the global T2-no-delete rule plus the resource-kind matrix for
 * T3 / T4. Pure functions — no DB, no mocks.
 */

const {
  canDelete,
  assertCanDelete,
  PERSONAL_KINDS,
  SHARED_KINDS,
  KNOWN_KINDS,
} = require('../../services/tierEnforcement');
const { TierError } = require('../../config/tiers');

const t1 = { tier: 1 };
const t2 = { tier: 2 };
const t3 = { tier: 3 };
const t4 = { tier: 4 };

// ── Constants hygiene ─────────────────────────────────────────────────────

describe('resource kind sets', () => {
  it('PERSONAL_KINDS and SHARED_KINDS are disjoint', () => {
    for (const k of PERSONAL_KINDS) expect(SHARED_KINDS.has(k)).toBe(false);
  });

  it('KNOWN_KINDS = personal ∪ shared', () => {
    const expected = new Set([...PERSONAL_KINDS, ...SHARED_KINDS]);
    expect(KNOWN_KINDS.size).toBe(expected.size);
    for (const k of expected) expect(KNOWN_KINDS.has(k)).toBe(true);
  });

  it('contains the resources called out in decision #4', () => {
    for (const k of ['user','workspace','board','group','task','file','comment','notification']) {
      expect(KNOWN_KINDS.has(k)).toBe(true);
    }
  });
});

// ── Tier 1 — may always delete ────────────────────────────────────────────

describe('canDelete — Tier 1', () => {
  it('returns true for every shared resource regardless of ownership', () => {
    for (const k of SHARED_KINDS) {
      expect(canDelete(t1, k, { isOwnResource: false })).toBe(true);
      expect(canDelete(t1, k, { isOwnResource: true  })).toBe(true);
    }
  });
  it('returns true for every personal resource regardless of ownership', () => {
    for (const k of PERSONAL_KINDS) {
      expect(canDelete(t1, k, { isOwnResource: false })).toBe(true);
    }
  });
});

// ── Tier 2 — never deletes (decision #4 strict) ──────────────────────────

describe('canDelete — Tier 2', () => {
  it('returns false for every shared resource', () => {
    for (const k of SHARED_KINDS) {
      expect(canDelete(t2, k, { isOwnResource: true  })).toBe(false);
      expect(canDelete(t2, k, { isOwnResource: false })).toBe(false);
    }
  });
  it('returns false for every personal resource even when own', () => {
    for (const k of PERSONAL_KINDS) {
      expect(canDelete(t2, k, { isOwnResource: true })).toBe(false);
    }
  });
});

// ── Tier 3 / Tier 4 — personal yes (own), shared no ──────────────────────

describe.each([
  ['Tier 3', t3],
  ['Tier 4', t4],
])('canDelete — %s', (_label, user) => {
  it('returns true for any KNOWN kind when isOwnResource=true', () => {
    // Personal data — own delete always allowed (notes, time-blocks, notifications).
    for (const k of PERSONAL_KINDS) {
      expect(canDelete(user, k, { isOwnResource: true })).toBe(true);
    }
    // Shared resources where ownership has been verified — own delete allowed
    // (own comments, own meetings, etc.). Privileged controllers that want
    // to forbid this still can: they pass isOwnResource: false.
    for (const k of SHARED_KINDS) {
      expect(canDelete(user, k, { isOwnResource: true })).toBe(true);
    }
  });
  it('returns false when ownership not asserted', () => {
    for (const k of [...PERSONAL_KINDS, ...SHARED_KINDS]) {
      expect(canDelete(user, k, { isOwnResource: false })).toBe(false);
      expect(canDelete(user, k)).toBe(false);
    }
  });
  it('returns false for unknown resource kind even with isOwnResource', () => {
    expect(canDelete(user, 'fictional', { isOwnResource: true })).toBe(false);
  });
});

// ── assertCanDelete — throwing form ───────────────────────────────────────

describe('assertCanDelete', () => {
  it('Tier 1 — does not throw for known kinds', () => {
    for (const k of KNOWN_KINDS) {
      expect(() => assertCanDelete(t1, k)).not.toThrow();
    }
  });

  it('Tier 2 — throws TIER_2_NO_DELETE for every known kind', () => {
    for (const k of KNOWN_KINDS) {
      try {
        assertCanDelete(t2, k, { isOwnResource: true });
        throw new Error(`expected throw for kind=${k}`);
      } catch (err) {
        expect(err).toBeInstanceOf(TierError);
        expect(err.code).toBe('TIER_2_NO_DELETE');
        expect(err.status).toBe(403);
        expect(err.message).toMatch(/Tier 2 cannot delete/);
      }
    }
  });

  it('Tier 4 — passes for own shared resource (own comment)', () => {
    // Per relaxed canDelete: T3/T4 may delete any owned resource. Privileged
    // controllers that wish to deny this still pass isOwnResource: false.
    expect(() => assertCanDelete(t4, 'comment', { isOwnResource: true })).not.toThrow();
  });

  it('Tier 4 — throws DELETE_FORBIDDEN for shared resource without ownership', () => {
    try {
      assertCanDelete(t4, 'task', { isOwnResource: false });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TierError);
      expect(err.code).toBe('DELETE_FORBIDDEN');
      expect(err.status).toBe(403);
    }
  });

  it('Tier 3 — passes for own personal resource (note)', () => {
    expect(() => assertCanDelete(t3, 'note', { isOwnResource: true })).not.toThrow();
  });

  it('Tier 3 — throws for personal resource when ownership not asserted', () => {
    expect(() => assertCanDelete(t3, 'note', { isOwnResource: false })).toThrow(TierError);
  });

  it('throws on unknown resource kind in non-production (programmer error)', () => {
    const oldEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      assertCanDelete(t1, 'fictional_resource');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TierError);
      expect(err.code).toBe('UNKNOWN_RESOURCE_KIND');
      expect(err.status).toBe(500);
    } finally {
      process.env.NODE_ENV = oldEnv;
    }
  });

  it('fails closed (403) on unknown resource kind in production', () => {
    const oldEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assertCanDelete(t1, 'fictional_resource');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TierError);
      expect(err.code).toBe('DELETE_FORBIDDEN');
      expect(err.status).toBe(403);
    } finally {
      process.env.NODE_ENV = oldEnv;
    }
  });
});

// ── Legacy fallback (user has role but no tier column yet) ──────────────

describe('legacy fallback (no tier column)', () => {
  it('legacy super admin (isSuperAdmin=true) treated as Tier 1', () => {
    const u = { isSuperAdmin: true, role: 'admin' };
    expect(canDelete(u, 'task')).toBe(true);
  });
  it('legacy admin role treated as Tier 2 (cannot delete)', () => {
    const u = { role: 'admin' };
    expect(canDelete(u, 'task')).toBe(false);
    expect(() => assertCanDelete(u, 'task')).toThrow(/Tier 2 cannot delete/);
  });
  it('legacy manager role treated as Tier 2 (cannot delete)', () => {
    const u = { role: 'manager' };
    expect(canDelete(u, 'workspace')).toBe(false);
  });
  it('legacy assistant_manager role treated as Tier 3', () => {
    const u = { role: 'assistant_manager' };
    expect(canDelete(u, 'note', { isOwnResource: true })).toBe(true);
    expect(canDelete(u, 'task', { isOwnResource: false })).toBe(false);
  });
  it('legacy member role treated as Tier 4', () => {
    const u = { role: 'member' };
    expect(canDelete(u, 'note', { isOwnResource: true })).toBe(true);
    expect(canDelete(u, 'task', { isOwnResource: false })).toBe(false);
  });
  it('null user — fail-safe Tier 4', () => {
    expect(canDelete(null, 'task', { isOwnResource: true })).toBe(false);
  });
});
