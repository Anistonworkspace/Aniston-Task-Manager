'use strict';

/**
 * Phase A — Permission grant idempotency and race-safety.
 *
 * Pre-Phase-A the permission_grants table had no UNIQUE constraint on
 * active overrides. Two concurrent POST /api/permissions requests could
 * both pass the findOne-existing check and persist duplicate ACTIVE rows.
 * A later DELETE only revoked one, leaving the engine to flap between
 * "grant + grant" and "deny + deny" states.
 *
 * Phase A:
 *   - Adds a partial UNIQUE index via migration 017.
 *   - Hardens grantPermission + multiGrant to catch
 *     SequelizeUniqueConstraintError, re-read the winning row, update it,
 *     and return success with raceResolved=true. The endpoint is
 *     idempotent on the (userId, resourceType, resourceId, action, effect)
 *     tuple regardless of concurrency.
 *
 * This suite simulates the race by making PermissionGrant.create reject
 * with SequelizeUniqueConstraintError and asserts the controller
 * recovers gracefully.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  PermissionGrant: {
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByPk: jest.fn(),
    findOrCreate: jest.fn(),
    create: jest.fn(),
  },
  User: {
    findByPk: jest.fn(),
    PILL_ATTRIBUTES: ['id', 'name', 'email', 'avatar', 'role', 'tier', 'isSuperAdmin'],
  },
}));

jest.mock('../../config/db', () => ({
  sequelize: {
    transaction: jest.fn(async () => ({
      commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(),
    })),
  },
}));

jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));

jest.mock('../../services/socketService', () => ({
  emitToUser: jest.fn(),
}));

jest.mock('../../middleware/permissions', () => ({
  getEffectivePermissions: jest.fn(),
}));

jest.mock('../../services/permissionEngine', () => ({
  computeEffectivePermissions: jest.fn(),
  canGrantPermission: jest.fn(async () => ({ allowed: true })),
  getPermissionMetadata: jest.fn(() => ({})),
  getPermissionCatalog: jest.fn(() => ({})),
  VALID_EFFECTS: ['grant', 'deny'],
}));

jest.mock('../../config/tiers', () => ({
  resolveTier: jest.fn(() => 1),
  TIER_1: 1,
  isValidTier: jest.fn(() => true),
}));

jest.mock('../../utils/safeLogger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../config/permissionMatrix', () => ({
  RESOURCES: { tasks: { label: 'Tasks' }, labels: { label: 'Labels' } },
  RESOURCE_ACTIONS: {
    tasks: ['view', 'create', 'edit', 'delete', 'assign_self', 'assign_others'],
    labels: ['view', 'create', 'edit', 'delete', 'add_to_task', 'remove_from_task'],
  },
  ROLE_PERMISSIONS: {},
  getBasePermissions: jest.fn(() => ({})),
  isBasePermission: jest.fn(() => false),
  getResourcesByCategory: jest.fn(() => ({})),
}));

const { PermissionGrant, User } = require('../../models');
const ctrl = require('../../controllers/permissionController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function uniqueConstraintError() {
  const e = new Error('duplicate key value violates unique constraint "uniq_permission_grants_active_override"');
  e.name = 'SequelizeUniqueConstraintError';
  return e;
}

beforeEach(() => {
  jest.clearAllMocks();
  User.findByPk.mockResolvedValue({
    id: 'target-user', name: 'Target', isSuperAdmin: false, role: 'member', tier: 4,
  });
});

// ── grantPermission — race-safe insert ────────────────────────────────────

describe('grantPermission — SequelizeUniqueConstraintError recovery', () => {
  test('happy path — first INSERT succeeds', async () => {
    PermissionGrant.findOne.mockResolvedValue(null); // no existing row
    PermissionGrant.create.mockResolvedValue({ id: 'new-grant', userId: 'target-user' });

    const req = {
      user: { id: 'admin-1', name: 'Admin', isSuperAdmin: true, tier: 1 },
      body: {
        userId: 'target-user',
        resourceType: 'labels',
        action: 'create',
        effect: 'grant',
      },
    };
    const res = mockRes();
    await ctrl.grantPermission(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(PermissionGrant.create).toHaveBeenCalled();
  });

  test('race lost — create throws unique-constraint, controller refetches winner and updates', async () => {
    // Race scenario: findOne saw no row, but by the time create() ran
    // a concurrent request had already inserted. The unique constraint
    // installed in migration 017 catches it. The catch block refetches
    // the winning row and updates it in place.
    const winnerUpdate = jest.fn().mockResolvedValue();
    const winner = { id: 'winner-grant', userId: 'target-user', update: winnerUpdate };

    PermissionGrant.findOne
      .mockResolvedValueOnce(null)    // initial check — no existing row
      .mockResolvedValueOnce(winner); // catch-block refetch — winner exists
    PermissionGrant.create.mockRejectedValue(uniqueConstraintError());

    const req = {
      user: { id: 'admin-1', name: 'Admin', isSuperAdmin: true, tier: 1 },
      body: {
        userId: 'target-user',
        resourceType: 'labels',
        action: 'create',
        effect: 'grant',
        expiresAt: null,
        reason: 'late grant',
      },
    };
    const res = mockRes();
    await ctrl.grantPermission(req, res);

    // 200 (updated) not 201 (created) — endpoint is idempotent.
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(winnerUpdate).toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.updated).toBe(true);
  });

  test('race lost AND refetch returns null → 500 (data corruption)', async () => {
    // Pathological case: the unique-constraint error fired, but our
    // refetch found nothing. This should NOT silently succeed — there
    // is a real data-integrity problem worth surfacing.
    PermissionGrant.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    PermissionGrant.create.mockRejectedValue(uniqueConstraintError());

    const req = {
      user: { id: 'admin-1', name: 'Admin', isSuperAdmin: true, tier: 1 },
      body: {
        userId: 'target-user',
        resourceType: 'labels',
        action: 'create',
        effect: 'grant',
      },
    };
    const res = mockRes();
    await ctrl.grantPermission(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('non-unique-constraint error still bubbles up to outer catch', async () => {
    // The race-recovery catch must NOT swallow generic DB errors. They
    // are different bugs and need different operator responses.
    PermissionGrant.findOne.mockResolvedValue(null);
    const otherErr = new Error('connection terminated unexpectedly');
    otherErr.name = 'SequelizeDatabaseError';
    PermissionGrant.create.mockRejectedValue(otherErr);

    const req = {
      user: { id: 'admin-1', name: 'Admin', isSuperAdmin: true, tier: 1 },
      body: { userId: 'target-user', resourceType: 'labels', action: 'create', effect: 'grant' },
    };
    const res = mockRes();
    await ctrl.grantPermission(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('existing row found on initial check — controller updates in place (no race)', async () => {
    // The pre-Phase-A idempotent path. Phase A keeps this fast path and
    // only falls back to the catch block when the race actually fires.
    const update = jest.fn().mockResolvedValue();
    const existing = { id: 'existing-grant', reason: 'old', scope: 'global', update };
    PermissionGrant.findOne.mockResolvedValue(existing);

    const req = {
      user: { id: 'admin-1', name: 'Admin', isSuperAdmin: true, tier: 1 },
      body: {
        userId: 'target-user', resourceType: 'labels', action: 'create',
        effect: 'grant', reason: 'new',
      },
    };
    const res = mockRes();
    await ctrl.grantPermission(req, res);

    expect(PermissionGrant.create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.updated).toBe(true);
  });
});
