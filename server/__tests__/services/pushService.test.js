/**
 * Tests for the DB-backed pushService.
 *
 * Goal: confirm the logout-bug fix path. Specifically:
 *   - saveSubscription persists rows and re-links endpoints across users
 *   - deactivateSubscription is scoped by userId AND endpoint (no cross-user
 *     deactivation possible)
 *   - sendPushToUser only fans out to active rows
 *   - 404/410 from web-push hard-deletes the row
 *
 * web-push and the PushSubscription model are mocked so the test runs
 * without hitting Postgres or the real VAPID server.
 */

'use strict';

// Pretend VAPID is configured so sendPushToUser actually attempts a send.
process.env.VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BHxxxx-publickey';
process.env.VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'privatekey';

// Mock web-push so setVapidDetails doesn't reject our fake keys and we can
// drive sendNotification responses per test.
const mockSendNotification = jest.fn();
jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: (...args) => mockSendNotification(...args),
}));

// Mock the model
const mockPSFindOne = jest.fn();
const mockPSUpdate = jest.fn();
const mockPSCreate = jest.fn();
const mockPSFindAll = jest.fn();
const mockPSDestroy = jest.fn();
jest.mock('../../models', () => ({
  PushSubscription: {
    findOne: (...a) => mockPSFindOne(...a),
    update: (...a) => mockPSUpdate(...a),
    create: (...a) => mockPSCreate(...a),
    findAll: (...a) => mockPSFindAll(...a),
    destroy: (...a) => mockPSDestroy(...a),
  },
}));

const pushService = require('../../services/pushService');

beforeEach(() => {
  mockPSFindOne.mockReset();
  mockPSUpdate.mockReset();
  mockPSCreate.mockReset();
  mockPSFindAll.mockReset();
  mockPSDestroy.mockReset();
  mockSendNotification.mockReset();
});

describe('saveSubscription', () => {
  const subscription = {
    endpoint: 'https://fcm.example/abc',
    keys: { p256dh: 'p256', auth: 'authkey' },
  };

  it('rejects when keys are missing', async () => {
    const out = await pushService.saveSubscription('user-A', { endpoint: 'x' });
    expect(out).toBe(null);
    expect(mockPSCreate).not.toHaveBeenCalled();
  });

  it('creates a new row when endpoint is unseen', async () => {
    mockPSFindOne.mockResolvedValue(null);
    mockPSCreate.mockResolvedValue({ id: 'row-1' });
    const row = await pushService.saveSubscription('user-A', subscription, { userAgent: 'jest' });
    expect(mockPSFindOne).toHaveBeenCalledWith({ where: { endpoint: subscription.endpoint } });
    expect(mockPSCreate).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-A',
      endpoint: subscription.endpoint,
      isActive: true,
    }));
    expect(row).toEqual({ id: 'row-1' });
  });

  it('re-links the row to the new userId when the same browser was used by a different user', async () => {
    const update = jest.fn().mockResolvedValue();
    mockPSFindOne.mockResolvedValue({ userId: 'user-A', update });
    await pushService.saveSubscription('user-B', subscription);
    // Critical: userId must be updated to user-B AND isActive must be true so
    // user-A can never receive a push at this endpoint again.
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-B',
      isActive: true,
      deactivatedAt: null,
    }));
  });
});

describe('deactivateSubscription', () => {
  it('is scoped by userId AND endpoint (cross-user deactivation prevented)', async () => {
    mockPSUpdate.mockResolvedValue([1]);
    await pushService.deactivateSubscription('user-A', 'https://fcm.example/abc');
    expect(mockPSUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: false }),
      { where: { userId: 'user-A', endpoint: 'https://fcm.example/abc' } }
    );
  });

  it('returns 0 when neither argument matches', async () => {
    mockPSUpdate.mockResolvedValue([0]);
    const count = await pushService.deactivateSubscription('user-A', 'unknown');
    expect(count).toBe(0);
  });
});

describe('sendPushToUser', () => {
  it('does nothing when the user has no active subscriptions', async () => {
    mockPSFindAll.mockResolvedValue([]);
    await pushService.sendPushToUser('user-A', { title: 't', body: 'b' });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('only loads active subscriptions for the user', async () => {
    mockPSFindAll.mockResolvedValue([]);
    await pushService.sendPushToUser('user-A', { title: 't' });
    expect(mockPSFindAll).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-A', isActive: true },
    }));
  });

  it('hard-deletes a subscription on 410 Gone', async () => {
    mockPSFindAll.mockResolvedValue([
      { id: 'r1', endpoint: 'https://gone', p256dh: 'p', auth: 'a' },
    ]);
    mockSendNotification.mockRejectedValue({ statusCode: 410 });
    mockPSDestroy.mockResolvedValue(1);
    await pushService.sendPushToUser('user-A', { title: 't' });
    expect(mockPSDestroy).toHaveBeenCalledWith({ where: { endpoint: 'https://gone' } });
  });

  it('does NOT delete on 401 (transient VAPID auth error)', async () => {
    mockPSFindAll.mockResolvedValue([
      { id: 'r1', endpoint: 'https://still-good', p256dh: 'p', auth: 'a' },
    ]);
    mockSendNotification.mockRejectedValue({ statusCode: 401, message: 'auth' });
    await pushService.sendPushToUser('user-A', { title: 't' });
    expect(mockPSDestroy).not.toHaveBeenCalled();
  });
});
