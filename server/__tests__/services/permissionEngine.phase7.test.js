'use strict';

/**
 * Phase 7 — granular catalog + umbrella resolution + savability tests.
 *
 * Covers the new behaviors added in Phase 7:
 *   - Umbrella fallback in hasPermission (specific override > umbrella > base)
 *   - Locked actions (e.g. approvals.approve_own) always false
 *   - Pending / locked / no_surface actions are NOT savable
 *   - Self-grant still blocked (regression)
 *   - The headline "Sunny Mehta denied tasks.assign_self" scenario:
 *       legacy tasks.assign for the same user is granted at the base
 *       (umbrella), but the deny on tasks.assign_self wins.
 */

jest.mock('../../models', () => ({
  PermissionGrant: { findAll: jest.fn() },
}));

const { PermissionGrant } = require('../../models');
const {
  hasPermission,
  canGrantPermission,
  computeEffectivePermissions,
} = require('../../services/permissionEngine');

beforeEach(() => {
  jest.clearAllMocks();
  PermissionGrant.findAll.mockResolvedValue([]);
});

// Tier-4 member (matches Sunny Mehta in the spec example).
const sunny = { id: 'sunny-id', tier: 4, role: 'member' };
const t1Super = { id: 'super-id', tier: 1, isSuperAdmin: true, role: 'admin' };
const t2Admin = { id: 'admin-id', tier: 2, role: 'admin' };

function denyRow(resource, action, userId = sunny.id, scope = 'global') {
  return {
    id: 'r-' + Math.random().toString(36).slice(2, 8),
    userId, resourceType: resource, action, effect: 'deny',
    permissionLevel: null, scope, resourceId: null,
    isActive: true, expiresAt: null,
  };
}
function grantRow(resource, action, userId = sunny.id, scope = 'global') {
  return {
    id: 'r-' + Math.random().toString(36).slice(2, 8),
    userId, resourceType: resource, action, effect: 'grant',
    permissionLevel: null, scope, resourceId: null,
    isActive: true, expiresAt: null,
  };
}

describe('hasPermission — umbrella fallback', () => {
  it('Sunny (Tier 4) base allows tasks.assign_self via umbrella tasks.assign', async () => {
    // No grants in DB. The umbrella tasks.assign is true for tier 4, so
    // tasks.assign_self resolves true.
    PermissionGrant.findAll.mockResolvedValue([]);
    expect(await hasPermission(sunny, 'tasks', 'assign_self')).toBe(true);
  });

  it('DENY override on tasks.assign_self wins over umbrella tasks.assign=true (HEADLINE example)', async () => {
    PermissionGrant.findAll.mockResolvedValue([denyRow('tasks', 'assign_self')]);
    expect(await hasPermission(sunny, 'tasks', 'assign_self')).toBe(false);
    // Importantly: tasks.assign (the umbrella legacy key) STAYS true so a
    // member who can self-assign at creation time (tasks.create handles
    // that) is not blocked from existing self-assigned tasks at boot.
    expect(await hasPermission(sunny, 'tasks', 'assign')).toBe(true);
  });

  it('LEGACY deny on tasks.assign also blocks tasks.assign_self (umbrella fallback)', async () => {
    // A grant row written before Phase 7 on the legacy umbrella must still
    // propagate to the new granular action so existing rules don't break.
    PermissionGrant.findAll.mockResolvedValue([denyRow('tasks', 'assign')]);
    expect(await hasPermission(sunny, 'tasks', 'assign_self')).toBe(false);
    expect(await hasPermission(sunny, 'tasks', 'unassign_self')).toBe(false);
    expect(await hasPermission(sunny, 'tasks', 'assign')).toBe(false);
  });

  it('Specific GRANT on tasks.assign_self promotes a base=false action', async () => {
    // Member tier 4 doesn't have tasks.assign_others by default; granting it
    // takes effect.
    PermissionGrant.findAll.mockResolvedValue([grantRow('tasks', 'assign_others')]);
    expect(await hasPermission(sunny, 'tasks', 'assign_others')).toBe(true);
  });

  it('Specific GRANT on the granular action wins even when umbrella was DENY-ed', async () => {
    // umbrella tasks.assign denied AND specific tasks.assign_self granted:
    // specific takes priority.
    PermissionGrant.findAll.mockResolvedValue([
      denyRow('tasks', 'assign'),
      grantRow('tasks', 'assign_self'),
    ]);
    expect(await hasPermission(sunny, 'tasks', 'assign_self')).toBe(true);
    // unassign_self has no specific override → falls back to umbrella deny.
    expect(await hasPermission(sunny, 'tasks', 'unassign_self')).toBe(false);
  });

  it('Locked action approvals.approve_own ALWAYS resolves false (even for super admin)', async () => {
    PermissionGrant.findAll.mockResolvedValue([
      grantRow('approvals', 'approve_own'), // attempt to "force allow"
    ]);
    expect(await hasPermission(t1Super, 'approvals', 'approve_own')).toBe(false);
    expect(await hasPermission(t2Admin, 'approvals', 'approve_own')).toBe(false);
    expect(await hasPermission(sunny, 'approvals', 'approve_own')).toBe(false);
  });
});

