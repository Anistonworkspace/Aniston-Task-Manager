'use strict';

/**
 * Integration tests for the auth API endpoints.
 *
 * A minimal Express app is assembled from the real route file so the
 * validator middleware, controller logic, and routing all exercise the same
 * code path as production.  The database layer (User model) and JWT are
 * mocked so no real DB connection is required.
 *
 * NOTE — Production behavior reflected here (recent platform changes):
 *   - Public /register is intentionally DISABLED — returns 403 with a
 *     message about contacting an administrator. The body of these tests
 *     asserts that behaviour rather than the old open-registration flow.
 *   - Login returns a generic 401 "Invalid email or password" for unknown
 *     email or wrong password (timing-attack mitigation). Status-specific
 *     403 responses (deactivated / pending / rejected) only fire AFTER
 *     password verification succeeds.
 *   - Login no longer returns `token`/`refreshToken` in the body; it sets
 *     httpOnly cookies via establishSession. We assert on the user payload
 *     instead and on the Set-Cookie header presence.
 *   - Forgot-password generates a random crypto token (not a JWT) and only
 *     returns the reset URL when NODE_ENV === 'development'.
 *   - Reset-password validates a hashed-DB token (not a JWT). Tests use
 *     User.findOne to simulate the token lookup.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

// ─── Mocks (must be declared before any require of the mocked modules) ───────

jest.mock('../../models', () => ({
  User: {
    findOne: jest.fn(),
    findByPk: jest.fn(),
    create: jest.fn(),
    findAll: jest.fn(),
  },
  RefreshToken: {
    findOne: jest.fn().mockResolvedValue(null),
    findByPk: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue([0]),
  },
  PendingLoginToken: {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue([0]),
  },
  PermissionGrant: {
    findAll: jest.fn().mockResolvedValue([]),
  },
}));

// The middleware/upload module references Multer and the file system; mock it
// so the avatar route can be mounted without needing the uploads directory.
// routes/auth.js calls createUpload('avatar') at module-load time, and uses
// setCategoryMiddleware + postUploadValidation in the avatar handler chain.
jest.mock('../../middleware/upload', () => ({
  upload: { single: () => (_req, _res, next) => next() },
  handleMulterError: (_err, _req, _res, next) => next(),
  validateFileSignature: (_req, _res, next) => next(),
  createUpload: () => ({ single: () => (_req, _res, next) => next() }),
  setCategoryMiddleware: () => (_req, _res, next) => next(),
  postUploadValidation: () => (_req, _res, next) => next(),
  getUploadDir: () => '/tmp/uploads-test',
  uploadDir: '/tmp/uploads-test',
}));

// socketService is consumed by logout (disconnectUser) + emitToBoard / emitToUser.
jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToUser: jest.fn(),
  disconnectUser: jest.fn().mockResolvedValue(0),
  getIO: jest.fn(() => ({ emit: jest.fn() })),
  initializeSocket: jest.fn(),
}));

// pushService is required by routes/auth.js logout handler.
jest.mock('../../services/pushService', () => ({
  pushConfigured: false,
  vapidPublicKey: 'test-vapid',
  saveSubscription: jest.fn(),
  deactivateSubscription: jest.fn().mockResolvedValue(0),
  deactivateAllForUser: jest.fn().mockResolvedValue(0),
  deleteByEndpoint: jest.fn(),
  sendPushToUser: jest.fn(),
}));

// authCookies: keep the real cookie helpers — they're pure and have no I/O.
// But /me/permissions imports permissionEngine, so mock that.
jest.mock('../../services/permissionEngine', () => ({
  computeEffectivePermissions: jest.fn().mockResolvedValue({
    permissions: {},
    basePermissions: {},
    overrides: [],
    denials: [],
    grants: [],
    role: 'member',
    isSuperAdmin: false,
  }),
  hasPermission: jest.fn().mockResolvedValue(false),
  getEffectiveBasePermission: jest.fn(() => false),
  getEffectiveBasePermissions: jest.fn(() => ({})),
}));

// teamsTokenStorage — used in the SSO callback path. Mock so it can be
// loaded without crypto key configuration.
jest.mock('../../utils/teamsTokenStorage', () => ({
  encryptTeamsToken: jest.fn(v => v),
  decryptTeamsTokenSafe: jest.fn(v => v),
}));

// Teams config is loaded during the Microsoft SSO path.
jest.mock('../../config/teams', () => ({
  getTeamsConfig: jest.fn().mockResolvedValue({
    isConfigured: false,
    ssoEnabled: false,
    clientId: '',
    clientSecret: '',
    authUrl: '',
    ssoRedirectUri: '',
    ssoScopes: [],
  }),
}));

// ─── Build test app ──────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { User } = require('../../models');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../routes/auth'));
  return app;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateToken(userId, overrides = {}) {
  return jwt.sign({ id: userId, ...overrides }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

/**
 * A realistic user object returned from User.findByPk / User.findOne.
 * comparePassword is a method on the Sequelize model instance.
 */
