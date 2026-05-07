'use strict';

/**
 * Phase 5b — Tier-aware permission engine tests.
 *
 * Verifies that:
 *   - Users with a valid `tier` column → engine reads TIER_PERMISSIONS.
 *   - Users WITHOUT a tier column → engine falls back to ROLE_PERMISSIONS
 *     (legacy compat for pre-migration-014 environments).
 *   - Deny precedence + grant overlay still work after the lookup change.
 *   - computeEffectivePermissions returns the new `tier` field.
 *
 * Mocks PermissionGrant.findAll so no DB is required.
 */

jest.mock('../../models', () => ({
  PermissionGrant: { findAll: jest.fn() },
}));

const { PermissionGrant } = require('../../models');
const {
  hasPermission,
  computeEffectivePermissions,
  getEffectiveBasePermission,
  getEffectiveBasePermissions,
  canGrantPermission,
} = require('../../services/permissionEngine');

beforeEach(() => {
  jest.clearAllMocks();
  PermissionGrant.findAll.mockResolvedValue([]);
});

const t1User       = { id: 'u-t1', tier: 1, isSuperAdmin: true,  role: 'admin' };
const t2AdminUser  = { id: 'u-t2a', tier: 2,                     role: 'admin' };
const t2MgrUser    = { id: 'u-t2m', tier: 2,                     role: 'manager' };
const t3User       = { id: 'u-t3',  tier: 3,                     role: 'assistant_manager' };
const t4User       = { id: 'u-t4',  tier: 4,                     role: 'member' };

// Pre-migration users — tier column missing.
const legacyAdmin   = { id: 'u-l-a', role: 'admin' };
const legacyManager = { id: 'u-l-m', role: 'manager' };
const legacyMember  = { id: 'u-l-mb', role: 'member' };

// ── getEffectiveBasePermission ───────────────────────────────────────────

describe('getEffectiveBasePermission', () => {
  it('Tier 1 returns true for every action', () => {
    expect(getEffectiveBasePermission(t1User, 'tasks',     'delete')).toBe(true);
    expect(getEffectiveBasePermission(t1User, 'workspaces','delete')).toBe(true);
    expect(getEffectiveBasePermission(t1User, 'admin_settings', 'manage')).toBe(true);
  });

  it('Tier 2 returns FALSE for delete actions (decision #4)', () => {
    expect(getEffectiveBasePermission(t2AdminUser, 'tasks', 'delete')).toBe(false);
    expect(getEffectiveBasePermission(t2AdminUser, 'workspaces', 'delete')).toBe(false);
    expect(getEffectiveBasePermission(t2AdminUser, 'boards', 'delete')).toBe(false);
    expect(getEffectiveBasePermission(t2AdminUser, 'users', 'delete')).toBe(false);
    // Same applies regardless of legacy role within Tier 2.
    expect(getEffectiveBasePermission(t2MgrUser, 'tasks', 'delete')).toBe(false);
  });

  it('Tier 2 returns true for non-destructive management actions', () => {
    expect(getEffectiveBasePermission(t2AdminUser, 'tasks', 'create')).toBe(true);
    expect(getEffectiveBasePermission(t2AdminUser, 'tasks', 'edit')).toBe(true);
    expect(getEffectiveBasePermission(t2AdminUser, 'tasks', 'assign_others')).toBe(true);
    expect(getEffectiveBasePermission(t2AdminUser, 'workspaces', 'edit')).toBe(true);
    expect(getEffectiveBasePermission(t2AdminUser, 'feedback', 'manage')).toBe(true);
  });

  it('Tier 2 returns FALSE for admin_settings / integrations / api_keys (T1 only)', () => {
    expect(getEffectiveBasePermission(t2AdminUser, 'admin_settings', 'view')).toBe(false);
    expect(getEffectiveBasePermission(t2AdminUser, 'admin_settings', 'manage')).toBe(false);
    expect(getEffectiveBasePermission(t2AdminUser, 'integrations',   'view')).toBe(false);
    expect(getEffectiveBasePermission(t2AdminUser, 'api_keys',       'manage')).toBe(false);
  });

  it('Tier 3 cannot delete shared resources but can delete personal data', () => {
    expect(getEffectiveBasePermission(t3User, 'tasks', 'delete')).toBe(false);
    expect(getEffectiveBasePermission(t3User, 'notes', 'delete')).toBe(true);
  });

  it('Tier 4 (member-equivalent) preserves legacy member behavior', () => {
    expect(getEffectiveBasePermission(t4User, 'tasks', 'create')).toBe(true);
    expect(getEffectiveBasePermission(t4User, 'tasks', 'set_priority')).toBe(false);
    expect(getEffectiveBasePermission(t4User, 'tasks', 'assign_others')).toBe(false);
    expect(getEffectiveBasePermission(t4User, 'boards', 'create')).toBe(true);
    expect(getEffectiveBasePermission(t4User, 'notes', 'delete')).toBe(true);
  });

  it('Tier 1 + Tier 2 have tasks.edit_locked_description (decision #10 revised)', () => {
    expect(getEffectiveBasePermission(t1User, 'tasks', 'edit_locked_description')).toBe(true);
    expect(getEffectiveBasePermission(t2AdminUser, 'tasks', 'edit_locked_description')).toBe(true);
    expect(getEffectiveBasePermission(t3User, 'tasks', 'edit_locked_description')).toBe(false);
    expect(getEffectiveBasePermission(t4User, 'tasks', 'edit_locked_description')).toBe(false);
  });
});