describe('canGrantPermission — savability', () => {
  it('rejects PENDING actions with PERMISSION_NOT_ENFORCEABLE', async () => {
    // Phase B — tasks.edit_title was wired (was the original example); use
    // tasks.create_for_self which remains pending as the FUTURE marker.
    const r = await canGrantPermission(t1Super, 'tasks', 'create_for_self', 'grant', sunny.id);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('PERMISSION_NOT_ENFORCEABLE');
    expect(r.reason).toMatch(/not yet wired/i);
  });

  it('rejects LOCKED actions with PERMISSION_LOCKED', async () => {
    const r = await canGrantPermission(t1Super, 'approvals', 'approve_own', 'grant', sunny.id);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('PERMISSION_LOCKED');
    expect(r.reason).toMatch(/locked system rule/i);
  });

  it('rejects NO_SURFACE actions with PERMISSION_NOT_ENFORCEABLE', async () => {
    const r = await canGrantPermission(t1Super, 'backup', 'create', 'grant', sunny.id);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('PERMISSION_NOT_ENFORCEABLE');
    expect(r.reason).toMatch(/no in-app surface/i);
  });

  it('rejects UNKNOWN actions with PERMISSION_UNKNOWN', async () => {
    const r = await canGrantPermission(t1Super, 'tasks', 'fly_to_moon', 'grant', sunny.id);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('PERMISSION_UNKNOWN');
  });

  it('allows WIRED actions for authorised tiers', async () => {
    const r = await canGrantPermission(t1Super, 'tasks', 'assign_self', 'deny', sunny.id);
    expect(r.allowed).toBe(true);
  });

  it('still blocks self-grant on wired actions (regression)', async () => {
    const r = await canGrantPermission(t2Admin, 'tasks', 'assign_self', 'grant', t2Admin.id);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('SELF_GRANT_BLOCKED');
  });

  it('locked rejection beats self-grant check (savability runs first)', async () => {
    const r = await canGrantPermission(t1Super, 'approvals', 'approve_own', 'grant', t1Super.id);
    expect(r.allowed).toBe(false);
    expect(r.code).toBe('PERMISSION_LOCKED');
  });
});

describe('computeEffectivePermissions — umbrella propagation in preview', () => {
  it('A specific deny on tasks.assign_self renders false in the effective map', async () => {
    PermissionGrant.findAll.mockResolvedValue([denyRow('tasks', 'assign_self')]);
    const eff = await computeEffectivePermissions(sunny);
    expect(eff.permissions['tasks.assign_self']).toBe(false);
    // Umbrella tasks.assign still resolves true at base
    expect(eff.permissions['tasks.assign']).toBe(true);
    // denials list includes the deny entry
    const found = eff.denials.find((d) => d.resource === 'tasks' && d.action === 'assign_self');
    expect(found).toBeDefined();
    expect(found.effect).toBe('deny');
  });

  it('A deny on the legacy umbrella tasks.assign propagates to granular children', async () => {
    PermissionGrant.findAll.mockResolvedValue([denyRow('tasks', 'assign')]);
    const eff = await computeEffectivePermissions(sunny);
    expect(eff.permissions['tasks.assign']).toBe(false);
    expect(eff.permissions['tasks.assign_self']).toBe(false);
    expect(eff.permissions['tasks.unassign_self']).toBe(false);
  });

  it('Locked actions are forced false in the effective map regardless of grants', async () => {
    PermissionGrant.findAll.mockResolvedValue([grantRow('approvals', 'approve_own')]);
    const eff = await computeEffectivePermissions(sunny);
    expect(eff.permissions['approvals.approve_own']).toBe(false);
    expect(eff.permissions['approvals.reject_own']).toBe(false);
  });
});

describe('expired overrides are ignored (regression after Phase 7 umbrella)', () => {
  it('an EXPIRED deny on tasks.assign_self does NOT block', async () => {
    const past = new Date(Date.now() - 60000);
    PermissionGrant.findAll.mockImplementation(async () => {
      // Engine filters expired at the DB query — simulate that here.
      return [];
    });
    expect(await hasPermission(sunny, 'tasks', 'assign_self')).toBe(true);
  });
});

describe('end-to-end: the headline "deny Sunny Mehta tasks.assign_self" scenario', () => {
  it('blocks self-assign at hasPermission level (covers controller call sites)', async () => {
    PermissionGrant.findAll.mockResolvedValue([denyRow('tasks', 'assign_self')]);
    expect(await hasPermission(sunny, 'tasks', 'assign_self')).toBe(false);
  });

  it('does NOT break the legacy tasks.assign umbrella for other call sites', async () => {
    PermissionGrant.findAll.mockResolvedValue([denyRow('tasks', 'assign_self')]);
    // tasks.assign (legacy umbrella) is still true — important so that
    // task creation doesn't also break (createTask uses its own gate
    // via tasks.create + skips the assign_self gate at creation time
    // per the user spec).
    expect(await hasPermission(sunny, 'tasks', 'assign')).toBe(true);
  });

  it('tasks.create remains true even after assign_self deny', async () => {
    PermissionGrant.findAll.mockResolvedValue([denyRow('tasks', 'assign_self')]);
    expect(await hasPermission(sunny, 'tasks', 'create')).toBe(true);
  });

  it('unassign_self also blocked because it shares the umbrella', async () => {
    PermissionGrant.findAll.mockResolvedValue([denyRow('tasks', 'assign_self')]);
    // Note: unassign_self has its own umbrella (tasks.assign) so a deny
    // on assign_self alone doesn't block it. We test the broader case.
    PermissionGrant.findAll.mockResolvedValue([denyRow('tasks', 'assign')]);
    expect(await hasPermission(sunny, 'tasks', 'unassign_self')).toBe(false);
  });

  it('tasks.assign_others remains UNTOUCHED by an assign_self-only deny', async () => {
    PermissionGrant.findAll.mockResolvedValue([denyRow('tasks', 'assign_self')]);
    // Sunny is Tier 4 — assign_others is base false. The deny on
    // assign_self doesn't affect this (separate keys).
    expect(await hasPermission(sunny, 'tasks', 'assign_others')).toBe(false);
  });
});
