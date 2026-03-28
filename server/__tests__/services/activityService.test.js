/**
 * Unit tests for activityService.logActivity().
 *
 * The Activity model is fully mocked. Tests verify:
 *   - Activity.create() is called with correctly mapped fields
 *   - Optional fields (taskId, boardId, meta) have sensible defaults
 *   - Fire-and-forget: a rejection from Activity.create() is swallowed
 *     and does NOT propagate to the caller
 *   - logActivity() always returns undefined (no awaited return value)
 */

'use strict';

// ─── Mock the models barrel before the service loads ─────────────────────────
jest.mock('../../models', () => ({
  Activity: {
    create: jest.fn(),
  },
}));

const { Activity } = require('../../models');
const { logActivity } = require('../../services/activityService');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Flush the microtask queue so the fire-and-forget promise settles. */
const flushPromises = () => new Promise(resolve => setImmediate(resolve));

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('activityService.logActivity()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: Activity.create resolves successfully
    Activity.create.mockResolvedValue({ id: 'activity-uuid' });
  });

  // ── Happy-path: all fields supplied ───────────────────────────────────────

  describe('with all parameters provided', () => {
    it('calls Activity.create with correctly mapped values', async () => {
      const opts = {
        action: 'task_created',
        description: 'Created task "Fix bug"',
        entityType: 'task',
        entityId: 'entity-uuid',
        taskId: 'task-uuid',
        boardId: 'board-uuid',
        userId: 'user-uuid',
        meta: { priority: 'high' },
      };

      logActivity(opts);
      await flushPromises();

      expect(Activity.create).toHaveBeenCalledTimes(1);
      expect(Activity.create).toHaveBeenCalledWith({
        action: 'task_created',
        description: 'Created task "Fix bug"',
        entityType: 'task',
        entityId: 'entity-uuid',
        taskId: 'task-uuid',
        boardId: 'board-uuid',
        userId: 'user-uuid',
        meta: { priority: 'high' },
      });
    });
  });

  // ── Optional fields default correctly ─────────────────────────────────────

  describe('with optional fields omitted', () => {
    it('sets taskId to null when not supplied', async () => {
      logActivity({
        action: 'board_created',
        description: 'Created board "Sprint 1"',
        entityType: 'board',
        entityId: 'board-uuid',
        boardId: 'board-uuid',
        userId: 'user-uuid',
      });
      await flushPromises();

      const callArg = Activity.create.mock.calls[0][0];
      expect(callArg.taskId).toBeNull();
    });

    it('sets boardId to null when not supplied', async () => {
      logActivity({
        action: 'comment_created',
        description: 'Left a comment',
        entityType: 'comment',
        entityId: 'comment-uuid',
        taskId: 'task-uuid',
        userId: 'user-uuid',
      });
      await flushPromises();

      const callArg = Activity.create.mock.calls[0][0];
      expect(callArg.boardId).toBeNull();
    });

    it('defaults meta to an empty object when not supplied', async () => {
      logActivity({
        action: 'status_changed',
        description: 'Status changed to done',
        entityType: 'task',
        entityId: 'task-uuid',
        userId: 'user-uuid',
      });
      await flushPromises();

      const callArg = Activity.create.mock.calls[0][0];
      expect(callArg.meta).toEqual({});
    });
  });

  // ── Fire-and-forget behaviour ──────────────────────────────────────────────

  describe('fire-and-forget error handling', () => {
    it('does not throw when Activity.create rejects', async () => {
      Activity.create.mockRejectedValue(new Error('DB connection lost'));

      // logActivity() must not throw — even synchronously
      expect(() => {
        logActivity({
          action: 'task_deleted',
          description: 'Deleted task',
          entityType: 'task',
          entityId: 'task-uuid',
          userId: 'user-uuid',
        });
      }).not.toThrow();

      // The rejection is swallowed — no unhandled rejection bubbles up
      await flushPromises();
    });

    it('still returns undefined after a rejected Activity.create', async () => {
      Activity.create.mockRejectedValue(new Error('Timeout'));

      const result = logActivity({
        action: 'subtask_created',
        description: 'Subtask created',
        entityType: 'subtask',
        entityId: 'subtask-uuid',
        userId: 'user-uuid',
      });

      await flushPromises();

      expect(result).toBeUndefined();
    });

    it('logs the error message to console.error on failure', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      Activity.create.mockRejectedValue(new Error('Disk full'));

      logActivity({
        action: 'worklog_updated',
        description: 'Work log updated',
        entityType: 'worklog',
        entityId: 'wl-uuid',
        userId: 'user-uuid',
      });
      await flushPromises();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[Activity] Failed to log activity:',
        'Disk full'
      );

      consoleSpy.mockRestore();
    });
  });

  // ── Return value ───────────────────────────────────────────────────────────

  describe('return value', () => {
    it('always returns undefined synchronously', () => {
      const result = logActivity({
        action: 'file_uploaded',
        description: 'File uploaded',
        entityType: 'file',
        entityId: 'file-uuid',
        userId: 'user-uuid',
      });

      expect(result).toBeUndefined();
    });

    it('is not a Promise (fire-and-forget, not async)', () => {
      const result = logActivity({
        action: 'comment_deleted',
        description: 'Comment removed',
        entityType: 'comment',
        entityId: 'comment-uuid',
        userId: 'user-uuid',
      });

      // A real Promise would have a .then method
      expect(result).not.toBeInstanceOf(Promise);
    });
  });

  // ── Multiple calls ─────────────────────────────────────────────────────────

  describe('multiple sequential calls', () => {
    it('calls Activity.create for each logActivity invocation', async () => {
      logActivity({ action: 'a', description: 'd', entityType: 'task', entityId: '1', userId: 'u1' });
      logActivity({ action: 'b', description: 'd', entityType: 'task', entityId: '2', userId: 'u2' });
      logActivity({ action: 'c', description: 'd', entityType: 'task', entityId: '3', userId: 'u3' });

      await flushPromises();

      expect(Activity.create).toHaveBeenCalledTimes(3);
    });
  });
});