// ── Legacy fallback ──────────────────────────────────────────────────────

describe('getEffectiveBasePermission — legacy users (no tier column)', () => {
  it('legacy admin retains delete access via ROLE_PERMISSIONS fallback', () => {
    // Pre-migration: tier column missing → engine falls back to legacy
    // role matrix where admin.tasks.delete = true. This is intentional
    // compat behavior; once migration 014 + Phase 3 hook populate tier,
    // the user lands on the tier matrix which says false.
    expect(getEffectiveBasePermission(legacyAdmin, 'tasks', 'delete')).toBe(true);
    expect(getEffectiveBasePermission(legacyAdmin, 'workspaces', 'delete')).toBe(true);
  });

  it('legacy manager retains its existing matrix entries', () => {
    expect(getEffectiveBasePermission(legacyManager, 'tasks', 'create')).toBe(true);
    expect(getEffectiveBasePermission(legacyManager, 'admin_settings', 'manage')).toBe(false);
  });

  it('legacy member retains member matrix entries', () => {
    expect(getEffectiveBasePermission(legacyMember, 'tasks', 'set_priority')).toBe(false);
    expect(getEffectiveBasePermission(legacyMember, 'notes', 'delete')).toBe(true);
  });

  it('returns false for null user', () => {
    expect(getEffectiveBasePermission(null, 'tasks', 'view')).toBe(false);
  });
});

// ── getEffectiveBasePermissions (flat shape) ─────────────────────────────

describe('getEffectiveBasePermissions', () => {
  it('returns tier-keyed flat map for tier-tagged user', () => {
    const flat = getEffectiveBasePermissions(t2AdminUser);
    expect(flat['tasks.create']).toBe(true);
    expect(flat['tasks.delete']).toBe(false);
    expect(flat['admin_settings.manage']).toBe(false);
  });

  it('returns role-keyed flat map for legacy user', () => {
    const flat = getEffectiveBasePermissions(legacyAdmin);
    // Legacy admin retains delete=true via role matrix.
    expect(flat['tasks.delete']).toBe(true);
  });
});

// ── hasPermission — tier-aware behavior ──────────────────────────────────

describe('hasPermission (Phase 5b — tier-aware)', () => {
  it('Tier 1 — short-circuits to true via isSuperAdmin', async () => {
    expect(await hasPermission(t1User, 'tasks', 'delete')).toBe(true);
    expect(await hasPermission(t1User, 'admin_settings', 'manage')).toBe(true);
    // Should not even need to query grants for super admin.
    expect(PermissionGrant.findAll).not.toHaveBeenCalled();
  });

  it('Tier 2 admin — DENIED on tasks.delete via tier matrix', async () => {
    expect(await hasPermission(t2AdminUser, 'tasks', 'delete')).toBe(false);
    expect(await hasPermission(t2AdminUser, 'workspaces', 'delete')).toBe(false);
  });

  it('Tier 2 admin — ALLOWED on non-destructive management actions', async () => {
    expect(await hasPermission(t2AdminUser, 'tasks', 'edit')).toBe(true);
    expect(await hasPermission(t2AdminUser, 'tasks', 'assign_others')).toBe(true);
    expect(await hasPermission(t2AdminUser, 'workspaces', 'edit')).toBe(true);
  });

  it('legacy admin (no tier) — STILL allowed on tasks.delete (compat)', async () => {
    // Pre-migration users keep working as before. After migration 014 +
    // Phase 3 hook populates tier=2, the same user becomes denied.
    expect(await hasPermission(legacyAdmin, 'tasks', 'delete')).toBe(true);
  });

  it('Tier 4 — denied on set_priority (decision #9)', async () => {
    expect(await hasPermission(t4User, 'tasks', 'set_priority')).toBe(false);
  });

  it('deny override still wins over base permission', async () => {
    PermissionGrant.findAll.mockResolvedValue([
      {
        id: 'g-deny',
        userId: t2AdminUser.id,
        resourceType: 'tasks',
        action: 'edit',
        effect: 'deny',
        permissionLevel: null,
        scope: 'global',
        resourceId: null,
        isActive: true,
        expiresAt: null,
      },
    ]);
    expect(await hasPermission(t2AdminUser, 'tasks', 'edit')).toBe(false);
  });

  it('grant override extends base permission (T4 + grant on tasks.delete)', async () => {
    PermissionGrant.findAll.mockResolvedValue([
      {
        id: 'g-grant',
        userId: t4User.id,
        resourceType: 'tasks',
        action: 'delete',
        effect: 'grant',
        permissionLevel: null,
        scope: 'global',
        resourceId: null,
        isActive: true,
        expiresAt: null,
      },
    ]);
    expect(await hasPermission(t4User, 'tasks', 'delete')).toBe(true);
  });

  it('deny on Tier 2 still wins even though base was already false', async () => {
    // T2 is already denied tasks.delete by base; an explicit deny is
    // redundant but should not crash and should still return false.
    PermissionGrant.findAll.mockResolvedValue([
      {
        id: 'g-deny-redundant',
        userId: t2AdminUser.id,
        resourceType: 'tasks',
        action: 'delete',
        effect: 'deny',
        isActive: true,
        expiresAt: null,
      },
    ]);
    expect(await hasPermission(t2AdminUser, 'tasks', 'delete')).toBe(false);
  });

  it('returns false when user is null', async () => {
    expect(await hasPermission(null, 'tasks', 'view')).toBe(false);
  });
});

