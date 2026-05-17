'use strict';

/**
 * Tests for server/services/notificationService.js — Phase 2.8 of the QA
 * remediation plan (docs/qa-audit-2026-05-17.md → §22 P0 item #8).
 * Previously 18.64% coverage.
 *
 * notificationService is the SINGLE entry point for notifications.
 * Everything else (controllers, jobs, services) routes through here so
 * sanitization, idempotency, socket fan-out, and email all stay
 * consistent. Test scope:
 *   - buildIdempotencyKey (pure)
 *   - createNotification: required args, sanitization, idempotency
 *     hit/miss, race-condition UniqueConstraint recovery, inactive-user
 *     skip, socket fan-out, suppressSocket opt-out, email best-effort
 *   - sendNotification (legacy wrapper) forwards to createNotification
 *
 * Mocks: Notification + User + emitToUser + sanitize helpers + logger.
 * Email transport is NOT exercised by default (no SMTP env in tests).
 */

jest.mock('../../models', () => ({
  Notification: { create: jest.fn(), findOne: jest.fn() },
  User: { findByPk: jest.fn() },
}));
jest.mock('../../services/socketService', () => ({
  emitToUser: jest.fn(),
}));
jest.mock('../../utils/sanitize', () => ({
  sanitizeNotificationField: jest.fn((s) => `clean:${s}`),
  sanitizeNotificationMessage: jest.fn((s) => `clean:${s}`),
}));
jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const { Notification, User } = require('../../models');
const { emitToUser } = require('../../services/socketService');
const { sanitizeNotificationMessage } = require('../../utils/sanitize');
const logger = require('../../utils/logger');

const {
  createNotification,
  sendNotification,
  buildIdempotencyKey,
  sanitizeNotificationField,
  sanitizeNotificationMessage: smRe,
} = require('../../services/notificationService');

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish defaults
  sanitizeNotificationMessage.mockImplementation((s) => `clean:${s}`);
  Notification.create.mockResolvedValue({ id: 'n-1', type: 't', message: 'm' });
  Notification.findOne.mockResolvedValue(null);
  User.findByPk.mockResolvedValue({ isActive: true });
  // Make sure no SMTP env survives between tests
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_FROM;
});

// ─── buildIdempotencyKey ────────────────────────────────────────

describe('buildIdempotencyKey', () => {
  it('joins parts with colon', () => {
    expect(buildIdempotencyKey('task-assigned', 'task-abc', 'user-xyz'))
      .toBe('task-assigned:task-abc:user-xyz');
  });

  it('filters out null / undefined / empty parts', () => {
    expect(buildIdempotencyKey('a', null, 'b', undefined, '', 'c')).toBe('a:b:c');
  });

  it('coerces non-string parts via String()', () => {
    expect(buildIdempotencyKey('count', 42, true)).toBe('count:42:true');
  });

  it('clips long keys to the 120-char column limit', () => {
    const long = 'x'.repeat(500);
    const out = buildIdempotencyKey('prefix', long);
    expect(out.length).toBe(120);
    expect(out.startsWith('prefix:')).toBe(true);
  });

  it('returns empty string when no parts supplied', () => {
    expect(buildIdempotencyKey()).toBe('');
  });

  it('returns empty string when all parts are filtered out', () => {
    expect(buildIdempotencyKey(null, undefined, '')).toBe('');
  });
});

describe('re-exports', () => {
  it('re-exports sanitizeNotificationField and sanitizeNotificationMessage from utils/sanitize', () => {
    expect(typeof sanitizeNotificationField).toBe('function');
    expect(typeof smRe).toBe('function');
  });
});

// ─── createNotification — required-arg validation ───────────────

describe('createNotification — required args', () => {
  it('returns null + logs warn when userId missing', async () => {
    const out = await createNotification({ type: 't', message: 'm' });
    expect(out).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('missing required args'),
      expect.objectContaining({ hasUserId: false }),
    );
    expect(Notification.create).not.toHaveBeenCalled();
  });

  it('returns null when type missing', async () => {
    const out = await createNotification({ userId: 'u', message: 'm' });
    expect(out).toBeNull();
  });

  it('returns null when message missing', async () => {
    const out = await createNotification({ userId: 'u', type: 't' });
    expect(out).toBeNull();
  });

  it('returns null when args is an empty object', async () => {
    const out = await createNotification({});
    expect(out).toBeNull();
  });

  it('returns null when args is omitted (defaults applied)', async () => {
    const out = await createNotification();
    expect(out).toBeNull();
  });
});

