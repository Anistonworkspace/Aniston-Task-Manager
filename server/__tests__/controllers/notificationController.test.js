/**
 * Tests for notificationController — the user-scoped read/mark/delete API.
 *
 * Mocks Sequelize models so the controller logic can be exercised in
 * isolation. We focus on the security-critical paths (IDOR scoping) and
 * the new endpoints added in this fix pass (DELETE one, DELETE clear-read).
 */

'use strict';

const mockFindOne = jest.fn();
const mockFindAndCountAll = jest.fn();
const mockUpdate = jest.fn();
const mockDestroy = jest.fn();
const mockCount = jest.fn();
const mockEmitToUser = jest.fn();

jest.mock('../../models', () => ({
  Notification: {
    findOne: (...a) => mockFindOne(...a),
    findAndCountAll: (...a) => mockFindAndCountAll(...a),
    update: (...a) => mockUpdate(...a),
    destroy: (...a) => mockDestroy(...a),
    count: (...a) => mockCount(...a),
  },
}));

jest.mock('../../services/socketService', () => ({
  emitToUser: (...a) => mockEmitToUser(...a),
}));

const controller = require('../../controllers/notificationController');

function buildReqRes(opts = {}) {
  const req = {
    user: { id: opts.userId || 'user-A' },
    params: opts.params || {},
    query: opts.query || {},
    body: opts.body || {},
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return { req, res };
}

beforeEach(() => {
  mockFindOne.mockReset();
  mockFindAndCountAll.mockReset();
  mockUpdate.mockReset();
  mockDestroy.mockReset();
  mockCount.mockReset();
  mockEmitToUser.mockReset();
});

describe('getNotifications', () => {
  it('scopes the where clause to req.user.id', async () => {
    mockFindAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    const { req, res } = buildReqRes({ userId: 'alice' });
    await controller.getNotifications(req, res);
    expect(mockFindAndCountAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'alice' } })
    );
  });

  it('respects unreadOnly=true', async () => {
    mockFindAndCountAll.mockResolvedValue({ rows: [], count: 0 });
    const { req, res } = buildReqRes({ userId: 'alice', query: { unreadOnly: 'true' } });
    await controller.getNotifications(req, res);
    expect(mockFindAndCountAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'alice', isRead: false } })
    );
  });
});

describe('markAsRead', () => {
  it('returns 404 (not 403) when the notification belongs to another user', async () => {
    mockFindOne.mockResolvedValue(null);
    const { req, res } = buildReqRes({ userId: 'alice', params: { id: 'n-1' } });
    await controller.markAsRead(req, res);
    expect(mockFindOne).toHaveBeenCalledWith({ where: { id: 'n-1', userId: 'alice' } });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('emits notification:read after a successful update', async () => {
    const update = jest.fn().mockResolvedValue();
    mockFindOne.mockResolvedValue({ id: 'n-1', update });
    const { req, res } = buildReqRes({ userId: 'alice', params: { id: 'n-1' } });
    await controller.markAsRead(req, res);
    expect(update).toHaveBeenCalledWith({ isRead: true });
    expect(mockEmitToUser).toHaveBeenCalledWith('alice', 'notification:read', { notificationId: 'n-1' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

describe('deleteNotification', () => {
  it('scopes destroy by userId and returns 404 for someone else’s notification', async () => {
    mockDestroy.mockResolvedValue(0);
    const { req, res } = buildReqRes({ userId: 'alice', params: { id: 'n-1' } });
    await controller.deleteNotification(req, res);
    expect(mockDestroy).toHaveBeenCalledWith({ where: { id: 'n-1', userId: 'alice' } });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('deletes when row is found and emits update', async () => {
    mockDestroy.mockResolvedValue(1);
    const { req, res } = buildReqRes({ userId: 'alice', params: { id: 'n-1' } });
    await controller.deleteNotification(req, res);
    expect(mockEmitToUser).toHaveBeenCalledWith(
      'alice',
      'notification:read',
      { notificationId: 'n-1', deleted: true }
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

describe('clearRead', () => {
  it('only deletes read notifications belonging to the current user', async () => {
    mockDestroy.mockResolvedValue(7);
    const { req, res } = buildReqRes({ userId: 'alice' });
    await controller.clearRead(req, res);
    expect(mockDestroy).toHaveBeenCalledWith({ where: { userId: 'alice', isRead: true } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: { deleted: 7 },
    }));
  });
});

describe('getUnreadCount', () => {
  it('counts only the current user’s unread rows', async () => {
    mockCount.mockResolvedValue(3);
    const { req, res } = buildReqRes({ userId: 'alice' });
    await controller.getUnreadCount(req, res);
    expect(mockCount).toHaveBeenCalledWith({ where: { userId: 'alice', isRead: false } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: { unreadCount: 3 },
    }));
  });
});