// ── computeEffectivePermissions ─────────────────────────────────────────

describe('computeEffectivePermissions (Phase 5b)', () => {
  it('Tier 1 returns full permissions and tier=1 in response', async () => {
    const result = await computeEffectivePermissions(t1User);
    expect(result.isSuperAdmin).toBe(true);
    expect(result.tier).toBe(1);
    expect(result.role).toBe('admin');
    expect(result.permissions['tasks.delete']).toBe(true);
    expect(result.permissions['admin_settings.manage']).toBe(true);
  });

  it('Tier 2 admin returns tier matrix with delete actions FALSE', async () => {
    const result = await computeEffectivePermissions(t2AdminUser);
    expect(result.tier).toBe(2);
    expect(result.role).toBe('admin');
    expect(result.permissions['tasks.delete']).toBe(false);
    expect(result.permissions['tasks.edit']).toBe(true);
    expect(result.permissions['admin_settings.manage']).toBe(false);
    expect(result.basePermissions['tasks.delete']).toBe(false);
  });

  it('Tier 4 returns the member-equivalent matrix', async () => {
    const result = await computeEffectivePermissions(t4User);
    expect(result.tier).toBe(4);
    expect(result.permissions['tasks.create']).toBe(true);
    expect(result.permissions['tasks.set_priority']).toBe(false);
    expect(result.permissions['notes.delete']).toBe(true);
  });

  it('legacy admin (no tier column) gets ROLE matrix (compat)', async () => {
    const result = await computeEffectivePermissions(legacyAdmin);
    // Tier resolved from legacy → 2, but basePerms uses role matrix path.
    expect(result.tier).toBe(2);
    expect(result.permissions['tasks.delete']).toBe(true); // legacy admin keeps delete
    expect(result.basePermissions['tasks.delete']).toBe(true);
  });

  it('grants applied as overrides; denies suppress the result', async () => {
    PermissionGrant.findAll.mockResolvedValue([
      {
        id: 'g1', userId: t4User.id, resourceType: 'tasks', action: 'delete',
        effect: 'grant', isActive: true, expiresAt: null, scope: 'global',
      },
      {
        id: 'g2', userId: t4User.id, resourceType: 'tasks', action: 'edit',
        effect: 'deny', isActive: true, expiresAt: null, scope: 'global',
      },
    ]);
    const result = await computeEffectivePermissions(t4User);
    expect(result.permissions['tasks.delete']).toBe(true);  // grant adds it
    expect(result.permissions['tasks.edit']).toBe(false);   // deny removes it
    expect(result.overrides.some(o => o.action === 'delete')).toBe(true);
    expect(result.denials.some(d => d.action === 'edit')).toBe(true);
  });
});

// ── canGrantPermission — tier-aware base check ───────────────────────────

describe('canGrantPermission (Phase 5b)', () => {
  it('Tier 1 (super admin) may grant anything', async () => {
    const r = await canGrantPermission(t1User, 'admin_settings', 'manage', 'grant');
    expect(r.allowed).toBe(true);
  });

  it('manager-role granter cannot grant admin_settings', async () => {
    // Phase 5b — TIER_PERMISSIONS[2].admin_settings.manage is now false,
    // so the manager fails the "do you have this permission?" check
    // BEFORE reaching the "admin_settings is admin-only" block. Either
    // refusal is correct; the contract is "denied, with a reason".
    const r = await canGrantPermission(t2MgrUser, 'admin_settings', 'manage', 'grant');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cannot grant administrative|do not have/i);
  });

  it('manager-role granter cannot grant tasks.delete (T2 base says no, no own perm)', async () => {
    // Tier 2 manager has tasks.delete=false in TIER_PERMISSIONS. Without a
    // grant, hasPermission also returns false. So they cannot grant it.
    PermissionGrant.findAll.mockResolvedValue([]);
    const r = await canGrantPermission(t2MgrUser, 'tasks', 'delete', 'grant');
    expect(r.allowed).toBe(false);
  });

  it('non-admin/non-manager cannot grant', async () => {
    const r = await canGrantPermission(t4User, 'tasks', 'edit', 'grant');
    expect(r.allowed).toBe(false);
  });
});
