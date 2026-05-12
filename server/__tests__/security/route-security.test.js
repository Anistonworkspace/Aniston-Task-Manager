'use strict';

/**
 * Security regression tests for the API security remediation.
 *
 * These tests verify that:
 * 1. Webhook endpoints reject requests without valid API key
 * 2. Board export enforces board-level authorization
 * 3. Director plan/dashboard/org-chart enforce role restrictions
 * 4. Help request status update checks involvement/role
 * 5. Label CRUD restricts write ops to manager+
 * 6. Teams OAuth callback validates signed state
 * 7. SQL utility rejects invalid UUIDs
 * 8. Intentionally public endpoints remain accessible
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

// ─── Common mocks ────────────────────────────────────────────────────────────

const mockModels = {
  Board: { findByPk: jest.fn(), findAll: jest.fn(), findAndCountAll: jest.fn(), create: jest.fn() },
  User: { findByPk: jest.fn(), findAll: jest.fn(), update: jest.fn(), count: jest.fn() },
  Task: { findAll: jest.fn(), findByPk: jest.fn(), create: jest.fn(), max: jest.fn() },
  Notification: { create: jest.fn() },
  HelpRequest: { findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn() },
  Label: { findAll: jest.fn(), findByPk: jest.fn(), create: jest.fn(), destroy: jest.fn() },
  TaskLabel: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), destroy: jest.fn() },
  Workspace: {},
  TaskOwner: { findOne: jest.fn() },
  TaskAssignee: { findOne: jest.fn(), count: jest.fn() },
  TaskDependency: {},
  PromotionHistory: { findAll: jest.fn() },
  HierarchyLevel: { findAll: jest.fn() },
  ManagerRelation: { findAll: jest.fn() },
  PermissionGrant: { findAll: jest.fn().mockResolvedValue([]) },
  RefreshToken: { findByPk: jest.fn().mockResolvedValue(null), findOne: jest.fn(), create: jest.fn() },
  PendingLoginToken: { findOne: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
  sequelize: {
    fn: jest.fn(),
    col: jest.fn(),
    query: jest.fn().mockResolvedValue([[], {}]),
    literal: jest.fn(sql => ({ val: sql })),
  },
};

jest.mock('../../models', () => mockModels);

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToUser: jest.fn(),
  broadcastAll: jest.fn(),
  forceUserLeaveBoard: jest.fn(),
  disconnectUser: jest.fn().mockResolvedValue(0),
  getIO: jest.fn(() => ({ emit: jest.fn(), to: jest.fn(() => ({ emit: jest.fn() })) })),
}));

jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));

jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(null),
  buildIdempotencyKey: jest.fn(() => 'idem-key'),
}));

jest.mock('../../services/hierarchyService', () => ({
  getDescendantIds: jest.fn().mockResolvedValue([]),
  getAncestorIds: jest.fn().mockResolvedValue([]),
}));

// boardVisibilityService — board export and listing path.
// canUserSeeBoard returns false by default so unauthorized members are
// rejected; tests that want a manager to be allowed override it inline.
jest.mock('../../services/boardVisibilityService', () => ({
  canUserSeeBoard: jest.fn().mockResolvedValue(false),
  getVisibleBoardIdsForUser: jest.fn().mockResolvedValue([]),
  buildBoardVisibilityWhere: jest.fn().mockResolvedValue({}),
  filterVisibleBoardIds: jest.fn(async (_user, ids) => ids || []),
  buildVisibleBoardIds: jest.fn(async (_user, ids) => ids || []),
}));

jest.mock('../../services/boardMembershipService', () => ({
  syncBoardMembersFromTaskAssignments: jest.fn(),
}));

jest.mock('../../services/taskVisibilityService', () => ({
  canUserSeeTask: jest.fn().mockResolvedValue(false),
  canViewTask: jest.fn().mockResolvedValue(false),
  buildTaskVisibilityWhere: jest.fn(async () => ({})),
  isUnrestrictedTaskViewer: jest.fn(() => false),
  getVisibleTaskIdsForUser: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../utils/sanitize', () => ({
  sanitizeInput: jest.fn(v => v),
  sanitizeRichText: jest.fn(v => v),
  sanitizeNotificationField: jest.fn(v => v),
  sanitizeNotificationMessage: jest.fn(v => v),
}));

jest.mock('../../services/teamsWebhook', () => ({ sendTeamsNotification: jest.fn() }));

jest.mock('../../utils/archiveHelpers', () => ({
  canPermanentlyDelete: jest.fn(() => ({ allowed: true })),
  getProtectionInfo: jest.fn(() => ({})),
}));

jest.mock('../../utils/statusConfig', () => ({
  isValidStatus: jest.fn(() => true),
}));

jest.mock('../../utils/taskPrioritization', () => ({
  buildPendingPriorityOrder: jest.fn(() => [['createdAt', 'DESC']]),
  buildPendingPriorityOrderAliased: jest.fn(() => [['createdAt', 'DESC']]),
}));

jest.mock('../../config/teams', () => ({
  getTeamsConfig: jest.fn().mockResolvedValue({
    isConfigured: true,
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    tenantId: 'test-tenant',
    authUrl: 'https://login.microsoftonline.com/test-tenant/oauth2/v2.0',
    redirectUri: 'http://localhost:5000/api/teams/callback',
    scopes: ['Calendars.ReadWrite'],
  }),
}));

// teamsTokenStorage — encrypts OAuth tokens at rest. Stub so routes/teams.js
// can be required without an encryption key configured.
jest.mock('../../utils/teamsTokenStorage', () => ({
  encryptTeamsToken: jest.fn(v => v),
  decryptTeamsTokenSafe: jest.fn(v => v),
}));

// permissionEngine — used by middleware/permissions (requirePermission) and
// requireRole's Layer-3 fallback. Default deny so role-based negatives don't
// accidentally pass.
jest.mock('../../services/permissionEngine', () => ({
  computeEffectivePermissions: jest.fn().mockResolvedValue({
    permissions: {}, basePermissions: {}, overrides: [], denials: [],
    grants: [], role: 'member', isSuperAdmin: false,
  }),
  hasPermission: jest.fn().mockResolvedValue(false),
  getEffectiveBasePermission: jest.fn(() => false),
  getEffectiveBasePermissions: jest.fn(() => ({})),
}));

jest.mock('../../controllers/managerRelationController', () => ({
  getRelationsForEmployee: jest.fn((req, res) => res.json({ success: true })),
  addRelation: jest.fn((req, res) => res.json({ success: true })),
  updateRelation: jest.fn((req, res) => res.json({ success: true })),
  removeRelation: jest.fn((req, res) => res.json({ success: true })),
  syncFromManagerId: jest.fn((req, res) => res.json({ success: true })),
}));

jest.mock('../../services/pushService', () => ({
  saveSubscription: jest.fn(),
  deactivateSubscription: jest.fn().mockResolvedValue(0),
  deactivateAllForUser: jest.fn().mockResolvedValue(0),
  removeSubscription: jest.fn(),
  deleteByEndpoint: jest.fn(),
  sendPushToUser: jest.fn(),
  vapidPublicKey: 'test-vapid-public-key',
  pushConfigured: false,
}));

// ─── App setup ───────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOARD_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_USER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function generateToken(userId, role = 'member') {
  return jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function makeUser(overrides = {}) {
  return {
    id: USER_ID, name: 'Test User', email: 'test@aniston.com',
    role: 'member', isActive: true, isSuperAdmin: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. WEBHOOK SECURITY
// ═══════════════════════════════════════════════════════════════════════════

describe('Webhook security (webhooks.js)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/webhooks', require('../../routes/webhooks'));
  });

  it('rejects all requests when WEBHOOK_API_KEY is not set', async () => {
    delete process.env.WEBHOOK_API_KEY;
    const res = await request(app).get('/api/webhooks/n8n/boards');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });

  it('rejects requests with missing API key header', async () => {
    process.env.WEBHOOK_API_KEY = 'test-webhook-key';
    const res = await request(app).get('/api/webhooks/n8n/boards');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects requests with wrong API key', async () => {
    process.env.WEBHOOK_API_KEY = 'test-webhook-key';
    const res = await request(app)
      .get('/api/webhooks/n8n/boards')
      .set('x-webhook-key', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('accepts requests with correct API key', async () => {
    process.env.WEBHOOK_API_KEY = 'test-webhook-key';
    mockModels.Board.findAll.mockResolvedValue([]);
    const res = await request(app)
      .get('/api/webhooks/n8n/boards')
      .set('x-webhook-key', 'test-webhook-key');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('no longer has dev bypass — rejects in all environments without key', async () => {
    delete process.env.WEBHOOK_API_KEY;
    process.env.NODE_ENV = 'development';
    const res = await request(app)
      .post('/api/webhooks/n8n/task-created')
      .send({ title: 'test', boardId: BOARD_ID });
    expect(res.status).toBe(503);
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    delete process.env.WEBHOOK_API_KEY;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. BOARD EXPORT AUTHORIZATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Board export authorization (boards.js)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/boards', require('../../routes/boards'));
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get(`/api/boards/${BOARD_ID}/export`);
    expect(res.status).toBe(401);
  });

  it('rejects member who is not on the board', async () => {
    const memberUser = makeUser({ role: 'member' });
    mockModels.User.findByPk.mockResolvedValue(memberUser);
    mockModels.Board.findByPk.mockResolvedValue({
      id: BOARD_ID,
      createdBy: OTHER_USER,
      members: [],
      toJSON: () => ({ id: BOARD_ID }),
    });
    mockModels.TaskAssignee.count.mockResolvedValue(0);
    // boardVisibilityService.canUserSeeBoard returns false by default — that
    // is what the controller checks now.
    const boardVis = require('../../services/boardVisibilityService');
    boardVis.canUserSeeBoard.mockResolvedValue(false);

    const token = generateToken(USER_ID, 'member');
    const res = await request(app)
      .get(`/api/boards/${BOARD_ID}/export`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('allows manager to export any board', async () => {
    const mgrUser = makeUser({ role: 'manager' });
    mockModels.User.findByPk.mockResolvedValue(mgrUser);
    mockModels.Board.findByPk.mockResolvedValue({
      id: BOARD_ID,
      name: 'Test Board',
      createdBy: OTHER_USER,
      members: [{ id: OTHER_USER }],
      toJSON: () => ({ id: BOARD_ID }),
    });
    mockModels.Task.findAll.mockResolvedValue([]);
    // Manager passes the visibility check.
    const boardVis = require('../../services/boardVisibilityService');
    boardVis.canUserSeeBoard.mockResolvedValue(true);

    const token = generateToken(USER_ID, 'manager');
    const res = await request(app)
      .get(`/api/boards/${BOARD_ID}/export`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. ORG CHART ROLE RESTRICTION
// ═══════════════════════════════════════════════════════════════════════════
//
// Note: the production /org-chart route is now gated by both `managerOrAdmin`
// (legacy fast-path) AND `requirePermission('org_chart', 'view')` (granular
// engine). The legacy guard catches the unauthorised member case first, so
// we still assert 403 for members. For the positive path we just verify the
// route is reachable (not 403).

describe('Org chart role restriction (promotions.js)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/promotions', require('../../routes/promotions'));
  });

  it('rejects member from accessing /org-chart', async () => {
    mockModels.User.findByPk.mockResolvedValue(makeUser({ role: 'member' }));
    const token = generateToken(USER_ID, 'member');
    const res = await request(app)
      .get('/api/promotions/org-chart')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('allows manager to access /org-chart', async () => {
    mockModels.User.findByPk.mockResolvedValue(makeUser({ role: 'manager' }));
    mockModels.User.findAll.mockResolvedValue([]);
    // requirePermission('org_chart','view') will consult hasPermission;
    // make it allow for this test.
    const pe = require('../../services/permissionEngine');
    pe.hasPermission.mockResolvedValue(true);
    const token = generateToken(USER_ID, 'manager');
    const res = await request(app)
      .get('/api/promotions/org-chart')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. LABEL CRUD ROLE RESTRICTION
// ═══════════════════════════════════════════════════════════════════════════

describe('Label CRUD role restriction (labels.js)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/labels', require('../../routes/labels'));
  });

  it('allows member to read labels on a board they can see', async () => {
    // P0-6: getLabels now requires canUserSeeBoard for board-scoped queries.
    // A member who is a board member is allowed to read its labels.
    const boardVisibility = require('../../services/boardVisibilityService');
    boardVisibility.canUserSeeBoard.mockResolvedValue(true);
    mockModels.User.findByPk.mockResolvedValue(makeUser({ role: 'member' }));
    mockModels.Label.findAll = jest.fn().mockResolvedValue([]);
    const token = generateToken(USER_ID, 'member');
    const res = await request(app)
      .get('/api/labels?boardId=' + BOARD_ID)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });

  it('rejects member from reading labels on a board they cannot see', async () => {
    // P0-6 enforcement: when the visibility gate denies, return 403.
    const boardVisibility = require('../../services/boardVisibilityService');
    boardVisibility.canUserSeeBoard.mockResolvedValue(false);
    mockModels.User.findByPk.mockResolvedValue(makeUser({ role: 'member' }));
    const token = generateToken(USER_ID, 'member');
    const res = await request(app)
      .get('/api/labels?boardId=' + BOARD_ID)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('rejects member from creating a BOARD-LIBRARY label (no assignToTaskId)', async () => {
    // Post-May-12 RBAC widening: members CAN create labels when they're
    // attaching one to a task they can see (the task-scoped path tested
    // below). What they cannot do is mint a stand-alone "library" label on
    // a board they don't manage — that's still the audit's S-H6 boundary.
    mockModels.User.findByPk.mockResolvedValue(makeUser({ role: 'member' }));
    mockModels.Board.findByPk.mockResolvedValue({ id: BOARD_ID, createdBy: 'someone-else' });
    const token = generateToken(USER_ID, 'member');
    const res = await request(app)
      .post('/api/labels')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bug', color: '#ff0000', boardId: BOARD_ID });
    expect(res.status).toBe(403);
  });

  it('rejects member from deleting labels', async () => {
    mockModels.User.findByPk.mockResolvedValue(makeUser({ role: 'member' }));
    const token = generateToken(USER_ID, 'member');
    const res = await request(app)
      .delete('/api/labels/some-label-id')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('allows manager to create labels on a board they own', async () => {
    // S-H6 — managers can manage labels only on boards they created
    // (or globally as admin). This test now supplies the board with
    // createdBy === USER_ID so the canManageBoard gate passes.
    mockModels.User.findByPk.mockResolvedValue(makeUser({ role: 'manager' }));
    mockModels.Board.findByPk.mockResolvedValue({ id: BOARD_ID, createdBy: USER_ID });
    mockModels.Label.create = jest.fn().mockResolvedValue({ id: 'lbl-1', name: 'Bug' });
    const token = generateToken(USER_ID, 'manager');
    const res = await request(app)
      .post('/api/labels')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bug', color: '#ff0000', boardId: BOARD_ID });
    expect(res.status).not.toBe(403);
  });

  it('rejects manager from creating labels on a board they do not own', async () => {
    // S-H6 — the second line of defence: a manager passes the
    // managerOrAdmin route gate but the controller-level canManageBoard
    // check denies because they aren't the board creator.
    mockModels.User.findByPk.mockResolvedValue(makeUser({ role: 'manager' }));
    mockModels.Board.findByPk.mockResolvedValue({ id: BOARD_ID, createdBy: 'someone-else' });
    const token = generateToken(USER_ID, 'manager');
    const res = await request(app)
      .post('/api/labels')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bug', color: '#ff0000', boardId: BOARD_ID });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. TEAMS OAUTH STATE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Teams OAuth state validation (teams.js)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/teams', require('../../routes/teams'));
  });

  it('rejects callback with missing state', async () => {
    const res = await request(app)
      .get('/api/teams/callback?code=test-code');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('teams=error');
    expect(res.headers.location).toContain('missing_params');
  });

  it('rejects callback with tampered/unsigned state', async () => {
    const fakeState = Buffer.from(JSON.stringify({ userId: USER_ID })).toString('base64');
    const res = await request(app)
      .get(`/api/teams/callback?code=test-code&state=${fakeState}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('invalid_state');
  });

  it('rejects callback with forged HMAC', async () => {
    const data = Buffer.from(JSON.stringify({ userId: USER_ID, ts: Date.now() })).toString('base64');
    const fakeHmac = 'a'.repeat(64);
    const res = await request(app)
      .get(`/api/teams/callback?code=test-code&state=${data}.${fakeHmac}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('invalid_state');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. SQL SAFETY UTILITY
// ═══════════════════════════════════════════════════════════════════════════

describe('SQL safety utility (safeSql.js)', () => {
  const { assertUUID, safeUUID, safeUUIDList } = require('../../utils/safeSql');

  it('accepts valid UUIDs', () => {
    expect(() => assertUUID('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).not.toThrow();
    expect(safeUUID('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe("'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'");
  });

  it('rejects SQL injection attempt', () => {
    expect(() => assertUUID("'; DROP TABLE users; --")).toThrow('[SafeSQL]');
  });

  it('rejects empty string', () => {
    expect(() => assertUUID('')).toThrow('[SafeSQL]');
  });

  it('rejects non-string input', () => {
    expect(() => assertUUID(null)).toThrow('[SafeSQL]');
    expect(() => assertUUID(undefined)).toThrow('[SafeSQL]');
    expect(() => assertUUID(123)).toThrow('[SafeSQL]');
  });

  it('builds safe UUID list', () => {
    const list = safeUUIDList([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    ]);
    expect(list).toBe("'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'");
  });

  it('rejects list with any invalid UUID', () => {
    expect(() => safeUUIDList(['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'not-a-uuid'])).toThrow('[SafeSQL]');
  });

  it('rejects empty list', () => {
    expect(() => safeUUIDList([])).toThrow('[SafeSQL]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. INTENTIONALLY PUBLIC ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Intentionally public endpoints', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/push', require('../../routes/push'));
  });

  it('VAPID key endpoint is accessible without auth', async () => {
    const res = await request(app).get('/api/push/vapid-key');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('publicKey');
  });

  it('VAPID key endpoint does not expose secrets', async () => {
    const res = await request(app).get('/api/push/vapid-key');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('private');
    expect(body).not.toContain('secret');
  });
});
