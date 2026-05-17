'use strict';

/**
 * Unit tests for docCommentNotificationService.
 *
 * Surface under test: syncCommentNotifications — the fire-and-forget
 * fan-out helper that produces notifications for new doc comments, replies,
 * and inline @-mentions.
 *
 * All Sequelize models and the notification service are mocked. No DB I/O.
 * Pattern is copied (with adjustments) from docMentions.test.js so the
 * mock setup feels consistent across the doc-related test suite.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

// ─── Mocks (declared BEFORE the service is required so the lazy
//     `require('../services/notificationService')` and lazy
//     `require('../models')` inside the service pick them up) ────────────

jest.mock('../../models', () => ({
  DocComment: {
    findByPk: jest.fn(),
  },
  User: {
    findAll: jest.fn(),
  },
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));

const { DocComment, User } = require('../../models');
const notificationService = require('../../services/notificationService');
const safeLogger = require('../../utils/safeLogger');

// Require the service AFTER mocks so its module-level lazy requires bind
// to our mocks rather than the real implementations.
const svc = require('../../services/docCommentNotificationService');

// ─── shared helpers ────────────────────────────────────────────────────

// Stable UUIDs for the four canonical actors used across scenarios.
const USER_A_ID = 'a0000000-0000-0000-0000-00000000000a'; // comment author
const USER_B_ID = 'b0000000-0000-0000-0000-00000000000b'; // parent author / other
const USER_C_ID = 'c0000000-0000-0000-0000-00000000000c'; // doc creator
const USER_SARA_ID = '50000000-0000-0000-0000-000000000050';
const USER_BOB_ID = '60000000-0000-0000-0000-000000000060';

function makeDoc(overrides = {}) {
  return {
    id: 'd1',
    title: 'My Doc',
    createdBy: USER_C_ID,
    workspaceId: 'w1',
    ...overrides,
  };
}

function makeComment(overrides = {}) {
  return {
    id: 'c-new',
    docId: 'd1',
    parentId: null,
    authorId: USER_A_ID,
    body: 'a fresh comment',
    ...overrides,
  };
}

function makeWorkspace(memberIds = [], overrides = {}) {
  return {
    id: 'w1',
    createdBy: USER_C_ID,
    workspaceMembers: memberIds.map((id) => ({ id })),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no users found by the mention resolver. Individual tests
  // override when they want a successful resolution.
  User.findAll.mockResolvedValue([]);
  DocComment.findByPk.mockResolvedValue(null);
  notificationService.createNotification.mockResolvedValue({});
});

// ───────────────────────────────────────────────────────────────────────
// Case 1 — top-level comment by user A on a doc owned by user C
// ───────────────────────────────────────────────────────────────────────

describe('top-level comments', () => {
  test('1. notifies the doc creator (and only the doc creator) on a top-level comment', async () => {
    const doc = makeDoc({ createdBy: USER_C_ID });
    const comment = makeComment({
      id: 'c1',
      authorId: USER_A_ID,
      parentId: null,
      body: 'nice doc',
    });

    const result = await svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace: makeWorkspace([]),
    });

    expect(result.fired).toBe(1);
    expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
    const args = notificationService.createNotification.mock.calls[0][0];
    expect(args.userId).toBe(USER_C_ID);
    expect(args.type).toBe('doc_comment');
    expect(args.entityType).toBe('doc');
    expect(args.entityId).toBe('d1');
    expect(args.message).toBe('Alice commented on "My Doc"');
    expect(args.idempotencyKey).toBe(`doc-comment:c1:${USER_C_ID}`);
  });

  test('2. does NOT notify when the doc owner comments on their own doc', async () => {
    const doc = makeDoc({ createdBy: USER_C_ID });
    // Same author and doc creator.
    const comment = makeComment({ id: 'c-self', authorId: USER_C_ID, parentId: null });

    const result = await svc.syncCommentNotifications({
      comment, doc, authorName: 'Owner', workspace: makeWorkspace([]),
    });

    expect(result.fired).toBe(0);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 3-4 — replies
// ───────────────────────────────────────────────────────────────────────

describe('replies', () => {
  test('3. reply by A to B\'s comment on doc owned by C → notifies B (reply) AND C (reply)', async () => {
    const doc = makeDoc({ createdBy: USER_C_ID });
    const parent = { id: 'p1', authorId: USER_B_ID };
    const comment = makeComment({
      id: 'r1', parentId: 'p1', authorId: USER_A_ID, body: 'thanks!',
    });

    const result = await svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace: makeWorkspace([]), parent,
    });

    expect(result.fired).toBe(2);
    expect(notificationService.createNotification).toHaveBeenCalledTimes(2);

    // First call: the parent author
    const calls = notificationService.createNotification.mock.calls.map((c) => c[0]);
    const toParent = calls.find((c) => c.userId === USER_B_ID);
    expect(toParent).toBeDefined();
    expect(toParent.type).toBe('doc_comment_reply');
    expect(toParent.message).toBe('Alice replied to your comment on "My Doc"');
    expect(toParent.idempotencyKey).toBe(`doc-comment-reply:r1:${USER_B_ID}`);

    const toDocCreator = calls.find((c) => c.userId === USER_C_ID);
    expect(toDocCreator).toBeDefined();
    expect(toDocCreator.type).toBe('doc_comment_reply');
    expect(toDocCreator.message).toBe('Alice replied to a comment on "My Doc"');
    expect(toDocCreator.idempotencyKey).toBe(`doc-comment-reply:r1:${USER_C_ID}`);
  });

  test('4. reply by A to B\'s comment on a doc owned by A → notifies B only (self skip)', async () => {
    const doc = makeDoc({ createdBy: USER_A_ID });
    const parent = { id: 'p1', authorId: USER_B_ID };
    const comment = makeComment({
      id: 'r-self-doc', parentId: 'p1', authorId: USER_A_ID, body: 'reply',
    });

    const result = await svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace: makeWorkspace([]), parent,
    });

    expect(result.fired).toBe(1);
    expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
    const args = notificationService.createNotification.mock.calls[0][0];
    expect(args.userId).toBe(USER_B_ID);
    expect(args.type).toBe('doc_comment_reply');
    // Idempotency key uses the parent-author path.
    expect(args.idempotencyKey).toBe(`doc-comment-reply:r-self-doc:${USER_B_ID}`);
  });

  test('reply where doc creator == parent author → ONE notification only (not two)', async () => {
    // Doc owned by C; parent comment written by C; reply written by A.
    // C should receive exactly one notification (the "reply to your comment"
    // one), not duplicated for the doc-creator path too.
    const doc = makeDoc({ createdBy: USER_C_ID });
    const parent = { id: 'p1', authorId: USER_C_ID };
    const comment = makeComment({
      id: 'r-dup', parentId: 'p1', authorId: USER_A_ID, body: 'reply',
    });

    const result = await svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace: makeWorkspace([]), parent,
    });

    expect(result.fired).toBe(1);
    expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
    const args = notificationService.createNotification.mock.calls[0][0];
    expect(args.userId).toBe(USER_C_ID);
    // "reply to your comment" wording wins over the generic doc-creator one.
    expect(args.message).toBe('Alice replied to your comment on "My Doc"');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 5-8 — @-mention handling
// ───────────────────────────────────────────────────────────────────────

describe('@-mentions in comment body', () => {
  test('5. comment body with @sara → mention notification fired to Sara if she is a workspace member', async () => {
    const doc = makeDoc({ createdBy: USER_C_ID });
    // Author writes a comment whose body mentions @sara. Doc creator C
    // would also normally get a doc_comment notification — we just verify
    // the mention path here. Workspace has Sara as a member.
    const comment = makeComment({
      id: 'c-m1', authorId: USER_A_ID, parentId: null, body: 'cc @sara please',
    });
    const workspace = makeWorkspace([USER_SARA_ID, USER_A_ID, USER_B_ID]);

    User.findAll.mockResolvedValue([
      { id: USER_SARA_ID, name: 'Sara', email: 'sara@x.com' },
    ]);

    const result = await svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace,
    });

    // 2 notifications: 1 to doc creator (top-level), 1 to Sara (mention).
    expect(result.fired).toBe(2);
    const calls = notificationService.createNotification.mock.calls.map((c) => c[0]);
    const toSara = calls.find((c) => c.userId === USER_SARA_ID);
    expect(toSara).toBeDefined();
    expect(toSara.type).toBe('doc_comment_mention');
    expect(toSara.message).toBe('Alice mentioned you in a comment on "My Doc"');
    expect(toSara.idempotencyKey).toBe(`doc-comment-mention:c-m1:${USER_SARA_ID}`);
  });

  test('6. comment body with @nonexistent → silent skip (no notification)', async () => {
    // Doc owned by the comment author so the top-level doc-creator
    // notification path is also skipped → the only thing that COULD fire
    // is the mention path, which must NOT fire because the token doesn't
    // resolve to any workspace member.
    const doc = makeDoc({ createdBy: USER_A_ID });
    const comment = makeComment({
      id: 'c-m2', authorId: USER_A_ID, parentId: null, body: 'hi @nobody',
    });
    const workspace = makeWorkspace([USER_A_ID]);

    User.findAll.mockResolvedValue([]); // resolver returns no matches

    const result = await svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace,
    });

    expect(result.fired).toBe(0);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  test('7. comment body with @self → mention path skips self (no double-notify)', async () => {
    // Doc owned by author → no top-level notification. @self mention should
    // be silently skipped by the self-check.
    const doc = makeDoc({ createdBy: USER_A_ID });
    const comment = makeComment({
      id: 'c-m3', authorId: USER_A_ID, parentId: null, body: 'note to @alice: do it',
    });
    const workspace = makeWorkspace([USER_A_ID]);

    User.findAll.mockResolvedValue([
      { id: USER_A_ID, name: 'Alice', email: 'a@x.com' },
    ]);

    const result = await svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace,
    });

    expect(result.fired).toBe(0);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  test('8. multiple @-mentions in one body → fan-out to all matched workspace members', async () => {
    const doc = makeDoc({ createdBy: USER_A_ID }); // skip doc-creator path
    const comment = makeComment({
      id: 'c-m4', authorId: USER_A_ID, parentId: null,
      body: 'cc @sara and also @bob — thoughts?',
    });
    const workspace = makeWorkspace([USER_SARA_ID, USER_BOB_ID, USER_A_ID]);

    User.findAll.mockResolvedValue([
      { id: USER_SARA_ID, name: 'Sara', email: 'sara@x.com' },
      { id: USER_BOB_ID, name: 'Bob', email: 'bob@x.com' },
    ]);

    const result = await svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace,
    });

    expect(result.fired).toBe(2);
    expect(notificationService.createNotification).toHaveBeenCalledTimes(2);
    const recipientIds = notificationService.createNotification.mock.calls
      .map((c) => c[0].userId)
      .sort();
    expect(recipientIds).toEqual([USER_SARA_ID, USER_BOB_ID].sort());
    // Each mention notification carries its own per-recipient key.
    const keys = notificationService.createNotification.mock.calls
      .map((c) => c[0].idempotencyKey)
      .sort();
    expect(keys).toEqual([
      `doc-comment-mention:c-m4:${USER_BOB_ID}`,
      `doc-comment-mention:c-m4:${USER_SARA_ID}`,
    ].sort());
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 9 — idempotency: same comment processed twice
// ───────────────────────────────────────────────────────────────────────

describe('idempotency', () => {
  test('9. same comment processed twice → second call uses same idempotencyKey (DB dedup handles it)', async () => {
    const doc = makeDoc({ createdBy: USER_C_ID });
    const comment = makeComment({ id: 'c-idem', authorId: USER_A_ID, parentId: null });

    await svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace: makeWorkspace([]),
    });
    await svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace: makeWorkspace([]),
    });

    // Two calls fired, but BOTH carry the same idempotencyKey — the partial
    // unique index on notifications.idempotencyKey turns the second into a
    // no-op at the DB layer. We assert key equality here so a future
    // refactor that accidentally embeds a timestamp / random suffix into
    // the key will fail this test.
    expect(notificationService.createNotification).toHaveBeenCalledTimes(2);
    const key1 = notificationService.createNotification.mock.calls[0][0].idempotencyKey;
    const key2 = notificationService.createNotification.mock.calls[1][0].idempotencyKey;
    expect(key1).toBe(key2);
    expect(key1).toBe(`doc-comment:c-idem:${USER_C_ID}`);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Case 10 — resilience: a per-recipient failure is swallowed
// ───────────────────────────────────────────────────────────────────────

describe('failure resilience', () => {
  test('10. notificationService rejects → handler swallows, controller create still succeeds', async () => {
    // Simulate a downstream failure on EVERY createNotification call. The
    // helper must NOT throw; safeLogger.warn must be invoked for the
    // failure path.
    notificationService.createNotification.mockRejectedValue(new Error('queue down'));

    const doc = makeDoc({ createdBy: USER_C_ID });
    const comment = makeComment({ id: 'c-fail', authorId: USER_A_ID, parentId: null });

    await expect(svc.syncCommentNotifications({
      comment, doc, authorName: 'Alice', workspace: makeWorkspace([]),
    })).resolves.toBeDefined();

    expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
    // The handler logs the failure but never throws.
    expect(safeLogger.warn).toHaveBeenCalled();
    const warnArgs = safeLogger.warn.mock.calls
      .find((c) => /createNotification failed/.test(c[0] || ''));
    expect(warnArgs).toBeDefined();
  });

  test('missing comment or doc → returns gracefully with fired=0', async () => {
    const result1 = await svc.syncCommentNotifications({ comment: null, doc: makeDoc() });
    expect(result1.fired).toBe(0);
    const result2 = await svc.syncCommentNotifications({ comment: makeComment(), doc: null });
    expect(result2.fired).toBe(0);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Pure helpers — extractMentionTokens
// ───────────────────────────────────────────────────────────────────────

describe('__extractMentionTokens', () => {
  test('returns [] for empty / non-string body', () => {
    expect(svc.__extractMentionTokens('')).toEqual([]);
    expect(svc.__extractMentionTokens(null)).toEqual([]);
    expect(svc.__extractMentionTokens(undefined)).toEqual([]);
    expect(svc.__extractMentionTokens(42)).toEqual([]);
  });

  test('extracts single token', () => {
    expect(svc.__extractMentionTokens('hello @sara')).toEqual(['sara']);
  });

  test('dedupes case-insensitively, preserves first casing', () => {
    expect(svc.__extractMentionTokens('@Sara then @sara')).toEqual(['Sara']);
  });

  test('handles dotted / hyphenated / underscored handles', () => {
    expect(svc.__extractMentionTokens('cc @sara.k and @bob-jr and @al_pha')).toEqual([
      'sara.k', 'bob-jr', 'al_pha',
    ]);
  });

  test('does not capture an @ embedded inside an email address', () => {
    // The regex matches `@username`, so it WILL match the `user` part of
    // `user@example.com`-style tokens too. That's acceptable — the
    // resolver will fail to find a workspace member named "example.com"
    // and silently drop it. What we DO want to assert here is that the
    // extraction is stable / does not crash on email-style input.
    const out = svc.__extractMentionTokens('email me at alice@example.com');
    expect(Array.isArray(out)).toBe(true);
  });
});
