'use strict';

/**
 * Phase 5c — Last Tier-1 protection in userController.
 *
 * Verifies that the three destructive paths (updateUser demotion,
 * toggleUserStatus deactivation, deleteUser) refuse to leave the system
 * with zero active Tier 1 users.
 *
 * Same mock pattern as userController.cp1.test.js: stubbed User model,
 * stubbed activity service, stubbed validator. No DB.
 */

jest.mock('express-validator', () => ({
  validationResult: jest.fn(() => ({ isEmpty: () => true, array: () => [] })),
}));

jest.mock('../../models', () => ({
  User: {
    findByPk: jest.fn(),
    findAll:  jest.fn(),
    findOne:  jest.fn(),
    update:   jest.fn(),
    count:    jest.fn(),
  },
  ManagerRelation: {
    findAll: jest.fn(),
    findOne: jest.fn(),
    count:   jest.fn(),
  },
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

const { User, ManagerRelation } = require('../../models');
const userController = require('../../controllers/userController');

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
  };
}

function makeT1Target(overrides = {}) {
  return {
    id: 't1-target',
    name: 'Last Super',
    email: 'super@aniston.com',
    role: 'admin',
    tier: 1,
    isSuperAdmin: true,
    isActive: true,
    hierarchyLevel: 'ceo',
    managerId: null,
    update:  jest.fn().mockResolvedValue(),
    destroy: jest.fn().mockResolvedValue(),
    toJSON() { return { ...this, update: undefined, destroy: undefined }; },
    ...overrides,
  };
}

function makeT2Target(overrides = {}) {
  return {
    id: 't2-target',
    name: 'Regular Admin',
    email: 'admin@aniston.com',
    role: 'admin',
    tier: 2,
    isSuperAdmin: false,
    isActive: true,
    managerId: null,
    update:  jest.fn().mockResolvedValue(),
    destroy: jest.fn().mockResolvedValue(),
    toJSON() { return { ...this, update: undefined, destroy: undefined }; },
    ...overrides,
  };
}

const t1Actor = { id: 'actor-t1', name: 'Tier 1 Actor', role: 'admin', isSuperAdmin: true, tier: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  ManagerRelation.findAll.mockResolvedValue([]);
  ManagerRelation.count.mockResolvedValue(0);
  User.findAll.mockResolvedValue([]);
  User.findOne.mockResolvedValue(null);
  User.count.mockResolvedValue(0); // default: zero OTHER active T1 users
});

// ── updateUser — demotion path ──────────────────────────────────────────

describe('updateUser — last Tier 1 demotion guard', () => {
  it('refuses to demote the only Tier 1 (clearing isSuperAdmin)', async () => {
    const target = makeT1Target();
    User.findByPk.mockResolvedValue(target);
    User.count.mockResolvedValue(0); // zero other active T1s

    const req = {
      params: { id: target.id },
      user: t1Actor,
      body: { isSuperAdmin: false },
    };
    const res = buildRes();

    await userController.updateUser(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'LAST_TIER_1',
        message: expect.stringMatching(/only Tier 1/),
      })
    );
    expect(target.update).not.toHaveBeenCalled();
  });

  it('refuses to demote the only Tier 1 via combined role=member + isSuperAdmin=false', async () => {
    // Both legacy fields drop, so tierFromLegacy('member', false) = 4.
    // The body request is fully demotive — guard must fire. (`tier` itself
    // isn't yet in any user-edit whitelist; the demotion path is exercised
    // through the legacy fields.)
    const target = makeT1Target();
    User.findByPk.mockResolvedValue(target);
    User.count.mockResolvedValue(0);

    const req = {
      params: { id: target.id },
      user: t1Actor,
      body: { role: 'member', isSuperAdmin: false },
    };
    const res = buildRes();

    await userController.updateUser(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'LAST_TIER_1' })
    );
    expect(target.update).not.toHaveBeenCalled();
  });

  it('allows demoting a Tier 1 when another active Tier 1 exists', async () => {
    const target = makeT1Target();
    User.findByPk.mockResolvedValue(target);
    User.count.mockResolvedValue(1); // a successor T1 exists

    const req = {
      params: { id: target.id },
      user: t1Actor,
      body: { isSuperAdmin: false },
    };
    const res = buildRes();

    await userController.updateUser(req, res);

    expect(target.update).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('does NOT consult the last-Tier-1 guard when target is not Tier 1', async () => {
    const target = makeT2Target();
    User.findByPk.mockResolvedValue(target);

    const req = {
      params: { id: target.id },
      user: t1Actor,
      body: { role: 'member' },
    };
    const res = buildRes();

    await userController.updateUser(req, res);

    // Update proceeds; User.count never queried for the last-T1 check.
    expect(target.update).toHaveBeenCalledTimes(1);
    expect(User.count).not.toHaveBeenCalled();
  });

  it('does NOT consult the guard when target IS Tier 1 but updates do not demote', async () => {
    const target = makeT1Target();
    User.findByPk.mockResolvedValue(target);

    const req = {
      params: { id: target.id },
      user: t1Actor,
      // Cosmetic-only change — keeps isSuperAdmin=true and role=admin → tier stays 1.
      body: { name: 'Renamed Super' },
    };
    const res = buildRes();

    await userController.updateUser(req, res);

    expect(User.count).not.toHaveBeenCalled();
    expect(target.update).toHaveBeenCalledTimes(1);
  });

  it('treats setting role=member while keeping isSuperAdmin=true as NOT a demotion', async () => {
    // tierFromLegacy(role='member', isSuperAdmin=true) → 1 (super admin wins).
    const target = makeT1Target();
    User.findByPk.mockResolvedValue(target);

    const req = {
      params: { id: target.id },
      user: t1Actor,
      body: { role: 'member' }, // isSuperAdmin still true ⇒ stays Tier 1
    };
    const res = buildRes();

    await userController.updateUser(req, res);

    expect(User.count).not.toHaveBeenCalled();
    expect(target.update).toHaveBeenCalledTimes(1);
  });
});