// ─── createNotification — sanitization ──────────────────────────

describe('createNotification — sanitization', () => {
  it('sanitizes the message by default (XSS + Markdown defang)', async () => {
    await createNotification({ userId: 'u', type: 'task_updated', message: '<script>alert(1)</script>' });
    expect(sanitizeNotificationMessage).toHaveBeenCalledWith('<script>alert(1)</script>');
    expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
      message: 'clean:<script>alert(1)</script>',
    }));
  });

  it('skips sanitization when sanitize=false (passes raw string through String())', async () => {
    await createNotification({ userId: 'u', type: 'x', message: 'raw text', sanitize: false });
    expect(sanitizeNotificationMessage).not.toHaveBeenCalled();
    expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
      message: 'raw text',
    }));
  });
});

// ─── createNotification — inactive user skip (P2-8) ─────────────

describe('createNotification — inactive user skip', () => {
  it('returns { success:false, reason:"user_inactive" } when recipient is deactivated', async () => {
    User.findByPk.mockResolvedValueOnce({ isActive: false });
    const out = await createNotification({ userId: 'u', type: 't', message: 'm' });
    expect(out).toEqual({ success: false, reason: 'user_inactive' });
    expect(Notification.create).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalled();
  });

  it('proceeds when recipient row missing entirely (null lookup → fall through)', async () => {
    User.findByPk.mockResolvedValueOnce(null);
    const out = await createNotification({ userId: 'u', type: 't', message: 'm' });
    expect(Notification.create).toHaveBeenCalled();
    expect(out).toMatchObject({ id: 'n-1' });
  });

  it('falls through to the write when User.findByPk throws (transient DB blip)', async () => {
    User.findByPk.mockRejectedValueOnce(new Error('db blip'));
    const out = await createNotification({ userId: 'u', type: 't', message: 'm' });
    expect(Notification.create).toHaveBeenCalled();
    expect(out).toMatchObject({ id: 'n-1' });
  });
});

// ─── createNotification — idempotency ───────────────────────────

describe('createNotification — idempotency', () => {
  it('returns the existing row when idempotencyKey already used (no insert)', async () => {
    const existing = { id: 'n-existing', type: 't', message: 'clean:m' };
    Notification.findOne.mockResolvedValueOnce(existing);

    const out = await createNotification({
      userId: 'u', type: 't', message: 'm', idempotencyKey: 'task-assigned:abc:u',
    });

    expect(out).toBe(existing);
    expect(Notification.create).not.toHaveBeenCalled();
    expect(emitToUser).not.toHaveBeenCalled(); // no re-emit on idempotent hit
  });

  it('proceeds with insert when idempotencyKey not yet used', async () => {
    Notification.findOne.mockResolvedValueOnce(null);
    await createNotification({
      userId: 'u', type: 't', message: 'm', idempotencyKey: 'fresh-key',
    });
    expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'fresh-key',
    }));
  });

  it('recovers from a concurrent-insert race via SequelizeUniqueConstraintError', async () => {
    const winner = { id: 'n-winner', type: 't' };
    Notification.findOne
      .mockResolvedValueOnce(null)      // first idempotency check — miss
      .mockResolvedValueOnce(winner);   // post-race re-fetch returns the winner
    const err = new Error('duplicate key value violates unique constraint');
    err.name = 'SequelizeUniqueConstraintError';
    Notification.create.mockRejectedValueOnce(err);

    const out = await createNotification({
      userId: 'u', type: 't', message: 'm', idempotencyKey: 'race-key',
    });
    expect(out).toBe(winner);
  });

  it('recovers when the raw Postgres error code 23505 surfaces (no Sequelize wrapper)', async () => {
    const winner = { id: 'n-pg-winner' };
    Notification.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    const err = new Error('dup');
    err.parent = { code: '23505' };
    Notification.create.mockRejectedValueOnce(err);

    const out = await createNotification({
      userId: 'u', type: 't', message: 'm', idempotencyKey: 'race-key-2',
    });
    expect(out).toBe(winner);
  });

  it('does NOT swallow a real Notification.create error (returns null after logging)', async () => {
    const err = new Error('table missing');
    err.name = 'SomethingElse';
    Notification.create.mockRejectedValueOnce(err);

    const out = await createNotification({ userId: 'u', type: 't', message: 'm' });
    expect(out).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('createNotification error'),
      expect.any(Object),
    );
  });

  it('skips findByIdempotencyKey entirely when no idempotencyKey provided', async () => {
    await createNotification({ userId: 'u', type: 't', message: 'm' });
    expect(Notification.findOne).not.toHaveBeenCalled();
  });

  it('absorbs findByIdempotencyKey failure (column missing on legacy DB) and proceeds to insert', async () => {
    Notification.findOne.mockRejectedValueOnce(new Error('column "idempotencyKey" does not exist'));
    await createNotification({
      userId: 'u', type: 't', message: 'm', idempotencyKey: 'k',
    });
    // Insert still attempted — self-healing on first deploy
    expect(Notification.create).toHaveBeenCalled();
  });
});

