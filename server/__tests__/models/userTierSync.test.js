'use strict';

/**
 * Pure-function tests for server/models/userTierSync.js.
 *
 * No DB. The sync function only needs a stub user object exposing:
 *   - tier, role, isSuperAdmin (mutable properties)
 *   - changed(field) -> bool
 *   - isNewRecord boolean
 *
 * The same surface that Sequelize provides on a real User instance.
 */

const { syncTierAndLegacyOnUser } = require('../../models/userTierSync');

/**
 * Build a minimal user-instance stub. `changedFields` is the set of fields
 * that .changed() should return true for — i.e. those the caller "explicitly
 * set" in this save. Defaults: nothing changed, not a new record.
 */
function makeStubUser(overrides = {}) {
  const {
    tier,
    role,
    isSuperAdmin,
    isNewRecord = false,
    changedFields = [],
  } = overrides;
  const changed = new Set(changedFields);
  return {
    tier,
    role,
    isSuperAdmin,
    isNewRecord,
    changed(field) { return changed.has(field); },
  };
}

// ── Direction: legacy change → tier ────────────────────────────────────

describe('legacy → tier', () => {
  it('role=admin → tier=2', () => {
    const u = makeStubUser({ role: 'admin', isSuperAdmin: false, changedFields: ['role'] });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(2);
    expect(u.role).toBe('admin');
    expect(u.isSuperAdmin).toBe(false);
  });

  it('role=manager → tier=2 (preserve manager)', () => {
    const u = makeStubUser({ role: 'manager', isSuperAdmin: false, changedFields: ['role'] });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(2);
    expect(u.role).toBe('manager');
  });

  it('role=assistant_manager → tier=3', () => {
    const u = makeStubUser({ role: 'assistant_manager', isSuperAdmin: false, changedFields: ['role'] });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(3);
    expect(u.role).toBe('assistant_manager');
  });

  it('role=member → tier=4', () => {
    const u = makeStubUser({ role: 'member', isSuperAdmin: false, changedFields: ['role'] });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(4);
  });

  it('isSuperAdmin=true → tier=1, role preserved if admin', () => {
    const u = makeStubUser({ role: 'admin', isSuperAdmin: true, changedFields: ['isSuperAdmin'] });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(1);
    expect(u.role).toBe('admin');
  });

  it('isSuperAdmin=true → tier=1, role preserved if manager', () => {
    const u = makeStubUser({ role: 'manager', isSuperAdmin: true, changedFields: ['isSuperAdmin'] });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(1);
    expect(u.role).toBe('manager');
  });

  it('isSuperAdmin flipped to false on T1 manager → tier=2, role still manager', () => {
    // The legacy field is what changed, so legacy wins. tier recomputed
    // from (role='manager', isSuperAdmin=false) → 2.
    const u = makeStubUser({
      tier: 1, role: 'manager', isSuperAdmin: false,
      changedFields: ['isSuperAdmin'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(2);
    expect(u.role).toBe('manager');
    expect(u.isSuperAdmin).toBe(false);
  });
});

// ── Direction: tier change → legacy ────────────────────────────────────

describe('tier → legacy', () => {
  it('tier=1 → isSuperAdmin=true, role canonicalized to admin if not admin/manager', () => {
    const u = makeStubUser({
      tier: 1, role: 'member', isSuperAdmin: false,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.isSuperAdmin).toBe(true);
    expect(u.role).toBe('admin');
  });

  it('tier=1 preserves existing role=manager', () => {
    const u = makeStubUser({
      tier: 1, role: 'manager', isSuperAdmin: false,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.isSuperAdmin).toBe(true);
    expect(u.role).toBe('manager');
  });

  it('tier=1 preserves existing role=admin', () => {
    const u = makeStubUser({
      tier: 1, role: 'admin', isSuperAdmin: false,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.isSuperAdmin).toBe(true);
    expect(u.role).toBe('admin');
  });

  it('tier=2 with existing role=manager → preserve manager', () => {
    const u = makeStubUser({
      tier: 2, role: 'manager', isSuperAdmin: false,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.role).toBe('manager');
    expect(u.isSuperAdmin).toBe(false);
  });

  it('tier=2 with existing role=member → canonicalize to admin', () => {
    const u = makeStubUser({
      tier: 2, role: 'member', isSuperAdmin: false,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.role).toBe('admin');
    expect(u.isSuperAdmin).toBe(false);
  });

  it('tier=2 demotion from T1 clears isSuperAdmin', () => {
    const u = makeStubUser({
      tier: 2, role: 'admin', isSuperAdmin: true,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.isSuperAdmin).toBe(false);
    expect(u.role).toBe('admin');
  });

  it('tier=3 → role=assistant_manager always', () => {
    const u = makeStubUser({
      tier: 3, role: 'admin', isSuperAdmin: true,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.role).toBe('assistant_manager');
    expect(u.isSuperAdmin).toBe(false);
  });

  it('tier=4 → role=member always', () => {
    const u = makeStubUser({
      tier: 4, role: 'manager', isSuperAdmin: true,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.role).toBe('member');
    expect(u.isSuperAdmin).toBe(false);
  });

  it('invalid tier (out of range) is a defensive no-op (DB CHECK rejects)', () => {
    const u = makeStubUser({
      tier: 99, role: 'member', isSuperAdmin: false,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    // Sync did not run because tier is invalid; legacy unchanged.
    expect(u.role).toBe('member');
    expect(u.isSuperAdmin).toBe(false);
  });
});

// ── Direction: tier change WINS when both sides changed ────────────────

describe('precedence — tier wins when both sides changed', () => {
  it('tier=3 + role=admin both set → tier wins, role becomes assistant_manager', () => {
    const u = makeStubUser({
      tier: 3, role: 'admin', isSuperAdmin: true,
      changedFields: ['tier', 'role', 'isSuperAdmin'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(3);
    expect(u.role).toBe('assistant_manager');
    expect(u.isSuperAdmin).toBe(false);
  });
});

// ── New record creation ────────────────────────────────────────────────

describe('new record creation', () => {
  it('new with role=admin only → tier filled to 2', () => {
    const u = makeStubUser({
      role: 'admin', isSuperAdmin: false, isNewRecord: true,
      // Sequelize's .changed() returns true for fields the caller passed
      // in .create(). Here that's role only; tier took its default.
      changedFields: ['role'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(2);
    expect(u.role).toBe('admin');
  });

  it('new with tier=1 only → legacy filled (admin + isSuperAdmin)', () => {
    const u = makeStubUser({
      tier: 1, role: 'member', isSuperAdmin: false, isNewRecord: true,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(1);
    expect(u.role).toBe('admin');
    expect(u.isSuperAdmin).toBe(true);
  });

  it('new with tier=3 only → role=assistant_manager', () => {
    const u = makeStubUser({
      tier: 3, role: 'member', isSuperAdmin: false, isNewRecord: true,
      changedFields: ['tier'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.role).toBe('assistant_manager');
  });

  it('new with all defaults (no fields explicitly set) → consistent (tier=4, role=member)', () => {
    // Sequelize defaults: tier=4, role='member', isSuperAdmin=false. The
    // "isNewRecord with no changedFields" branch fires; result is consistent.
    const u = makeStubUser({
      tier: 4, role: 'member', isSuperAdmin: false, isNewRecord: true,
      changedFields: [],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(4);
    expect(u.role).toBe('member');
    expect(u.isSuperAdmin).toBe(false);
  });

  it('new with role=member explicit → tier recomputed to 4', () => {
    const u = makeStubUser({
      role: 'member', isSuperAdmin: false, isNewRecord: true,
      changedFields: ['role'],
    });
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(4);
  });
});

// ── Loop safety ─────────────────────────────────────────────────────────

describe('loop safety', () => {
  it('no change + not new record → strict no-op, fields untouched', () => {
    const u = makeStubUser({
      tier: 2, role: 'manager', isSuperAdmin: false,
      changedFields: [],
    });
    const before = { tier: u.tier, role: u.role, isSuperAdmin: u.isSuperAdmin };
    syncTierAndLegacyOnUser(u);
    expect(u.tier).toBe(before.tier);
    expect(u.role).toBe(before.role);
    expect(u.isSuperAdmin).toBe(before.isSuperAdmin);
  });

  it('handles user without .changed() method gracefully (legacy/test stubs)', () => {
    const u = { tier: 3, role: 'assistant_manager', isSuperAdmin: false, isNewRecord: false };
    expect(() => syncTierAndLegacyOnUser(u)).not.toThrow();
    // Without .changed(), the function treats every field as unchanged and
    // does nothing on a non-new record.
    expect(u.tier).toBe(3);
    expect(u.role).toBe('assistant_manager');
  });

  it('null user → no-op, no throw', () => {
    expect(() => syncTierAndLegacyOnUser(null)).not.toThrow();
    expect(() => syncTierAndLegacyOnUser(undefined)).not.toThrow();
  });
});