function makeUser(overrides = {}) {
  const base = {
    id: 'user-uuid-1',
    name: 'John Doe',
    email: 'john@aniston.com',
    role: 'member',
    isActive: true,
    accountStatus: 'approved',
    authProvider: 'local',
    hasLocalPassword: true,
    password: '$2a$10$hashedpassword',
    comparePassword: jest.fn().mockResolvedValue(true),
    toJSON: jest.fn().mockReturnValue({
      id: 'user-uuid-1',
      name: 'John Doe',
      email: 'john@aniston.com',
      role: 'member',
    }),
    update: jest.fn().mockResolvedValue(true),
    reload: jest.fn().mockResolvedValue(true),
  };
  return { ...base, ...overrides };
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'Password@1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors).toBeDefined();
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@aniston.com' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when email format is invalid', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: 'Password@1' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 (generic) when no account exists for the email', async () => {
    // Production-side: returns a generic 401 "Invalid email or password"
    // for unknown emails to avoid user enumeration / timing leaks.
    User.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });

  it('returns 403 when the account is deactivated (after password verifies)', async () => {
    User.findOne.mockResolvedValue(makeUser({ isActive: false }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/deactivated/i);
  });

  it('returns 403 when the account is pending approval', async () => {
    User.findOne.mockResolvedValue(makeUser({ accountStatus: 'pending' }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/pending/i);
  });

  it('returns 403 when the account has been rejected', async () => {
    User.findOne.mockResolvedValue(makeUser({ accountStatus: 'rejected' }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/rejected/i);
  });

  it('returns 401 (generic) when password is incorrect', async () => {
    const user = makeUser();
    user.comparePassword = jest.fn().mockResolvedValue(false);
    User.findOne.mockResolvedValue(user);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@aniston.com', password: 'WrongPass@1' });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });

  it('returns 200 with user payload on valid credentials', async () => {
    User.findOne.mockResolvedValue(makeUser());

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Tokens now live in httpOnly cookies, not the body. The body returns
    // the user. Verify Set-Cookie carries the access cookie.
    expect(res.body.data).toHaveProperty('user');
    const setCookie = res.headers['set-cookie'] || [];
    expect(setCookie.some(c => c.startsWith('aniston_at='))).toBe(true);
  });

  it('normalises email to lowercase before looking it up', async () => {
    User.findOne.mockResolvedValue(makeUser());

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'JOHN@ANISTON.COM', password: 'Password@1' });

    expect(User.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: 'john@aniston.com' }) })
    );
  });

  it('returns 401 (generic) for a Microsoft SSO account attempting password login', async () => {
    // SSO-only users have no local password; production collapses to the
    // generic 401 (same as wrong-password) for timing parity.
    User.findOne.mockResolvedValue(makeUser({
      authProvider: 'microsoft',
      hasLocalPassword: false,
      password: null,
    }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });
});

// ─── POST /api/auth/register ──────────────────────────────────────────────────
//
// Public registration is intentionally DISABLED. The route now responds with
// 403 in every case so the only path to a new account is via an admin in the
// User Management page. These tests guard against accidental re-enablement.