// ─── createNotification — socket fan-out ────────────────────────

describe('createNotification — socket fan-out', () => {
  it('emits notification:new to the recipient by default', async () => {
    const created = { id: 'n-1', type: 't', message: 'clean:m' };
    Notification.create.mockResolvedValueOnce(created);

    await createNotification({
      userId: 'u-recipient', type: 't', message: 'm', boardId: 'board-99',
    });

    expect(emitToUser).toHaveBeenCalledWith(
      'u-recipient',
      'notification:new',
      { notification: created, boardId: 'board-99' },
    );
  });

  it('suppressSocket=true skips the emit entirely (used by batched-emit callers)', async () => {
    await createNotification({
      userId: 'u', type: 't', message: 'm', suppressSocket: true,
    });
    expect(emitToUser).not.toHaveBeenCalled();
  });

  it('forwards a null boardId when none supplied', async () => {
    await createNotification({ userId: 'u', type: 't', message: 'm' });
    expect(emitToUser).toHaveBeenCalledWith('u', 'notification:new',
      expect.objectContaining({ boardId: null }));
  });
});

// ─── createNotification — email best-effort ─────────────────────

describe('createNotification — email best-effort', () => {
  it('does not attempt email when no email arg supplied', async () => {
    // The transport getter shouldn't even be invoked. We can't directly
    // assert that because it's internal, but a no-email run completes and
    // returns the created notification.
    const out = await createNotification({ userId: 'u', type: 't', message: 'm' });
    expect(out).toMatchObject({ id: 'n-1' });
  });

  it('does not throw or block when email is set but SMTP env is missing (no transport)', async () => {
    const out = await createNotification({
      userId: 'u', type: 't', message: 'm', email: 'someone@example.com',
    });
    expect(out).toMatchObject({ id: 'n-1' });
  });
});

// ─── sendNotification (legacy wrapper) ──────────────────────────

describe('sendNotification — legacy positional wrapper', () => {
  it('forwards to createNotification with entityType="task" + entityId=taskId', async () => {
    await sendNotification('u-recipient', 'Title', 'Body', 'task_assigned', 'task-abc');
    expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_assigned',
      entityType: 'task',
      entityId: 'task-abc',
      userId: 'u-recipient',
    }));
  });

  it('threads through opts.boardId / email / userName / idempotencyKey', async () => {
    await sendNotification('u', 'T', 'B', 'task_updated', 'task-1', {
      boardId: 'board-1',
      email: 'u@example.com',
      userName: 'Test User',
      idempotencyKey: 'k',
    });
    expect(emitToUser).toHaveBeenCalledWith('u', 'notification:new',
      expect.objectContaining({ boardId: 'board-1' }));
  });

  it('defaults opts.sanitize=true unless explicitly set to false', async () => {
    await sendNotification('u', 'T', '<script>x</script>', 'x', 't-1');
    expect(sanitizeNotificationMessage).toHaveBeenCalled();
  });

  it('threads sanitize=false through to createNotification', async () => {
    await sendNotification('u', 'T', '<script>x</script>', 'x', 't-1', { sanitize: false });
    expect(sanitizeNotificationMessage).not.toHaveBeenCalled();
  });

  it('threads suppressSocket=true through to createNotification', async () => {
    await sendNotification('u', 'T', 'B', 'x', 't-1', { suppressSocket: true });
    expect(emitToUser).not.toHaveBeenCalled();
  });
});
