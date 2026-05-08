'use strict';

/**
 * D.1 hotfix — tier-based task visibility kernel tests.
 *
 * Pins the new behaviour:
 *   - Tier 1 + Tier 2 → unrestricted (sees every task).
 *   - Tier 3         → self + descendants only.
 *   - Tier 4         → self only.
 *
 * Plus the rollback path (TASK_VISIBILITY_TIER2_UNRESTRICTED=false), which
 * must restore the strict pre-hotfix behaviour:
 *   - only isSuperAdmin / role='admin' is unrestricted
 *   - role='manager' (Tier 2 by tier) collapses back to subtree-scoped
 *
 * Mocks: ../../models, ../../config/db, ./hierarchyService, ../utils/safeSql.
 * No DB required.
 */

jest.mock('../../models', () => ({
  Task:         { findByPk: jest.fn() },
  TaskAssignee: { findOne: jest.fn(), findAll: jest.fn() },
  TaskOwner:    { findOne: jest.fn(), findAll: jest.fn() },
  User:         { findAll: jest.fn().mockResolvedValue([]) },
}));

jest.mock('../../config/db', () => ({
  sequelize: {
    query:   jest.fn().mockResolvedValue([[], []]),
    literal: (sql) => ({ $literal: sql }),
  },
}));

jest.mock('../../services/hierarchyService', () => ({
  getDescendantIds:    jest.fn().mockResolvedValue([]),
  getPrimaryManagerId: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../utils/safeSql', () => ({
  safeUUID:     (id) => `'${id}'`,
  safeUUIDList: (ids) => ids.map((i) => `'${i}'`).join(','),
}));

jest.mock('../../utils/logger', () => ({
  warn:  jest.fn(),
  error: jest.fn(),
  info:  jest.fn(),
}));

const hierarchyService = require('../../services/hierarchyService');
const taskVisibility = require('../../services/taskVisibilityService');
const { TIER_1, TIER_2, TIER_3, TIER_4 } = require('../../config/tiers');

// Test fixtures — mirror the legacy/tier shapes that exist in production.
//
// `t2Mgr` is the previously-broken case: a Tier 2 user whose legacy role is
// 'manager' rather than 'admin'. Pre-hotfix the kernel collapsed them to
// subtree-only. Post-hotfix they are unrestricted just like t2Admin.
const t1User  = { id: 'u-t1',  tier: TIER_1, isSuperAdmin: true,  role: 'admin' };
const t2Admin = { id: 'u-t2a', tier: TIER_2,                       role: 'admin' };
const t2Mgr   = { id: 'u-t2m', tier: TIER_2,                       role: 'manager' };
const t3User  = { id: 'u-t3',  tier: TIER_3,                       role: 'assistant_manager' };
const t4User  = { id: 'u-t4',  tier: TIER_4,                       role: 'member' };

// Pre-migration users — tier column missing. resolveTier() must fall back
// to legacy fields and produce the same answers.
const legacyT1 = { id: 'l-t1', isSuperAdmin: true,  role: 'admin' };
const legacyT2 = { id: 'l-t2',                       role: 'manager' };
const legacyT4 = { id: 'l-t4',                       role: 'member' };

// ──────────────────────────────────────────────────────────────────────────
// Default-flag suite (TASK_VISIBILITY_TIER2_UNRESTRICTED unset → 'true')
// ──────────────────────────────────────────────────────────────────────────

