/**
 * Tests for the disconnectUser logout helper added to socketService.
 *
 * Verifies that:
 *   - With no socketId, every socket for the user is disconnected.
 *   - With a socketId, only the matching socket is disconnected.
 *   - The 'auth:logout' event is emitted before the close so the client
 *     latches its logout flag and refuses to auto-reconnect.
 *   - Calling on a not-yet-initialised socket service is a no-op.
 */

'use strict';

const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
const mockServerInstance = {
  use: jest.fn(),
  on: jest.fn(),
  to: mockTo,
  in: jest.fn(),
};

jest.mock('socket.io', () => ({
  Server: jest.fn(() => mockServerInstance),
}));

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../models', () => ({
  User: { findByPk: jest.fn() },
  Board: { findByPk: jest.fn() },
}));
jest.mock('../../services/pushService', () => ({
  sendPushToUser: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

describe('socketService.disconnectUser', () => {
  let service;

  function buildSocket(id, userId) {
    return {
      id,
      user: { id: userId },
      data: { userId },
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  beforeEach(() => {
    jest.resetModules();
    mockServerInstance.in = jest.fn();
    service = require('../../services/socketService');
    service.initializeSocket({});
  });

  it('disconnects every socket in the user room when no socketId is passed', async () => {
    const a = buildSocket('s1', 'user-A');
    const b = buildSocket('s2', 'user-A');
    mockServerInstance.in.mockImplementation((room) => {
      expect(room).toBe('user:user-A');
      return { fetchSockets: jest.fn().mockResolvedValue([a, b]) };
    });

    const count = await service.disconnectUser('user-A');
    expect(count).toBe(2);
    expect(a.emit).toHaveBeenCalledWith('auth:logout', expect.any(Object));
    expect(b.emit).toHaveBeenCalledWith('auth:logout', expect.any(Object));
    expect(a.disconnect).toHaveBeenCalledWith(true);
    expect(b.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects only the named socketId when provided', async () => {
    const a = buildSocket('s1', 'user-A');
    const b = buildSocket('s2', 'user-A');
    mockServerInstance.in.mockImplementation(() => ({
      fetchSockets: jest.fn().mockResolvedValue([a, b]),
    }));

    const count = await service.disconnectUser('user-A', 's2');
    expect(count).toBe(1);
    expect(a.disconnect).not.toHaveBeenCalled();
    expect(b.disconnect).toHaveBeenCalledWith(true);
  });

  it('returns 0 and does not throw when no socket service is initialised', async () => {
    jest.resetModules();
    const fresh = require('../../services/socketService');
    const count = await fresh.disconnectUser('user-A');
    expect(count).toBe(0);
  });

  it('skips sockets whose userId does not match (defense-in-depth)', async () => {
    const wrongUser = buildSocket('sX', 'user-B');
    mockServerInstance.in.mockImplementation(() => ({
      fetchSockets: jest.fn().mockResolvedValue([wrongUser]),
    }));
    const count = await service.disconnectUser('user-A');
    expect(count).toBe(0);
    expect(wrongUser.disconnect).not.toHaveBeenCalled();
  });
});
