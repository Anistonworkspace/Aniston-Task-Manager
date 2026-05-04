'use strict';

/**
 * Unit tests for boardVisibilityService.
 *
 * The service decides "which boards a user can see in their sidebar /
 * library / search". Bug fixed: assistant_manager was previously grouped
 * with admin/manager and bypassed scoping, leaking every board name.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../config/db', () => ({
  sequelize: { query: jest.fn() },
}));

jest.mock('../../models', () => ({
  Board: { findAll: jest.fn() },
}));

jest.mock('../../services/hierarchyService', () => ({
  getDescendantIds: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const hierarchyService = require('../../services/hierarchyService');
const boardVisibility = require('../../services/boardVisibilityService');

const SUNNY = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  role: 'assistant_manager',
  isSuperAdmin: false,
};

const MEMBER = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
  role: 'member',
  isSuperAdmin: false,
};

const MANAGER = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
  role: 'manager',
  isSuperAdmin: false,
};

const ADMIN = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  role: 'admin',
  isSuperAdmin: false,
};

const SUPER = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5',
  role: 'manager',
  isSuperAdmin: true,
};

describe('getVisibleUserIdsForBoardScope', () => {
  beforeEach(() => {
    hierarchyService.getDescendantIds.mockReset();
  });

  test('admin → unrestricted', async () => {
    const scope = await boardVisibility.getVisibleUserIdsForBoardScope(ADMIN);
    expect(scope.unrestricted).toBe(true);
  });

  test('super admin → unrestricted regardless of role', async () => {
    const scope = await boardVisibility.getVisibleUserIdsForBoardScope(SUPER);
    expect(scope.unrestricted).toBe(true);
  });

  test('manager → unrestricted (existing behavior preserved)', async () => {
    const scope = await boardVisibility.getVisibleUserIdsForBoardScope(MANAGER);
    expect(scope.unrestricted).toBe(true);
  });

  test('assistant_manager with no descendants → only self', async () => {
    hierarchyService.getDescendantIds.mockResolvedValue([]);
    const scope = await boardVisibility.getVisibleUserIdsForBoardScope(SUNNY);
    expect(scope.unrestricted).toBe(false);
    expect(scope.userIds).toEqual([SUNNY.id]);
  });

  test('assistant_manager with descendants → self + descendants', async () => {
    const child1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const child2 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    hierarchyService.getDescendantIds.mockResolvedValue([child1, child2]);
    const scope = await boardVisibility.getVisibleUserIdsForBoardScope(SUNNY);
    expect(scope.unrestricted).toBe(false);
    expect(new Set(scope.userIds)).toEqual(new Set([SUNNY.id, child1, child2]));
  });

  test('member with no descendants → only self', async () => {
    hierarchyService.getDescendantIds.mockResolvedValue([]);
    const scope = await boardVisibility.getVisibleUserIdsForBoardScope(MEMBER);
    expect(scope.unrestricted).toBe(false);
    expect(scope.userIds).toEqual([MEMBER.id]);
  });
});

describe('canUserSeeBoard', () => {
  const { sequelize } = require('../../config/db');
  const BOARD = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  beforeEach(() => {
    sequelize.query.mockReset();
    hierarchyService.getDescendantIds.mockReset();
  });

  test('admin → always true (no DB calls)', async () => {
    const ok = await boardVisibility.canUserSeeBoard(ADMIN, BOARD);
    expect(ok).toBe(true);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('manager → always true (no DB calls)', async () => {
    const ok = await boardVisibility.canUserSeeBoard(MANAGER, BOARD);
    expect(ok).toBe(true);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('assistant_manager with no relationship → false', async () => {
    hierarchyService.getDescendantIds.mockResolvedValue([]);
    // Every query returns empty.
    sequelize.query.mockResolvedValue([[]]);
    const ok = await boardVisibility.canUserSeeBoard(SUNNY, BOARD);
    expect(ok).toBe(false);
  });

  test('assistant_manager who created the board → true', async () => {
    hierarchyService.getDescendantIds.mockResolvedValue([]);
    // First query (creator) hits.
    sequelize.query.mockResolvedValueOnce([[{ '?column?': 1 }]]);
    const ok = await boardVisibility.canUserSeeBoard(SUNNY, BOARD);
    expect(ok).toBe(true);
  });

  test('assistant_manager with explicit (non-auto) BoardMember row → true', async () => {
    hierarchyService.getDescendantIds.mockResolvedValue([]);
    // creator: empty → autoAdded col exists → explicit member: hit
    sequelize.query
      .mockResolvedValueOnce([[]])             // creator check
      .mockResolvedValueOnce([[{ exists: 1 }]]) // _colExists
      .mockResolvedValueOnce([[{ '?column?': 1 }]]); // explicit member hit
    const ok = await boardVisibility.canUserSeeBoard(SUNNY, BOARD);
    expect(ok).toBe(true);
  });
});