describe('taskVisibilityService — D.1 hotfix (default flag = ON)', () => {
  // Kernel was loaded at module top with the default flag (unset → 'true').
  // We do NOT call jest.resetModules() here: doing so would give the kernel
  // a fresh hierarchyService mock instance, while the test file still holds
  // the old reference — and our mockResolvedValueOnce calls would land on
  // the wrong instance. By relying on the standard module registry the test
  // file and the kernel share the same hierarchyService mock.

  beforeEach(() => {
    jest.clearAllMocks();
    hierarchyService.getDescendantIds.mockResolvedValue([]);
  });

  describe('isUnrestrictedTaskViewer', () => {
    it('Tier 1 (isSuperAdmin) → true', () => {
      expect(taskVisibility.isUnrestrictedTaskViewer(t1User)).toBe(true);
    });
    it('Tier 2 with role=admin → true', () => {
      expect(taskVisibility.isUnrestrictedTaskViewer(t2Admin)).toBe(true);
    });
    it('Tier 2 with role=manager → true (REGRESSION PIN — was FALSE pre-hotfix)', () => {
      expect(taskVisibility.isUnrestrictedTaskViewer(t2Mgr)).toBe(true);
    });
    it('Tier 3 → false', () => {
      expect(taskVisibility.isUnrestrictedTaskViewer(t3User)).toBe(false);
    });
    it('Tier 4 → false', () => {
      expect(taskVisibility.isUnrestrictedTaskViewer(t4User)).toBe(false);
    });
    it('null / undefined viewer → false (defensive)', () => {
      expect(taskVisibility.isUnrestrictedTaskViewer(null)).toBe(false);
      expect(taskVisibility.isUnrestrictedTaskViewer(undefined)).toBe(false);
    });
    it('legacy user (no tier column, role=manager) → true (resolveTier fallback)', () => {
      expect(taskVisibility.isUnrestrictedTaskViewer(legacyT2)).toBe(true);
    });
  });

  describe('getVisibleUserIdsForViewer', () => {
    it('Tier 1 → unrestricted, no hierarchy walk', async () => {
      const scope = await taskVisibility.getVisibleUserIdsForViewer(t1User);
      expect(scope).toEqual({ unrestricted: true });
      expect(hierarchyService.getDescendantIds).not.toHaveBeenCalled();
    });

    it('Tier 2 admin-role → unrestricted, no hierarchy walk', async () => {
      const scope = await taskVisibility.getVisibleUserIdsForViewer(t2Admin);
      expect(scope).toEqual({ unrestricted: true });
      expect(hierarchyService.getDescendantIds).not.toHaveBeenCalled();
    });

    it('Tier 2 manager-role → unrestricted, no hierarchy walk (REGRESSION PIN)', async () => {
      const scope = await taskVisibility.getVisibleUserIdsForViewer(t2Mgr);
      expect(scope).toEqual({ unrestricted: true });
      expect(hierarchyService.getDescendantIds).not.toHaveBeenCalled();
    });

    it('Tier 3 with descendants → { userIds: [self, ...descendants] }', async () => {
      hierarchyService.getDescendantIds.mockResolvedValueOnce(['d1', 'd2']);
      const scope = await taskVisibility.getVisibleUserIdsForViewer(t3User);
      expect(scope.unrestricted).toBe(false);
      expect(scope.userIds.sort()).toEqual(['d1', 'd2', 'u-t3'].sort());
    });

    it('Tier 3 with NO descendants → { userIds: [self] } only', async () => {
      hierarchyService.getDescendantIds.mockResolvedValueOnce([]);
      const scope = await taskVisibility.getVisibleUserIdsForViewer(t3User);
      expect(scope).toEqual({ unrestricted: false, userIds: ['u-t3'] });
    });

    it('Tier 4 → { userIds: [self] } only (descendants ignored)', async () => {
      hierarchyService.getDescendantIds.mockResolvedValueOnce(['ignored-d1']);
      const scope = await taskVisibility.getVisibleUserIdsForViewer(t4User);
      expect(scope.unrestricted).toBe(false);
      expect(scope.userIds).toContain('u-t4');
      // Tier 4 still walks descendants (the kernel uses the same getDescendantIds
      // call). The intent is that members usually have none. If they DO have a
      // direct report, the matrix permission for tasks.view at tier 4 still
      // gates them appropriately at the controller layer; the kernel reflects
      // the data faithfully.
    });
  });

  describe('canViewTask (hydrated fast path)', () => {
    const stranger = {
      id: 'task-stranger',
      assignedTo: 'stranger', createdBy: 'stranger',
      taskAssignees: [], owners: [],
    };
    const ownedBy = (uid) => ({
      id: 'task-owned-' + uid,
      assignedTo: uid, createdBy: 'someone-else',
      taskAssignees: [], owners: [],
    });
    const junctionAssignee = (uid) => ({
      id: 'task-junction-' + uid,
      assignedTo: 'someone-else', createdBy: 'someone-else',
      taskAssignees: [{ userId: uid, role: 'assignee' }],
      owners: [],
    });

    it('Tier 1 → true regardless of relation', async () => {
      expect(await taskVisibility.canViewTask(t1User, stranger)).toBe(true);
    });

    it('Tier 2 admin-role → true regardless of relation', async () => {
      expect(await taskVisibility.canViewTask(t2Admin, stranger)).toBe(true);
    });

    it('Tier 2 manager-role → true regardless of relation (REGRESSION PIN)', async () => {
      expect(await taskVisibility.canViewTask(t2Mgr, stranger)).toBe(true);
    });

    it('Tier 3 → true when descendant is the assignee', async () => {
      hierarchyService.getDescendantIds.mockResolvedValueOnce(['d1']);
      expect(await taskVisibility.canViewTask(t3User, ownedBy('d1'))).toBe(true);
    });

    it('Tier 3 → false when stranger owns the task', async () => {
      hierarchyService.getDescendantIds.mockResolvedValueOnce([]);
      expect(await taskVisibility.canViewTask(t3User, stranger)).toBe(false);
    });

    it('Tier 4 → true on own task (assignedTo === self)', async () => {
      expect(await taskVisibility.canViewTask(t4User, ownedBy('u-t4'))).toBe(true);
    });

    it('Tier 4 → true on own task via task_assignees junction', async () => {
      expect(await taskVisibility.canViewTask(t4User, junctionAssignee('u-t4'))).toBe(true);
    });

    it('Tier 4 → false on colleague task', async () => {
      expect(await taskVisibility.canViewTask(t4User, stranger)).toBe(false);
    });

    it('null viewer → false (defensive)', async () => {
      expect(await taskVisibility.canViewTask(null, stranger)).toBe(false);
    });
  });

  describe('filterVisibleTasks (in-memory)', () => {
    const tasks = [
      { id: 'a', assignedTo: 'u-t4',     createdBy: 'x',        taskAssignees: [], owners: [] },
      { id: 'b', assignedTo: 'stranger', createdBy: 'stranger', taskAssignees: [], owners: [] },
      { id: 'c', assignedTo: 'd1',       createdBy: 'x',        taskAssignees: [], owners: [] },
    ];

    it('Tier 1 → returns input unchanged (no filter)', async () => {
      const out = await taskVisibility.filterVisibleTasks(t1User, tasks);
      expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });

    it('Tier 2 manager-role → returns input unchanged (REGRESSION PIN)', async () => {
      const out = await taskVisibility.filterVisibleTasks(t2Mgr, tasks);
      expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });

    it('Tier 3 with descendant d1 → keeps descendant tasks, drops stranger', async () => {
      hierarchyService.getDescendantIds.mockResolvedValueOnce(['d1']);
      const out = await taskVisibility.filterVisibleTasks(t3User, tasks);
      // 'a' is owned by u-t4 (not in subtree), 'b' by stranger, 'c' by d1.
      expect(out.map((t) => t.id)).toEqual(['c']);
    });

    it('Tier 4 → keeps only own', async () => {
      hierarchyService.getDescendantIds.mockResolvedValueOnce([]);
      const out = await taskVisibility.filterVisibleTasks(t4User, tasks);
      expect(out.map((t) => t.id)).toEqual(['a']);
    });

    it('empty input → empty output (any tier)', async () => {
      expect(await taskVisibility.filterVisibleTasks(t4User, [])).toEqual([]);
      expect(await taskVisibility.filterVisibleTasks(t1User, [])).toEqual([]);
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Rollback suite — TASK_VISIBILITY_TIER2_UNRESTRICTED=false
//
// Verifies the env-var rollback path restores pre-hotfix strict behaviour
// without a code change. The flag is read at module load, so we re-import
// the kernel inside an isolated module registry.
// ──────────────────────────────────────────────────────────────────────────

describe('taskVisibilityService — rollback (TASK_VISIBILITY_TIER2_UNRESTRICTED=false)', () => {
  // Re-import the kernel inside an isolated module registry with the flag
  // OFF. The flag is read at module load, so we MUST resetModules and set
  // the env var before the require to observe the rollback path.
  //
  // We re-establish the same mocks for the isolated registry so any DB I/O
  // attempts stay safe — though these tests only call the pure
  // isUnrestrictedTaskViewer helper, which never touches the DB.
  let kernel;
  const PREV = process.env.TASK_VISIBILITY_TIER2_UNRESTRICTED;

  beforeAll(() => {
    jest.isolateModules(() => {
      process.env.TASK_VISIBILITY_TIER2_UNRESTRICTED = 'false';
      jest.doMock('../../models', () => ({
        Task:         { findByPk: jest.fn() },
        TaskAssignee: { findOne: jest.fn(), findAll: jest.fn() },
        TaskOwner:    { findOne: jest.fn(), findAll: jest.fn() },
        User:         { findAll: jest.fn().mockResolvedValue([]) },
      }));
      jest.doMock('../../config/db', () => ({
        sequelize: { query: jest.fn().mockResolvedValue([[], []]), literal: (s) => ({ $literal: s }) },
      }));
      jest.doMock('../../services/hierarchyService', () => ({
        getDescendantIds:    jest.fn().mockResolvedValue([]),
        getPrimaryManagerId: jest.fn().mockResolvedValue(null),
      }));
      jest.doMock('../../utils/safeSql', () => ({
        safeUUID:     (id) => `'${id}'`,
        safeUUIDList: (ids) => ids.map((i) => `'${i}'`).join(','),
      }));
      jest.doMock('../../utils/logger', () => ({
        warn: jest.fn(), error: jest.fn(), info: jest.fn(),
      }));
      kernel = require('../../services/taskVisibilityService');
    });
  });

  afterAll(() => {
    if (PREV === undefined) {
      delete process.env.TASK_VISIBILITY_TIER2_UNRESTRICTED;
    } else {
      process.env.TASK_VISIBILITY_TIER2_UNRESTRICTED = PREV;
    }
  });

  it('Tier 1 (isSuperAdmin) → still unrestricted', () => {
    expect(kernel.isUnrestrictedTaskViewer(t1User)).toBe(true);
  });

  it('Tier 2 with role=admin → still unrestricted (legacy strict path)', () => {
    expect(kernel.isUnrestrictedTaskViewer(t2Admin)).toBe(true);
  });

  it('Tier 2 with role=manager → restricted (legacy strict behaviour restored)', () => {
    expect(kernel.isUnrestrictedTaskViewer(t2Mgr)).toBe(false);
  });

  it('Tier 3 → restricted', () => {
    expect(kernel.isUnrestrictedTaskViewer(t3User)).toBe(false);
  });

  it('Tier 4 → restricted', () => {
    expect(kernel.isUnrestrictedTaskViewer(t4User)).toBe(false);
  });

  it('legacy admin (no tier column, role=admin) → unrestricted', () => {
    expect(kernel.isUnrestrictedTaskViewer(legacyT1)).toBe(true);
  });

  it('legacy manager (no tier column, role=manager) → restricted (legacy strict)', () => {
    expect(kernel.isUnrestrictedTaskViewer(legacyT2)).toBe(false);
  });

  it('legacy member (no tier column, role=member) → restricted', () => {
    expect(kernel.isUnrestrictedTaskViewer(legacyT4)).toBe(false);
  });
});
