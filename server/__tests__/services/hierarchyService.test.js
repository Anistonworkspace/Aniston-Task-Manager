'use strict';

/**
 * Tests for server/services/hierarchyService.js — CP-1 (org-chart hardening).
 *
 * Covers:
 *   - canManageUser scope resolution per actor role
 *   - canEditHierarchy denial for cross-branch edits + cycles
 *   - removePrimaryManager wipes both User.managerId AND manager_relations
 *   - setPrimaryManager updates both atomically
 *   - wouldCreateCycle climbs both data sources
 *
 * Models and the Sequelize transaction API are mocked so no real database is
 * touched.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../../models', () => ({
  User: {
    findAll: jest.fn(),
    findByPk: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
  ManagerRelation: {
    findAll: jest.fn(),
    findOne: jest.fn(),
    findOrCreate: jest.fn(),
    update: jest.fn(),
    destroy: jest.fn(),
    count: jest.fn(),
  },
}));

const fakeTransaction = {
  LOCK: { UPDATE: 'UPDATE' },
  commit: jest.fn().mockResolvedValue(),
  rollback: jest.fn().mockResolvedValue(),
};

jest.mock('../../config/db', () => ({
  sequelize: {
    transaction: jest.fn(),
  },
}));

const { User, ManagerRelation } = require('../../models');
const { sequelize } = require('../../config/db');
const hierarchy = require('../../services/hierarchyService');

// ─── Helpers ────────────────────────────────────────────────────────────────

function user(overrides = {}) {
  return {
    id: 'u-default',
    name: 'Default',
    email: 'default@aniston.com',
    role: 'member',
    isActive: true,
    isSuperAdmin: false,
    managerId: null,
    update: jest.fn().mockResolvedValue(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockResolvedValue(fakeTransaction);
  // Default: no junction-table rows (table empty, not missing).
  ManagerRelation.findAll.mockResolvedValue([]);
  ManagerRelation.findOne.mockResolvedValue(null);
  ManagerRelation.update.mockResolvedValue([0]);
  ManagerRelation.destroy.mockResolvedValue(0);
  ManagerRelation.findOrCreate.mockResolvedValue([{ isPrimary: true, update: jest.fn() }, true]);
  ManagerRelation.count.mockResolvedValue(0);
  User.count.mockResolvedValue(0);
  User.findAll.mockResolvedValue([]);
});

// ─── canManageUser ───────────────────────────────────────────────────────────

describe('canManageUser', () => {
  it('grants full scope when actor is super admin (even on admins)', async () => {
    const actor = user({ id: 'sa-1', role: 'admin', isSuperAdmin: true });
    const target = user({ id: 'u-2', role: 'admin' });
    const result = await hierarchy.canManageUser(actor, target);
    expect(result).toEqual({ allowed: true, scope: 'full' });
  });

  it('grants full scope when actor is admin and target is not super admin', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    const target = user({ id: 'u-2', role: 'manager' });
    const result = await hierarchy.canManageUser(actor, target);
    expect(result).toEqual({ allowed: true, scope: 'full' });
  });

  it('denies an admin attempting to modify a super admin', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    const target = user({ id: 'sa-1', role: 'admin', isSuperAdmin: true });
    const result = await hierarchy.canManageUser(actor, target);
    expect(result.allowed).toBe(false);
    expect(result.scope).toBe('denied');
    expect(result.reason).toMatch(/super admin/i);
  });

  it('denies a manager attempting to edit an unrelated member (not in subtree)', async () => {
    const actor = user({ id: 'm-1', role: 'manager' });
    const target = user({ id: 'u-99', role: 'member' });
    // Manager's subtree has nobody.
    User.findAll.mockResolvedValue([]);
    const result = await hierarchy.canManageUser(actor, target);
    expect(result.allowed).toBe(false);
    expect(result.scope).toBe('denied');
    expect(result.reason).toMatch(/own org branch/i);
  });

  it('denies a manager attempting to edit an admin even within nominal branch', async () => {
    const actor = user({ id: 'm-1', role: 'manager' });
    const target = user({ id: 'a-99', role: 'admin' });
    const result = await hierarchy.canManageUser(actor, target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/admin/i);
  });

  it('denies a manager attempting to edit a super admin', async () => {
    const actor = user({ id: 'm-1', role: 'manager' });
    const target = user({ id: 'sa-1', role: 'admin', isSuperAdmin: true });
    const result = await hierarchy.canManageUser(actor, target);
    expect(result.allowed).toBe(false);
  });

  it('grants branch_safe scope for a manager editing a member inside their subtree', async () => {
    const actor = user({ id: 'm-1', role: 'manager' });
    const target = user({ id: 'u-2', role: 'member' });
    // Direct report via legacy User.managerId.
    User.findAll.mockResolvedValueOnce([{ id: 'u-2' }]).mockResolvedValue([]);
    const result = await hierarchy.canManageUser(actor, target);
    expect(result).toEqual({ allowed: true, scope: 'branch_safe' });
  });

  it('grants self scope for a manager editing themselves', async () => {
    const actor = user({ id: 'm-1', role: 'manager' });
    const target = user({ id: 'm-1', role: 'manager' });
    const result = await hierarchy.canManageUser(actor, target);
    expect(result).toEqual({ allowed: true, scope: 'self' });
  });

  it('denies a member editing anyone but themselves', async () => {
    const actor = user({ id: 'mem-1', role: 'member' });
    const target = user({ id: 'mem-2', role: 'member' });
    const result = await hierarchy.canManageUser(actor, target);
    expect(result.allowed).toBe(false);
    expect(result.scope).toBe('denied');
  });

  it('grants self scope for a member editing themselves', async () => {
    const actor = user({ id: 'mem-1', role: 'member' });
    const result = await hierarchy.canManageUser(actor, actor);
    expect(result).toEqual({ allowed: true, scope: 'self' });
  });

  it('denies an assistant manager attempting to edit a manager peer', async () => {
    const actor = user({ id: 'am-1', role: 'assistant_manager' });
    const target = user({ id: 'm-1', role: 'manager' });
    const result = await hierarchy.canManageUser(actor, target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/manager/i);
  });
});

// ─── canEditHierarchy ────────────────────────────────────────────────────────

describe('canEditHierarchy', () => {
  it('forbids actor from editing their own primary manager', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    const result = await hierarchy.canEditHierarchy(actor, 'a-1', 'm-2');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/your own/i);
  });

  it('forbids assigning a user as their own manager', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    const result = await hierarchy.canEditHierarchy(actor, 'u-2', 'u-2');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/own manager/i);
  });

  it('rejects when the proposed manager would create a cycle', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    // employee = u-1; trying to set u-1's manager to u-2; u-2's primary chain
    // already points to u-1. Mock manager_relations primary lookup to return
    // u-1 as u-2's parent.
    User.findByPk.mockImplementation((id) => {
      if (id === 'u-1') return Promise.resolve(user({ id: 'u-1', role: 'member', managerId: null }));
      if (id === 'u-2') return Promise.resolve(user({ id: 'u-2', role: 'member', managerId: 'u-1' }));
      return Promise.resolve(null);
    });
    ManagerRelation.findOne.mockImplementation(({ where }) => {
      if (where.employeeId === 'u-2' && where.isPrimary) {
        return Promise.resolve({ managerId: 'u-1' });
      }
      return Promise.resolve(null);
    });
    const result = await hierarchy.canEditHierarchy(actor, 'u-1', 'u-2');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/circular|cycle/i);
  });

  it('forbids a manager from editing hierarchy on a user outside their subtree', async () => {
    const actor = user({ id: 'm-1', role: 'manager' });
    User.findByPk.mockResolvedValue(user({ id: 'u-99', role: 'member' }));
    User.findAll.mockResolvedValue([]); // empty subtree
    const result = await hierarchy.canEditHierarchy(actor, 'u-99', null);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/own org branch|inside your own/i);
  });

  it('forbids a manager from re-parenting an admin', async () => {
    const actor = user({ id: 'm-1', role: 'manager' });
    User.findByPk.mockResolvedValue(user({ id: 'a-99', role: 'admin' }));
    const result = await hierarchy.canEditHierarchy(actor, 'a-99', null);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/admin/i);
  });

  it('forbids a member from editing hierarchy', async () => {
    const actor = user({ id: 'mem-1', role: 'member' });
    User.findByPk.mockResolvedValue(user({ id: 'u-2', role: 'member' }));
    const result = await hierarchy.canEditHierarchy(actor, 'u-2', null);
    expect(result.allowed).toBe(false);
  });

  it('allows admin to remove primary manager (managerId=null) on a member', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    User.findByPk.mockResolvedValue(user({ id: 'u-2', role: 'member', managerId: 'm-7' }));
    const result = await hierarchy.canEditHierarchy(actor, 'u-2', null);
    expect(result.allowed).toBe(true);
  });
});

// ─── wouldCreateCycle ────────────────────────────────────────────────────────

describe('wouldCreateCycle', () => {
  it('reports cycle when proposed manager already reports up to the employee', async () => {
    // employee = E; proposed manager = M; M's primary is E (so E ↔ M would cycle).
    User.findByPk.mockImplementation((id) => {
      if (id === 'M') return Promise.resolve(user({ id: 'M', managerId: 'E' }));
      if (id === 'E') return Promise.resolve(user({ id: 'E', managerId: null }));
      return Promise.resolve(null);
    });
    ManagerRelation.findOne.mockImplementation(({ where }) => {
      if (where.employeeId === 'M' && where.isPrimary) return Promise.resolve({ managerId: 'E' });
      return Promise.resolve(null);
    });
    const result = await hierarchy.wouldCreateCycle('E', 'M');
    expect(result.wouldCycle).toBe(true);
  });

  it('reports cycle when employee equals proposed manager', async () => {
    const result = await hierarchy.wouldCreateCycle('U', 'U');
    expect(result.wouldCycle).toBe(true);
  });

  it('returns no cycle when no path connects employee back to itself', async () => {
    User.findByPk.mockImplementation((id) => {
      if (id === 'M') return Promise.resolve(user({ id: 'M', managerId: null }));
      return Promise.resolve(null);
    });
    const result = await hierarchy.wouldCreateCycle('E', 'M');
    expect(result.wouldCycle).toBe(false);
  });

  it('handles pre-existing cycle data without infinite-looping', async () => {
    // A → B → A in the legacy column.
    User.findByPk.mockImplementation((id) => {
      if (id === 'A') return Promise.resolve(user({ id: 'A', managerId: 'B' }));
      if (id === 'B') return Promise.resolve(user({ id: 'B', managerId: 'A' }));
      return Promise.resolve(null);
    });
    // Trying to set C's manager to A — A's chain loops, but C is not in it.
    User.findByPk.mockImplementation((id) => {
      if (id === 'A') return Promise.resolve(user({ id: 'A', managerId: 'B' }));
      if (id === 'B') return Promise.resolve(user({ id: 'B', managerId: 'A' }));
      if (id === 'C') return Promise.resolve(user({ id: 'C', managerId: null }));
      return Promise.resolve(null);
    });
    const result = await hierarchy.wouldCreateCycle('C', 'A');
    expect(result.wouldCycle).toBe(false);
  });
});

// ─── removePrimaryManager ────────────────────────────────────────────────────

describe('removePrimaryManager', () => {
  it('atomically clears User.managerId AND deletes primary manager_relations rows', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    const employee = user({
      id: 'e-1',
      role: 'member',
      managerId: 'm-7',
      update: jest.fn().mockResolvedValue(),
    });
    User.findByPk.mockResolvedValue(employee);
    ManagerRelation.destroy.mockResolvedValue(1);

    const result = await hierarchy.removePrimaryManager('e-1', actor);

    expect(employee.update).toHaveBeenCalledWith(
      { managerId: null },
      expect.objectContaining({ transaction: fakeTransaction }),
    );
    expect(ManagerRelation.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { employeeId: 'e-1', isPrimary: true },
      }),
    );
    expect(fakeTransaction.commit).toHaveBeenCalled();
    expect(fakeTransaction.rollback).not.toHaveBeenCalled();
    expect(result.previousManagerId).toBe('m-7');
    expect(result.removedRelationCount).toBe(1);
  });

  it('still cleans manager_relations even when User.managerId is already null (drift)', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    // Drift scenario: User.managerId=null but manager_relations still has primary row.
    const employee = user({
      id: 'e-1',
      role: 'member',
      managerId: null,
      update: jest.fn().mockResolvedValue(),
    });
    User.findByPk.mockResolvedValue(employee);
    ManagerRelation.destroy.mockResolvedValue(1);

    const result = await hierarchy.removePrimaryManager('e-1', actor);

    // Even though managerId was already null, junction row must be destroyed.
    expect(ManagerRelation.destroy).toHaveBeenCalled();
    expect(employee.update).not.toHaveBeenCalled(); // already null, no redundant write
    expect(result.removedRelationCount).toBe(1);
    expect(fakeTransaction.commit).toHaveBeenCalled();
  });

  it('rolls back on authorization failure (manager outside branch)', async () => {
    const actor = user({ id: 'm-1', role: 'manager' });
    User.findByPk.mockResolvedValueOnce(user({ id: 'e-99', role: 'member' }));
    User.findAll.mockResolvedValue([]); // empty subtree → not in branch

    await expect(hierarchy.removePrimaryManager('e-99', actor)).rejects.toThrow(/own org branch|inside your own/i);

    expect(fakeTransaction.rollback).toHaveBeenCalled();
    expect(fakeTransaction.commit).not.toHaveBeenCalled();
  });

  it('rolls back when employee not found', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    User.findByPk.mockResolvedValue(null);

    await expect(hierarchy.removePrimaryManager('missing', actor)).rejects.toThrow(/not found/i);

    expect(fakeTransaction.rollback).toHaveBeenCalled();
  });
});

// ─── setPrimaryManager ───────────────────────────────────────────────────────

describe('setPrimaryManager', () => {
  it('atomically updates User.managerId and upserts the primary manager_relations row', async () => {
    const actor = user({ id: 'sa-1', role: 'admin', isSuperAdmin: true });
    const employee = user({
      id: 'e-1',
      role: 'member',
      managerId: null,
      update: jest.fn().mockResolvedValue(),
    });
    User.findByPk.mockImplementation((id) => {
      if (id === 'e-1') return Promise.resolve(employee);
      if (id === 'm-2') return Promise.resolve(user({ id: 'm-2', role: 'manager', isActive: true }));
      return Promise.resolve(null);
    });
    const relUpdate = jest.fn().mockResolvedValue();
    ManagerRelation.findOrCreate.mockResolvedValue([
      { isPrimary: false, update: relUpdate },
      false, // already existed
    ]);
    ManagerRelation.update.mockResolvedValue([0]);

    const result = await hierarchy.setPrimaryManager('e-1', 'm-2', actor);

    expect(ManagerRelation.update).toHaveBeenCalledWith(
      { isPrimary: false },
      expect.objectContaining({ where: { employeeId: 'e-1', isPrimary: true } }),
    );
    expect(ManagerRelation.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { employeeId: 'e-1', managerId: 'm-2' },
      }),
    );
    expect(relUpdate).toHaveBeenCalledWith(
      { isPrimary: true, relationType: 'primary' },
      expect.any(Object),
    );
    expect(employee.update).toHaveBeenCalledWith(
      { managerId: 'm-2' },
      expect.objectContaining({ transaction: fakeTransaction }),
    );
    expect(fakeTransaction.commit).toHaveBeenCalled();
    expect(result.newManagerId).toBe('m-2');
  });

  it('rolls back when the proposed change would create a cycle', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    User.findByPk.mockImplementation((id) => {
      if (id === 'A') return Promise.resolve(user({ id: 'A', role: 'member', isActive: true, managerId: null }));
      if (id === 'B') return Promise.resolve(user({ id: 'B', role: 'member', isActive: true, managerId: 'A' }));
      return Promise.resolve(null);
    });
    ManagerRelation.findOne.mockImplementation(({ where }) => {
      if (where && where.employeeId === 'B' && where.isPrimary) return Promise.resolve({ managerId: 'A' });
      return Promise.resolve(null);
    });

    await expect(hierarchy.setPrimaryManager('A', 'B', actor)).rejects.toThrow(/circular|cycle/i);

    expect(fakeTransaction.rollback).toHaveBeenCalled();
  });

  it('rejects null managerId (use removePrimaryManager instead)', async () => {
    const actor = user({ id: 'a-1', role: 'admin' });
    await expect(hierarchy.setPrimaryManager('e-1', null, actor)).rejects.toThrow(/non-null|removePrimaryManager/i);
  });
});
