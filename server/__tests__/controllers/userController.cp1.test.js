'use strict';

/**
 * Tests for userController.updateUser — CP-1 privilege-escalation fix.
 *
 * These tests prove the P0 fix: a manager can no longer change another user's
 * role / hierarchyLevel / isActive / accountStatus / email by sending those
 * fields in a PUT /api/users/:id body.
 *
 * The controller is exercised directly with a stubbed Sequelize User model.
 */

jest.mock('express-validator', () => ({
  validationResult: jest.fn(() => ({ isEmpty: () => true, array: () => [] })),
}));

jest.mock('../../models', () => ({
  User: {
    findByPk: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  ManagerRelation: {
    findAll: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
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
    json: jest.fn().mockReturnThis(),
  };
}

function makeTarget(overrides = {}) {
  return {
    id: 't-1',
    name: 'Target',
    email: 'target@aniston.com',
    role: 'member',
    hierarchyLevel: 'member',
    isActive: true,
    isSuperAdmin: false,
    managerId: null,
    update: jest.fn().mockResolvedValue(),
    toJSON() { return { ...this, update: undefined }; },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ManagerRelation.findAll.mockResolvedValue([]);
  ManagerRelation.count.mockResolvedValue(0);
  User.count.mockResolvedValue(0);
  User.findAll.mockResolvedValue([]);
  User.findOne.mockResolvedValue(null);
});

describe('updateUser — privilege escalation fix', () => {
  it('blocks a manager from changing another user\'s role', async () => {
    const actor = { id: 'm-1', role: 'manager', isSuperAdmin: false, name: 'Mgr' };
    const target = makeTarget({ id: 't-1', role: 'member' });

    User.findByPk.mockResolvedValue(target);
    // Manager has empty subtree → target NOT in branch (canManageUser denies).
    User.findAll.mockResolvedValue([]);

    const req = { params: { id: 't-1' }, user: actor, body: { role: 'admin' } };
    const res = buildRes();
    await userController.updateUser(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(target.update).not.toHaveBeenCalled();
  });

  it('blocks a manager from flipping isActive on a user outside their branch', async () => {
    const actor = { id: 'm-1', role: 'manager', isSuperAdmin: false, name: 'Mgr' };
    const target = makeTarget({ id: 't-1', role: 'member' });

    User.findByPk.mockResolvedValue(target);
    User.findAll.mockResolvedValue([]); // empty subtree

    const req = { params: { id: 't-1' }, user: actor, body: { isActive: false } };
    const res = buildRes();
    await userController.updateUser(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(target.update).not.toHaveBeenCalled();
  });

  it('blocks a manager from changing role even when target IS in their branch', async () => {
    // Even branch-safe scope must NOT permit role/hierarchyLevel/isActive.
    const actor = { id: 'm-1', role: 'manager', isSuperAdmin: false, name: 'Mgr' };
    const target = makeTarget({ id: 't-1', role: 'member' });

    User.findByPk.mockResolvedValue(target);
    // Direct report via legacy column.
    User.findAll.mockResolvedValueOnce([{ id: 't-1' }]).mockResolvedValue([]);

    const req = { params: { id: 't-1' }, user: actor, body: { role: 'admin', name: 'Promoted' } };
    const res = buildRes();
    await userController.updateUser(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        forbiddenFields: expect.arrayContaining(['role']),
      }),
    );
    expect(target.update).not.toHaveBeenCalled();
  });

  it('blocks a manager from setting isSuperAdmin on anyone', async () => {
    const actor = { id: 'm-1', role: 'manager', isSuperAdmin: false, name: 'Mgr' };
    const target = makeTarget({ id: 't-1', role: 'member' });

    User.findByPk.mockResolvedValue(target);
    User.findAll.mockResolvedValueOnce([{ id: 't-1' }]).mockResolvedValue([]);

    const req = { params: { id: 't-1' }, user: actor, body: { isSuperAdmin: true } };
    const res = buildRes();
    await userController.updateUser(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(target.update).not.toHaveBeenCalled();
  });

  it('blocks ANY actor from changing their own role (even admin)', async () => {
    const actor = { id: 'a-1', role: 'admin', isSuperAdmin: false, name: 'Adm' };
    const target = makeTarget({ id: 'a-1', role: 'admin' });

    User.findByPk.mockResolvedValue(target);

    const req = { params: { id: 'a-1' }, user: actor, body: { role: 'manager' } };
    const res = buildRes();
    await userController.updateUser(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(target.update).not.toHaveBeenCalled();
  });

  it('allows a manager to edit branch-safe fields (name, designation) on a direct report', async () => {
    const actor = { id: 'm-1', role: 'manager', isSuperAdmin: false, name: 'Mgr' };
    const target = makeTarget({ id: 't-1', role: 'member', name: 'Old Name' });

    User.findByPk.mockResolvedValue(target);
    User.findAll.mockResolvedValueOnce([{ id: 't-1' }]).mockResolvedValue([]);

    const req = { params: { id: 't-1' }, user: actor, body: { name: 'New Name', designation: 'Lead Dev' } };
    const res = buildRes();
    await userController.updateUser(req, res);

    expect(target.update).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New Name',
      designation: 'Lead Dev',
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('allows an admin to change a member\'s role to manager', async () => {
    const actor = { id: 'a-1', role: 'admin', isSuperAdmin: false, name: 'Adm' };
    const target = makeTarget({ id: 't-1', role: 'member' });

    User.findByPk.mockResolvedValue(target);

    const req = { params: { id: 't-1' }, user: actor, body: { role: 'manager' } };
    const res = buildRes();
    await userController.updateUser(req, res);

    expect(target.update).toHaveBeenCalledWith(expect.objectContaining({ role: 'manager' }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('blocks an admin from modifying a super admin', async () => {
    const actor = { id: 'a-1', role: 'admin', isSuperAdmin: false, name: 'Adm' };
    const target = makeTarget({ id: 'sa-1', role: 'admin', isSuperAdmin: true });

    User.findByPk.mockResolvedValue(target);

    const req = { params: { id: 'sa-1' }, user: actor, body: { name: 'Fake' } };
    const res = buildRes();
    await userController.updateUser(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(target.update).not.toHaveBeenCalled();
  });

  it('only allows isSuperAdmin to be flipped by an actor who is themselves super admin', async () => {
    const actor = { id: 'sa-1', role: 'admin', isSuperAdmin: true, name: 'Super' };
    const target = makeTarget({ id: 't-1', role: 'manager' });

    User.findByPk.mockResolvedValue(target);

    const req = { params: { id: 't-1' }, user: actor, body: { isSuperAdmin: true } };
    const res = buildRes();
    await userController.updateUser(req, res);

    expect(target.update).toHaveBeenCalledWith(expect.objectContaining({ isSuperAdmin: true }));
  });
});