describe('POST /api/auth/register (disabled)', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 even with a fully-valid payload (registration disabled)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New User', email: 'newuser@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/registration is disabled|contact your administrator/i);
  });

  it('returns 403 with an empty body too — guard fires before validators', async () => {
    const res = await request(app).post('/api/auth/register').send({});
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('never invokes the User model from /register (registration is fully stubbed)', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'X', email: 'x@y.com', password: 'Password@1' });
    expect(User.findOne).not.toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
  });
});

// ─── GET /api/auth/profile ────────────────────────────────────────────────────

describe('GET /api/auth/profile', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get('/api/auth/profile');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 when the Bearer token is invalid', async () => {
    const res = await request(app)
      .get('/api/auth/profile')
      .set('Authorization', 'Bearer totally.invalid.token');

    expect(res.status).toBe(401);
  });

  it('returns 200 with user data for a valid token', async () => {
    const mockUser = makeUser();
    // authenticate calls User.findByPk; getProfile also calls User.findByPk
    User.findByPk
      .mockResolvedValueOnce(mockUser)   // authenticate
      .mockResolvedValueOnce(mockUser);  // getProfile

    const token = generateToken(mockUser.id);

    const res = await request(app)
      .get('/api/auth/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('user');
  });

  it('returns 404 when the user is deleted after token was issued', async () => {
    const mockUser = makeUser();
    // authenticate finds the user (isActive true); controller then finds null
    User.findByPk
      .mockResolvedValueOnce(mockUser)  // authenticate
      .mockResolvedValueOnce(null);     // getProfile

    const token = generateToken(mockUser.id);

    const res = await request(app)
      .get('/api/auth/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────

describe('POST /api/auth/forgot-password', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  afterAll(() => { process.env.NODE_ENV = 'test'; });

  it('returns 400 when email is not supplied or invalid', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({});

    expect(res.status).toBe(400);
  });

  it('returns 200 with generic message when email does not exist (avoids enumeration)', async () => {
    User.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'ghost@aniston.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/If that email exists/i);
  });

  it('returns 200 with a reset URL in development when email exists', async () => {
    process.env.NODE_ENV = 'development';
    User.findOne.mockResolvedValue(makeUser());

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'john@aniston.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('resetUrl');
    process.env.NODE_ENV = 'test';
  });
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
//
// Production now uses a SHA-256 hashed token stored on the user record, not a
// JWT. The controller looks the user up via User.findOne against the stored
// hash. These tests stub the lookup result directly.

describe('POST /api/auth/reset-password', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  // The validator requires token length 32..200, so pad short test tokens.
  const validToken = 'a'.repeat(64);

  it('returns 400 when token is missing', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ newPassword: 'NewPass@123' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when newPassword is missing', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: validToken });

    expect(res.status).toBe(400);
  });

  it('returns 400 when password does not meet strength requirements', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: validToken, newPassword: 'weakpass' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when the token does not match any user (invalid or expired)', async () => {
    User.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: validToken, newPassword: 'NewPass@123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid or has expired/i);
  });

  it('returns 200 and updates the password when token matches an active user', async () => {
    const mockUser = makeUser();
    User.findOne.mockResolvedValue(mockUser);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: validToken, newPassword: 'NewPass@123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Controller calls user.update with the new password + token cleanup.
    expect(mockUser.update).toHaveBeenCalled();
    const updatePayload = mockUser.update.mock.calls[0][0];
    expect(updatePayload).toMatchObject({ password: 'NewPass@123' });
  });
});

// ─── GET /api/auth/users ─────────────────────────────────────────────────────

describe('GET /api/auth/users', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/auth/users');
    expect(res.status).toBe(401);
  });

  it('returns 200 with an array of users for an authenticated request', async () => {
    const mockUser = makeUser();
    const userList = [
      { id: 'u1', name: 'Alice', email: 'alice@aniston.com', role: 'member' },
      { id: 'u2', name: 'Bob', email: 'bob@aniston.com', role: 'manager' },
    ];

    User.findByPk.mockResolvedValue(mockUser);     // authenticate
    User.findAll.mockResolvedValue(userList);       // getAllUsers

    const token = generateToken(mockUser.id);

    const res = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.users)).toBe(true);
  });
});