// ── toggleUserStatus — deactivation path ────────────────────────────────

describe('toggleUserStatus — last Tier 1 deactivation guard', () => {
  it('refuses to deactivate the only Tier 1', async () => {
    const target = makeT1Target({ isActive: true });
    User.findByPk.mockResolvedValue(target);
    User.count.mockResolvedValue(0);

    const req = { params: { id: target.id }, user: t1Actor };
    const res = buildRes();

    await userController.toggleUserStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'LAST_TIER_1' })
    );
    expect(target.update).not.toHaveBeenCalled();
  });

  it('allows deactivating a Tier 1 when a successor exists', async () => {
    const target = makeT1Target({ isActive: true });
    User.findByPk.mockResolvedValue(target);
    User.count.mockResolvedValue(1);

    const req = { params: { id: target.id }, user: t1Actor };
    const res = buildRes();

    await userController.toggleUserStatus(req, res);

    expect(target.update).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false, localStatusOverride: true })
    );
  });

  it('does NOT trigger guard when activating (was inactive → active)', async () => {
    const target = makeT1Target({ isActive: false });
    User.findByPk.mockResolvedValue(target);

    const req = { params: { id: target.id }, user: t1Actor };
    const res = buildRes();

    await userController.toggleUserStatus(req, res);

    // No last-T1 query, update proceeds with isActive=true.
    expect(User.count).not.toHaveBeenCalled();
    expect(target.update).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true })
    );
  });

  it('does NOT trigger guard when target is not Tier 1', async () => {
    const target = makeT2Target({ isActive: true });
    User.findByPk.mockResolvedValue(target);

    const req = { params: { id: target.id }, user: t1Actor };
    const res = buildRes();

    await userController.toggleUserStatus(req, res);

    expect(target.update).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false })
    );
    // assertNotLastTier1Change is a no-op for non-T1 targets, so User.count
    // is never queried.
    expect(User.count).not.toHaveBeenCalled();
  });
});

// ── deleteUser — defense-in-depth path ──────────────────────────────────

describe('deleteUser — last Tier 1 protection wired (defense in depth)', () => {
  it('non-Tier-1 target deletion proceeds (no last-T1 query)', async () => {
    const target = makeT2Target();
    User.findByPk.mockResolvedValue(target);

    const req = { params: { id: target.id }, user: t1Actor };
    const res = buildRes();

    await userController.deleteUser(req, res);

    expect(target.destroy).toHaveBeenCalledTimes(1);
    expect(User.count).not.toHaveBeenCalled();
  });

  it('Tier-1 target hits the existing "cannot delete super admin" block FIRST', async () => {
    // The pre-existing absolute "super admin accounts cannot be deleted via
    // this endpoint" guard intercepts before the last-T1 check fires. The
    // last-T1 guard is defense in depth for any future loosening of that
    // rule — we simply verify the existing rule still wins here.
    const target = makeT1Target();
    User.findByPk.mockResolvedValue(target);

    const req = { params: { id: target.id }, user: t1Actor };
    const res = buildRes();

    await userController.deleteUser(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/Super admin accounts cannot be deleted/i),
      })
    );
    expect(target.destroy).not.toHaveBeenCalled();
  });
});
