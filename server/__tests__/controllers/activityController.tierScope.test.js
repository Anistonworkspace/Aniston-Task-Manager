'use strict';

/**
 * Tests for the Phase 6 activityController tier-scoping fix.
 *
 * Previously the controller had two bugs:
 *   (a) Tier 3 had NO scoping branch — saw all activity in the system.
 *   (b) Tier 4 scope was tasks.assignedTo only, ignoring task_assignees
 *       and task_owners junctions.
 *
 * The fix routes all non-T1/T2 viewers through
 * `taskVisibilityService.buildTaskVisibilityWhere`, which unions all
 * three assignment sources across the user's hierarchy subtree.
 *
 * The tests mock Task, Activity, and taskVisibilityService so we can
 * observe what predicate the controller builds without touching a DB.
 */

const mockTaskFindAll = jest.fn();
const mockActivityFindAndCountAll = jest.fn();
const mockBuildTaskVisibilityWhere = jest.fn();
const mockCanViewTask = jest.fn();

jest.mock('../../models', () => ({
  Activity: {
    findAndCountAll: (...a) => mockActivityFindAndCountAll(...a),
  },
  Task: {
    findAll: (...a) => mockTaskFindAll(...a),
  },
  User: {},
}));

jest.mock('../../services/taskVisibilityService', () => ({
  buildTaskVisibilityWhere: (...a) => mockBuildTaskVisibilityWhere(...a),
  canViewTask: (...a) => mockCanViewTask(...a),
}));

const { getActivities } = require('../../controllers/activityController');

function buildReqRes(user, query = {}) {
  const req = { user, query };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return { req, res };
}

beforeEach(() => {
  mockTaskFindAll.mockReset();
  mockActivityFindAndCountAll.mockReset();
  mockBuildTaskVisibilityWhere.mockReset();
  mockCanViewTask.mockReset();
  mockActivityFindAndCountAll.mockResolvedValue({ rows: [], count: 0 });
});

const t1Super = { id: 'u-super', tier: 1, isSuperAdmin: true, role: 'admin' };
const t2Admin = { id: 'u-adm', tier: 2, role: 'admin' };
const t3Asst  = { id: 'u-asst', tier: 3, role: 'assistant_manager' };
const t4Member = { id: 'u-mem', tier: 4, role: 'member' };

describe('activityController.getActivities — tier scoping', () => {
  it('Tier 1 is unrestricted (no visibility filter, no task lookup)', async () => {
    const { req, res } = buildReqRes(t1Super);
    await getActivities(req, res);
    expect(mockBuildTaskVisibilityWhere).not.toHaveBeenCalled();
    expect(mockTaskFindAll).not.toHaveBeenCalled();
    expect(mockActivityFindAndCountAll).toHaveBeenCalledTimes(1);
    // No taskId constraint should be added for Tier 1.
    const where = mockActivityFindAndCountAll.mock.calls[0][0].where;
    expect(where.taskId).toBeUndefined();
  });

  it('Tier 2 is unrestricted (manager parity with admin)', async () => {
    const { req, res } = buildReqRes(t2Admin);
    await getActivities(req, res);
    expect(mockBuildTaskVisibilityWhere).not.toHaveBeenCalled();
    expect(mockTaskFindAll).not.toHaveBeenCalled();
  });

  it('Tier 3 IS now scoped — Phase 6 fix (previously unrestricted)', async () => {
    mockBuildTaskVisibilityWhere.mockResolvedValue({});
    mockTaskFindAll.mockResolvedValue([{ id: 't-1' }, { id: 't-2' }]);
    const { req, res } = buildReqRes(t3Asst);
    await getActivities(req, res);
    expect(mockBuildTaskVisibilityWhere).toHaveBeenCalledWith(t3Asst);
    expect(mockTaskFindAll).toHaveBeenCalledTimes(1);
    const where = mockActivityFindAndCountAll.mock.calls[0][0].where;
    expect(where.taskId).toBeDefined();
  });

  it('Tier 4 uses buildTaskVisibilityWhere (not the old assignedTo-only path)', async () => {
    mockBuildTaskVisibilityWhere.mockResolvedValue({});
    mockTaskFindAll.mockResolvedValue([{ id: 't-99' }]);
    const { req, res } = buildReqRes(t4Member);
    await getActivities(req, res);
    expect(mockBuildTaskVisibilityWhere).toHaveBeenCalledWith(t4Member);
    // The old code did Task.findAll({ where: { assignedTo: req.user.id } }).
    // The new code calls Task.findAll with the visibility predicate (no
    // assignedTo constraint baked in here — the predicate carries it).
    const findAllArgs = mockTaskFindAll.mock.calls[0][0];
    expect(findAllArgs.attributes).toEqual(['id']);
    expect(findAllArgs.where.assignedTo).toBeUndefined();
  });

  it('Tier 4 with zero visible tasks emits a no-match sentinel (no empty IN)', async () => {
    mockBuildTaskVisibilityWhere.mockResolvedValue({});
    mockTaskFindAll.mockResolvedValue([]);
    const { req, res } = buildReqRes(t4Member);
    await getActivities(req, res);
    const where = mockActivityFindAndCountAll.mock.calls[0][0].where;
    // The constraint should be a sentinel that matches no rows, not
    // an empty IN which Postgres treats as "anything".
    expect(where.taskId).toBeDefined();
    const inArr = where.taskId[Object.getOwnPropertySymbols(where.taskId)[0]];
    expect(Array.isArray(inArr)).toBe(true);
    expect(inArr).toEqual([null]); // matches no UUID
  });

  it('Tier 4 querying a specific taskId they cannot see returns empty', async () => {
    mockCanViewTask.mockResolvedValue(false);
    const { req, res } = buildReqRes(t4Member, { taskId: 'forbidden-task' });
    await getActivities(req, res);
    expect(mockCanViewTask).toHaveBeenCalledWith(t4Member, 'forbidden-task');
    expect(mockActivityFindAndCountAll).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { activities: [], total: 0 },
    });
  });

  it('Tier 4 querying a visible specific taskId proceeds to the normal query', async () => {
    mockCanViewTask.mockResolvedValue(true);
    const { req, res } = buildReqRes(t4Member, { taskId: 'my-task' });
    await getActivities(req, res);
    expect(mockCanViewTask).toHaveBeenCalledWith(t4Member, 'my-task');
    expect(mockActivityFindAndCountAll).toHaveBeenCalledTimes(1);
    const where = mockActivityFindAndCountAll.mock.calls[0][0].where;
    expect(where.taskId).toBe('my-task');
  });
});
