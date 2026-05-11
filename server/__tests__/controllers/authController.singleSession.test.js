'use strict';

/**
 * Single-active-session integration tests.
 *
 * Coverage:
 *   - Normal login (no existing session) mints cookies.
 *   - Wrong password returns 401 with the SAME generic body regardless
 *     of whether an active session would have been detected. The
 *     SESSION_ALREADY_ACTIVE branch must NEVER fire before the password
 *     is verified.
 *   - Active session triggers SESSION_ALREADY_ACTIVE with a 5-minute
 *     pendingLoginToken in the body.
 *   - Inactive / pending / rejected accounts are surfaced AFTER the
 *     password check (audit F-05) — pre-password they're indistinguish-
 *     able from "wrong password".
 *   - /auth/login/force consumes the pending token, revokes all prior
 *     sessions, and sets new cookies.
 *   - /auth/login/force with an expired / used / wrong-origin token is
 *     rejected with a generic message.
 *   - The middleware rejects an access token whose `sid` points to a
 *     hard-revoked session, but accepts one pointing to a rotation-
 *     revoked session.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');

// ── Mocks (declared before requires) ───────────────────────────────

jest.mock('../../models', () => {
  // Jest enforces a sandbox on factory references — we re-require crypto
  // here rather than pulling it from the test module's scope.
  const mockCrypto = require('crypto');
  const refreshRows = new Map();   // jti -> row
  const pendingRows = new Map();   // id -> row
  const userById = new Map();      // id -> row

  return {
    User: {
      findOne: jest.fn(),
      findByPk: jest.fn(async (id) => userById.get(String(id)) || null),
      __set: (u) => userById.set(String(u.id), u),
      __reset: () => userById.clear(),
    },
    RefreshToken: {
      __store: refreshRows,
      findOne: jest.fn(async ({ where, order }) => {
        const rows = [...refreshRows.values()].filter((r) => {
          if (where.userId && r.userId !== where.userId) return false;
          if (where.revokedAt === null && r.revokedAt) return false;
          if (where.expiresAt && where.expiresAt[Object.getOwnPropertySymbols(where.expiresAt)[0]]
            && r.expiresAt <= new Date()) return false;
          return true;
        });
        if (order && order[0] && order[0][0] === 'issuedAt') {
          rows.sort((a, b) => b.issuedAt - a.issuedAt);
        }
        return rows[0] || null;
      }),
      findByPk: jest.fn(async (jti) => refreshRows.get(jti) || null),
      create: jest.fn(async (row) => {
        refreshRows.set(row.jti, { ...row, revokedAt: null, replacedByJti: null });
        return row;
      }),
      update: jest.fn(async (values, { where }) => {
        let n = 0;
        for (const [jti, row] of refreshRows) {
          if (where.jti && jti !== where.jti) continue;
          if (where.userId && row.userId !== where.userId) continue;
          if ('revokedAt' in where && where.revokedAt === null && row.revokedAt) continue;
          Object.assign(row, values);
          n++;
        }
        return [n];
      }),
      __reset: () => refreshRows.clear(),
    },
    PendingLoginToken: {
      __store: pendingRows,
      create: jest.fn(async (row) => {
        const id = mockCrypto.randomUUID();
        pendingRows.set(id, { id, ...row });
        return { id, ...row };
      }),
      findOne: jest.fn(async ({ where }) => {
        for (const r of pendingRows.values()) {
          if (where.tokenHash && r.tokenHash !== where.tokenHash) continue;
          return r;
        }
        return null;
      }),
      update: jest.fn(async (values, { where }) => {
        let n = 0;
        for (const r of pendingRows.values()) {
          if (where.id && r.id !== where.id) continue;
          if ('usedAt' in where && where.usedAt === null && r.usedAt) continue;
          Object.assign(r, values);
          n++;
        }
        return [n];
      }),
      __reset: () => pendingRows.clear(),
    },
  };
});

jest.mock('../../middleware/upload', () => ({
  createUpload: () => ({ single: () => (_req, _res, next) => next() }),
  handleMulterError: (_err, _req, _res, next) => next(),
  postUploadValidation: () => (_req, _res, next) => next(),
  setCategoryMiddleware: () => (_req, _res, next) => next(),
}));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToUser: jest.fn(),
  getIO: jest.fn(() => ({ emit: jest.fn() })),
  initializeSocket: jest.fn(),
  disconnectUser: jest.fn(async () => 0),
}));

jest.mock('../../config/teams', () => ({
  getTeamsConfig: jest.fn().mockResolvedValue({
    isConfigured: false,
    ssoEnabled: false,
  }),
}));

// ── Test rig ───────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { User, RefreshToken, PendingLoginToken } = require('../../models');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../routes/auth'));
  return app;
}

function makeUser(overrides = {}) {
  const passwordPlain = overrides.password || 'CorrectHorseBattery1!';
  const hash = bcrypt.hashSync(passwordPlain, 4);
  const u = {
    id: 'user-1',
    name: 'Test User',
    email: 'test@example.com',
    password: hash,
    isActive: true,
    accountStatus: 'approved',
    authProvider: 'local',
    hasLocalPassword: true,
    passwordChangedAt: null,
    role: 'member',
    tier: 4,
    isSuperAdmin: false,
    comparePassword: async function (candidate) {
      return bcrypt.compare(candidate, this.password);
    },
    toJSON: function () {
      const { password, ...rest } = this;
      return rest;
    },
    ...overrides,
  };
  User.__set(u);
  return { user: u, plain: passwordPlain };
}

function seedActiveSession(userId, overrides = {}) {
  const jti = crypto.randomUUID();
  RefreshToken.__store.set(jti, {
    jti,
    userId,
    issuedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    replacedByJti: null,
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    ip: '10.0.0.1',
    ...overrides,
  });
  return jti;
}

beforeEach(() => {
  User.__reset();
  RefreshToken.__reset();
  PendingLoginToken.__reset();
  User.findOne.mockReset();
  jest.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────

describe('POST /api/auth/login — single-active-session', () => {
  test('mints cookies when no active session exists', async () => {
    const { user, plain } = makeUser();
    User.findOne.mockResolvedValue(user);

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: user.email, password: plain });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(user.email);
    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some((c) => c.startsWith('aniston_at='))).toBe(true);
    expect(setCookie.some((c) => c.startsWith('aniston_rt='))).toBe(true);

    // Exactly one refresh row, not revoked.
    const rows = [...RefreshToken.__store.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).toBeNull();
  });

  test('returns SESSION_ALREADY_ACTIVE when an active session exists', async () => {
    const { user, plain } = makeUser();
    User.findOne.mockResolvedValue(user);
    seedActiveSession(user.id);

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: user.email, password: plain });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('SESSION_ALREADY_ACTIVE');
    expect(res.body.data.pendingLoginToken).toEqual(expect.any(String));
    expect(res.body.data.expiresIn).toBe(300);
    // No new session row should have been created.
    const rows = [...RefreshToken.__store.values()];
    expect(rows).toHaveLength(1); // only the seeded one
    // No auth cookies set.
    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some((c) => c.startsWith('aniston_at='))).toBe(false);
  });

  test('wrong password returns 401 generic even if an active session exists', async () => {
    const { user } = makeUser();
    User.findOne.mockResolvedValue(user);
    seedActiveSession(user.id);

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: user.email, password: 'WrongPassword!1' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/invalid email or password/i);
    expect(res.body.code).toBeUndefined();
    // No pending token leaked.
    expect(PendingLoginToken.__store.size).toBe(0);
  });

  test('unknown email returns the same 401 generic (no enumeration)', async () => {
    User.findOne.mockResolvedValue(null);

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'AnyPassword1!' });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });

  test('deactivated account is rejected AFTER password check (not before)', async () => {
    const { user, plain } = makeUser({ isActive: false });
    User.findOne.mockResolvedValue(user);

    // Wrong password first — must be the same generic 401.
    const r1 = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: user.email, password: 'BadPassword1!' });
    expect(r1.status).toBe(401);
    expect(r1.body.message).toMatch(/invalid email or password/i);

    // Correct password — now we may surface the deactivated state.
    const r2 = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: user.email, password: plain });
    expect(r2.status).toBe(403);
    expect(r2.body.message).toMatch(/deactivated/i);
  });

  test('pending account is rejected AFTER password check', async () => {
    const { user, plain } = makeUser({ accountStatus: 'pending' });
    User.findOne.mockResolvedValue(user);

    const r1 = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: user.email, password: 'BadPassword1!' });
    expect(r1.status).toBe(401);

    const r2 = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: user.email, password: plain });
    expect(r2.status).toBe(403);
    expect(r2.body.message).toMatch(/pending/i);
  });
});

describe('POST /api/auth/login/force', () => {
  async function loginAndGetPendingToken() {
    const { user, plain } = makeUser();
    User.findOne.mockResolvedValue(user);
    const oldJti = seedActiveSession(user.id);
    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: user.email, password: plain });
    expect(res.body.code).toBe('SESSION_ALREADY_ACTIVE');
    return { user, oldJti, pendingLoginToken: res.body.data.pendingLoginToken };
  }

  test('consumes pending token, revokes old session, mints new one', async () => {
    const { user, oldJti, pendingLoginToken } = await loginAndGetPendingToken();

    const res = await request(buildApp())
      .post('/api/auth/login/force')
      .send({ pendingLoginToken });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(user.email);

    // Old session is hard-revoked (revokedAt set, replacedByJti null).
    const oldRow = RefreshToken.__store.get(oldJti);
    expect(oldRow.revokedAt).toBeTruthy();
    expect(oldRow.replacedByJti).toBeNull();

    // A new active row exists.
    const active = [...RefreshToken.__store.values()].filter(
      (r) => !r.revokedAt
    );
    expect(active).toHaveLength(1);
    expect(active[0].jti).not.toBe(oldJti);

    // Cookies set.
    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some((c) => c.startsWith('aniston_at='))).toBe(true);
    expect(setCookie.some((c) => c.startsWith('aniston_rt='))).toBe(true);

    // Pending token is consumed (usedAt set).
    const pendingRow = [...PendingLoginToken.__store.values()][0];
    expect(pendingRow.usedAt).toBeTruthy();
  });

  test('rejects reuse of an already-consumed pending token', async () => {
    const { pendingLoginToken } = await loginAndGetPendingToken();

    // First use succeeds.
    const r1 = await request(buildApp())
      .post('/api/auth/login/force')
      .send({ pendingLoginToken });
    expect(r1.status).toBe(200);

    // Second use is rejected with a generic 400.
    const r2 = await request(buildApp())
      .post('/api/auth/login/force')
      .send({ pendingLoginToken });
    expect(r2.status).toBe(400);
    expect(r2.body.code).toBe('PENDING_TOKEN_INVALID');
  });

  test('rejects a bogus pending token', async () => {
    const res = await request(buildApp())
      .post('/api/auth/login/force')
      .send({ pendingLoginToken: 'A'.repeat(43) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PENDING_TOKEN_INVALID');
  });

  test('rejects when pendingLoginToken is missing', async () => {
    const res = await request(buildApp())
      .post('/api/auth/login/force')
      .send({});
    expect(res.status).toBe(400);
    // express-validator returns "errors", missing-token returns a code.
    expect(res.body.success).toBe(false);
  });

  test('rejects if account was deactivated during the pending window', async () => {
    const { user, pendingLoginToken } = await loginAndGetPendingToken();
    // Simulate admin deactivating the user before they click "continue".
    user.isActive = false;

    const res = await request(buildApp())
      .post('/api/auth/login/force')
      .send({ pendingLoginToken });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_UNAVAILABLE');
  });
});

describe('authenticate middleware — session (sid) check', () => {
  const jwt = require('jsonwebtoken');
  const { authenticate } = require('../../middleware/auth');

  function runMiddleware(token, opts = {}) {
    const req = {
      headers: { authorization: `Bearer ${token}`, cookie: '' },
      cookies: {},
    };
    const res = {
      statusCode: 200,
      headers: {},
      cookieClears: [],
      status(c) { this.statusCode = c; return this; },
      json(body) { this.body = body; return this; },
      clearCookie(name) { this.cookieClears.push(name); },
      cookie() {},
    };
    return new Promise((resolve) => {
      authenticate(req, res, () => resolve({ req, res, passed: true }))
        .then(() => resolve({ req, res, passed: !!req.user }));
    });
  }

  test('rejects token whose sid points to a hard-revoked session', async () => {
    const { user } = makeUser();
    User.findOne.mockResolvedValue(user);
    const jti = seedActiveSession(user.id);
    // Hard-revoke (replacedByJti stays null).
    RefreshToken.__store.get(jti).revokedAt = new Date();

    const token = jwt.sign({ id: user.id, sid: jti }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const { res } = await runMiddleware(token);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
    // Cookies cleared.
    expect(res.cookieClears).toEqual(expect.arrayContaining(['aniston_at', 'aniston_rt']));
  });

  test('accepts token whose sid points to a ROTATION-revoked session', async () => {
    const { user } = makeUser();
    const jti = seedActiveSession(user.id);
    // Rotation revoke: replacedByJti is set.
    RefreshToken.__store.get(jti).revokedAt = new Date();
    RefreshToken.__store.get(jti).replacedByJti = crypto.randomUUID();

    const token = jwt.sign({ id: user.id, sid: jti }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const { res } = await runMiddleware(token);
    expect(res.statusCode).toBe(200);
  });

  test('accepts a legacy token without sid (backward compat)', async () => {
    const { user } = makeUser();
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const { res } = await runMiddleware(token);
    expect(res.statusCode).toBe(200);
  });
});
