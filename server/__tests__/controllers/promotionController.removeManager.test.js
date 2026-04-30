'use strict';

/**
 * Tests for promotionController.updateManager — CP-1 make-root flow.
 *
 * Verifies that:
 *   - Sending { managerId: null } removes the primary manager via the canonical
 *     hierarchyService.removePrimaryManager (which is transactional).
 *   - Empty-string managerId is treated as null (frontend convenience).
 *   - Branch-scoped authorization rejects unauthorized actors with the
 *     reason surfaced to the API client.
 */

jest.mock('../../models', () => ({
  PromotionHistory: {},
  User: { findByPk: jest.fn() },
  Notification: {},
  HierarchyLevel: {},
  ManagerRelation: {},
}));

jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/socketService', () => ({ emitToUser: jest.fn() }));
jest.mock('../../services/hierarchyService', () => ({
  removePrimaryManager: jest.fn(),
  setPrimaryManager: jest.fn(),
}));

const { User } = require('../../models');
const hierarchy = require('../../services/hierarchyService');
const activityService = require('../../services/activityService');
const promotionController = require('../../controllers/promotionController');

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('updateManager — make root', () => {
  it('routes managerId=null to removePrimaryManager and writes audit log', async () => {
    User.findByPk.mockResolvedValue({ id: 'e-1', name: 'Sunny' });
    hierarchy.removePrimaryManager.mockResolvedValue({
      employee: { id: 'e-1', managerId: null },
      previousManagerId: 'shubhanshu-id',
      removedRelationCount: 1,
    });

    const req = {
      body: { userId: 'e-1', managerId: null },
      user: { id: 'admin-1', role: 'admin', name: 'Adm' },
    };
    const res = buildRes();

    await promotionController.updateManager(req, res);

    expect(hierarchy.removePrimaryManager).toHaveBeenCalledWith('e-1', req.user);
    expect(hierarchy.setPrimaryManager).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(activityService.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'manager_removed',
        meta: expect.objectContaining({
          previousManagerId: 'shubhanshu-id',
          removedRelationCount: 1,
        }),
      }),
    );
  });

  it('treats empty-string managerId as null (frontend convenience)', async () => {
    User.findByPk.mockResolvedValue({ id: 'e-1', name: 'Sunny' });
    hierarchy.removePrimaryManager.mockResolvedValue({
      employee: { id: 'e-1', managerId: null },
      previousManagerId: 'shubhanshu-id',
      removedRelationCount: 1,
    });

    const req = {
      body: { userId: 'e-1', managerId: '' },
      user: { id: 'admin-1', role: 'admin', name: 'Adm' },
    };
    const res = buildRes();

    await promotionController.updateManager(req, res);

    expect(hierarchy.removePrimaryManager).toHaveBeenCalledWith('e-1', req.user);
  });

  it('routes a non-null managerId to setPrimaryManager', async () => {
    User.findByPk.mockResolvedValue({ id: 'e-1', name: 'Sunny' });
    hierarchy.setPrimaryManager.mockResolvedValue({
      employee: { id: 'e-1', managerId: 'm-2' },
      previousManagerId: null,
      newManagerId: 'm-2',
    });

    const req = {
      body: { userId: 'e-1', managerId: 'm-2' },
      user: { id: 'admin-1', role: 'admin', name: 'Adm' },
    };
    const res = buildRes();

    await promotionController.updateManager(req, res);

    expect(hierarchy.setPrimaryManager).toHaveBeenCalledWith('e-1', 'm-2', req.user);
    expect(hierarchy.removePrimaryManager).not.toHaveBeenCalled();
  });

  it('surfaces hierarchy-service auth errors as 403 with the reason', async () => {
    User.findByPk.mockResolvedValue({ id: 'e-1', name: 'Sunny' });
    const denied = new Error('Managers can only manage users inside their own org branch.');
    denied.statusCode = 403;
    hierarchy.removePrimaryManager.mockRejectedValue(denied);

    const req = {
      body: { userId: 'e-1', managerId: null },
      user: { id: 'm-1', role: 'manager', name: 'Mgr' },
    };
    const res = buildRes();

    await promotionController.updateManager(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringMatching(/own org branch/i),
      }),
    );
  });

  it('returns 400 when userId is missing', async () => {
    const req = {
      body: { managerId: null },
      user: { id: 'admin-1', role: 'admin', name: 'Adm' },
    };
    const res = buildRes();

    await promotionController.updateManager(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(hierarchy.removePrimaryManager).not.toHaveBeenCalled();
    expect(hierarchy.setPrimaryManager).not.toHaveBeenCalled();
  });

  it('returns 404 when the employee does not exist', async () => {
    User.findByPk.mockResolvedValue(null);

    const req = {
      body: { userId: 'missing', managerId: null },
      user: { id: 'admin-1', role: 'admin', name: 'Adm' },
    };
    const res = buildRes();

    await promotionController.updateManager(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
