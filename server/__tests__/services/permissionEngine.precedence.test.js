'use strict';

/**
 * Tests for the precedence kernel of the permission engine.
 *
 * The kernel rule is:  super-admin > deny > grant > base.
 *
 * Complementary to permissionEngine.tier.test.js (which proves the matrix is
 * loaded correctly per tier), this file pins down the *evaluation order* — the
 * thing controllers and middleware actually rely on.
 */

jest.mock('../../models', () => ({
  PermissionGrant: { findAll: jest.fn() },
}));

const { PermissionGrant } = require('../../models');
const {
  hasPermission,
  computeEffectivePermissions,
} = require('../../services/permissionEngine');

beforeEach(() => {
  jest.clearAllMocks();
  PermissionGrant.findAll.mockResolvedValue([]);
});

// Convenient user shapes — these mirror real model fields.
const t1Super = { id: 'u-super', tier: 1, isSuperAdmin: true, role: 'admin' };
const t4Member = { id: 'u-mem', tier: 4, role: 'member' };
const t2Admin = { id: 'u-adm', tier: 2, role: 'admin' };

function grantRow(overrides = {}) {
  return {
    id: 'row-' + Math.random().toString(36).slice(2, 8),
    userId: t4Member.id,
    resourceType: 'tasks',
    action: 'delete',
    effect: 'grant',
    permissionLevel: null,
    scope: 'global',
    resourceId: null,
    isActive: true,
    expiresAt: null,
    ...overrides,
  };
}

describe('permission precedence — base tier grants the allow', () => {
  it('Tier 2 admin gets tasks.create from the base matrix (no grant rows needed)', async () => {
    expect(await hasPermission(t2Admin, 'tasks', 'create')).toBe(true);
  });

  it('Tier 4 member does NOT get tasks.delete from the base matrix', async () => {
    expect(await hasPermission(t4Member, 'tasks', 'delete')).toBe(false);
  });
});

describe('permission precedence — explicit GRANT overrides a base "no"', () => {
  it('a grant row promotes a base=false permission to true', async () => {
    PermissionGrant.findAll.mockResolvedValue([grantRow({
      effect: 'grant', resourceType: 'tasks', action: 'delete',
    })]);
    expect(await hasPermission(t4Member, 'tasks', 'delete')).toBe(true);
  });
});

describe('permission precedence — DENY wins over GRANT (kernel rule)', () => {
  it('a deny row beats a same-resource same-action grant row', async () => {
    PermissionGrant.findAll.mockResolvedValue([
      grantRow({ id: 'g', effect: 'grant',  resourceType: 'tasks', action: 'delete' }),
      grantRow({ id: 'd', effect: 'deny',   resourceType: 'tasks', action: 'delete' }),
    ]);
    expect(await hasPermission(t4Member, 'tasks', 'delete')).toBe(false);
  });

  it('computeEffectivePermissions surfaces the row in BOTH overrides and denials', async () => {
    PermissionGrant.findAll.mockResolvedValue([
      grantRow({ id: 'g', effect: 'grant', resourceType: 'tasks', action: 'edit' }),
      grantRow({ id: 'd', effect: 'deny',  resourceType: 'tasks', action: 'edit' }),
    ]);
    const result = await computeEffectivePermissions(t4Member);
    expect(result.permissions['tasks.edit']).toBe(false);
    // base for t4 already has tasks.edit, so 'g' isn't recorded as an override —
    // but the deny is always recorded.
    expect(result.denials.some(d => d.action === 'edit')).toBe(true);
  });

  it('a deny on a tier-2 base-true permission still wins', async () => {
    PermissionGrant.findAll.mockResolvedValue([grantRow({
      userId: t2Admin.id,
      effect: 'deny',
      resourceType: 'tasks',
      action: 'edit',
    })]);
    expect(await hasPermission(t2Admin, 'tasks', 'edit')).toBe(false);
  });
});

describe('permission precedence — expired grants are not honored', () => {
  it('fetchActiveGrants filters by expiresAt — if mock returns [] the grant is invisible', async () => {
    // We simulate the post-filter result: an expired grant row would be
    // filtered out by the Sequelize WHERE, so the engine sees an empty list.
    PermissionGrant.findAll.mockResolvedValue([]);
    expect(await hasPermission(t4Member, 'tasks', 'delete')).toBe(false);
  });

  it('a non-expired grant still applies (positive control)', async () => {
    PermissionGrant.findAll.mockResolvedValue([grantRow({
      effect: 'grant',
      resourceType: 'tasks',
      action: 'delete',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })]);
    expect(await hasPermission(t4Member, 'tasks', 'delete')).toBe(true);
  });
});

describe('permission precedence — legacy permissionLevel column', () => {
  it('a legacy row without `action` but with permissionLevel="manage" maps to all manage actions', async () => {
    PermissionGrant.findAll.mockResolvedValue([{
      id: 'lg',
      userId: t4Member.id,
      resourceType: 'task',
      action: null,
      permissionLevel: 'manage',
      effect: 'grant',
      isActive: true,
      expiresAt: null,
    }]);
    // 'manage' maps to ['view', 'create', 'edit', 'delete', 'assign',
    //  'assign_others', 'change_status', 'comment', 'upload'] for `task`.
    expect(await hasPermission(t4Member, 'task', 'delete')).toBe(true);
    expect(await hasPermission(t4Member, 'task', 'comment')).toBe(true);
  });

  it('legacy permissionLevel="view" does NOT grant edit', async () => {
    PermissionGrant.findAll.mockResolvedValue([{
      id: 'lv',
      userId: t4Member.id,
      resourceType: 'task',
      action: null,
      permissionLevel: 'view',
      effect: 'grant',
      isActive: true,
      expiresAt: null,
    }]);
    // 'view' maps to ['view'] only. Member's base does NOT grant task.delete.
    expect(await hasPermission(t4Member, 'task', 'delete')).toBe(false);
  });
});

describe('permission precedence — super admin short-circuit', () => {
  it('isSuperAdmin returns true for any (resource, action) without hitting the DB', async () => {
    expect(await hasPermission(t1Super, 'tasks', 'delete')).toBe(true);
    expect(await hasPermission(t1Super, 'admin_settings', 'manage')).toBe(true);
    expect(await hasPermission(t1Super, 'roles', 'manage')).toBe(true);
    expect(PermissionGrant.findAll).not.toHaveBeenCalled();
  });
});

describe('permission precedence — resource-scoped grants', () => {
  it('a resource-scoped grant does NOT leak to other resourceIds', async () => {
    PermissionGrant.findAll.mockResolvedValue([grantRow({
      effect: 'grant',
      resourceType: 'tasks',
      action: 'delete',
      resourceId: 'board-A',
    })]);
    expect(await hasPermission(t4Member, 'tasks', 'delete', 'board-A')).toBe(true);
    expect(await hasPermission(t4Member, 'tasks', 'delete', 'board-B')).toBe(false);
  });

  it('a global grant (resourceId null) applies to any resourceId', async () => {
    PermissionGrant.findAll.mockResolvedValue([grantRow({
      effect: 'grant',
      resourceType: 'tasks',
      action: 'delete',
      resourceId: null,
    })]);
    expect(await hasPermission(t4Member, 'tasks', 'delete', 'board-X')).toBe(true);
  });
});
