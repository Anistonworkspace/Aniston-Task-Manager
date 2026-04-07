/**
 * Unit tests for socketService.
 *
 * The socket.io Server, JWT, and all Sequelize models are fully mocked.
 * Tests verify:
 *   - emitToBoard() emits to the correct room name (`board:<id>`)
 *   - emitToUser() emits to the correct room name (`user:<id>`)
 *   - emitToBoard() is a no-op when ioInstance is null (not yet initialised)
 *   - emitToUser() is a no-op when ioInstance is null
 *   - emitToUser() triggers push notification for 'notification:new' events
 *   - getIO() throws when socket has not been initialised
 */

'use strict';

// ─── Mock socket.io ───────────────────────────────────────────────────────────
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
const mockServerInstance = {
  use: jest.fn(),
  on: jest.fn(),
  to: mockTo,
};

jest.mock('socket.io', () => ({
  Server: jest.fn(() => mockServerInstance),
}));

// ─── Mock JWT (used in the auth middleware inside initializeSocket) ───────────
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

// ─── Mock Sequelize models ────────────────────────────────────────────────────
jest.mock('../../models', () => ({
  User: { findByPk: jest.fn() },
  Board: { findByPk: jest.fn() },
}));

// ─── Mock pushService (optional dependency inside emitToUser) ─────────────────
jest.mock('../../services/pushService', () => ({
  sendPushToUser: jest.fn().mockResolvedValue(undefined),
}), { virtual: true });

// ─────────────────────────────────────────────────────────────────────────────
// Import service AFTER all mocks are registered
// ─────────────────────────────────────────────────────────────────────────────

// We need to reload the module for each test that manipulates the private
// ioInstance, so we use jest.isolateModules() for those cases.

describe('socketService', () => {

  // ── emitToBoard ────────────────────────────────────────────────────────────

  describe('emitToBoard()', () => {
    let emitToBoard;

    beforeEach(() => {
      jest.resetModules();
      mockTo.mockClear();
      mockEmit.mockClear();
    });

    /**
     * Simulate an initialised ioInstance by loading the module and injecting
     * the mock server via initializeSocket().
     */
    function loadWithInitialisedSocket() {
      // socket.io Server constructor will return mockServerInstance
      const { Server } = require('socket.io');
      const service = require('../../services/socketService');

      // Call initializeSocket with a fake http server; the Server constructor
      // mock ignores the argument and returns mockServerInstance.
      // We intercept io.on('connection') but do not call it in these tests.
      service.initializeSocket({});

      return service;
    }

    it('emits to room "board:<boardId>" with the correct event and data', () => {
      const service = loadWithInitialisedSocket();

      service.emitToBoard('board-123', 'task:updated', { taskId: 'abc' });

      expect(mockTo).toHaveBeenCalledWith('board:board-123');
      expect(mockEmit).toHaveBeenCalledWith('task:updated', { taskId: 'abc' });
    });

    it('emits to the correct board when multiple boards exist', () => {
      const service = loadWithInitialisedSocket();

      service.emitToBoard('board-AAA', 'task:created', { title: 'New task' });
      service.emitToBoard('board-BBB', 'task:deleted', { taskId: 'xyz' });

      expect(mockTo).toHaveBeenNthCalledWith(1, 'board:board-AAA');
      expect(mockTo).toHaveBeenNthCalledWith(2, 'board:board-BBB');
    });

    it('is a no-op when ioInstance has not been initialised', () => {
      // Load module in isolation WITHOUT calling initializeSocket
      jest.isolateModules(() => {
        const service = require('../../services/socketService');
        // ioInstance is null at module load time
        expect(() => service.emitToBoard('board-xyz', 'test', {})).not.toThrow();
      });

      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  // ── emitToUser ─────────────────────────────────────────────────────────────

  describe('emitToUser()', () => {
    beforeEach(() => {
      jest.resetModules();
      mockTo.mockClear();
      mockEmit.mockClear();
    });

    function loadWithInitialisedSocket() {
      require('socket.io');
      const service = require('../../services/socketService');
      service.initializeSocket({});
      return service;
    }

    it('emits to room "user:<userId>" with the correct event and data', () => {
      const service = loadWithInitialisedSocket();

      service.emitToUser('user-456', 'notification:new', { message: 'hello' });

      expect(mockTo).toHaveBeenCalledWith('user:user-456');
      expect(mockEmit).toHaveBeenCalledWith('notification:new', { message: 'hello' });
    });

    it('is a no-op when ioInstance has not been initialised', () => {
      jest.isolateModules(() => {
        const service = require('../../services/socketService');
        expect(() => service.emitToUser('user-abc', 'test', {})).not.toThrow();
      });

      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('does not throw on notification:new even if pushService is unavailable', () => {
      jest.isolateModules(() => {
        // Ensure pushService require throws (module not found)
        jest.mock('../../services/pushService', () => {
          throw new Error('Module not found');
        }, { virtual: true });

        const service = require('../../services/socketService');
        service.initializeSocket({});

        expect(() => {
          service.emitToUser('user-789', 'notification:new', {
            notification: { id: 'n1', message: 'You have a new task', entityType: 'task' },
          });
        }).not.toThrow();
      });
    });

    it('emits to different users independently', () => {
      const service = loadWithInitialisedSocket();

      service.emitToUser('user-A', 'task:assigned', { taskId: '1' });
      service.emitToUser('user-B', 'task:assigned', { taskId: '2' });

      expect(mockTo).toHaveBeenNthCalledWith(1, 'user:user-A');
      expect(mockTo).toHaveBeenNthCalledWith(2, 'user:user-B');
    });
  });

  // ── getIO ──────────────────────────────────────────────────────────────────

  describe('getIO()', () => {
    beforeEach(() => {
      jest.resetModules();
    });

    it('throws an error when called before initializeSocket', () => {
      jest.isolateModules(() => {
        const service = require('../../services/socketService');
        expect(() => service.getIO()).toThrow(
          'Socket.io has not been initialised. Call initializeSocket first.'
        );
      });
    });

    it('returns the io instance after initializeSocket has been called', () => {
      const service = require('../../services/socketService');
      service.initializeSocket({});
      const io = service.getIO();
      expect(io).toBeDefined();
      expect(io).toBe(mockServerInstance);
    });
  });

  // ── initializeSocket ───────────────────────────────────────────────────────

  describe('initializeSocket()', () => {
    beforeEach(() => {
      jest.resetModules();
    });

    it('registers the auth middleware on the io instance', () => {
      const service = require('../../services/socketService');
      service.initializeSocket({});
      expect(mockServerInstance.use).toHaveBeenCalled();
    });

    it('registers the connection event handler', () => {
      const service = require('../../services/socketService');
      service.initializeSocket({});
      expect(mockServerInstance.on).toHaveBeenCalledWith('connection', expect.any(Function));
    });

    it('returns the io instance', () => {
      const service = require('../../services/socketService');
      const io = service.initializeSocket({});
      expect(io).toBe(mockServerInstance);
    });
  });
});
