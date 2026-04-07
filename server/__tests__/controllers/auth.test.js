'use strict';

/**
 * Integration tests for the auth API endpoints.
 *
 * A minimal Express app is assembled from the real route file so the
 * validator middleware, controller logic, and routing all exercise the same
 * code path as production.  The database layer (User model) and JWT are
 * mocked so no real DB connection is required.
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
}));

// The middleware/upload module references Multer and the file system; mock it
// so the avatar route can be mounted without needing the uploads directory.
jest.mock('../../middleware/upload', () => ({
  upload: {
    single: () => (_req, _res, next) => next(),
  },
  handleMulterError: (_err, _req, _res, next) => next(),
  validateFileSignature: (_req, _res, next) => next(),
}));

// The socketService is used in some controllers; avoid socket.io initialisation.
jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToUser: jest.fn(),
  getIO: jest.fn(() => ({ emit: jest.fn() })),
  initializeSocket: jest.fn(),
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

  it('returns 401 when no account exists for the email', async () => {
    User.findOne.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/No account found/i);
  });

  it('returns 403 when the account is deactivated', async () => {
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

  it('returns 401 when password is incorrect', async () => {
    const user = makeUser();
    user.comparePassword = jest.fn().mockResolvedValue(false);
    User.findOne.mockResolvedValue(user);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@aniston.com', password: 'WrongPass@1' });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Incorrect password/i);
  });

  it('returns 200 with token on valid credentials', async () => {
    User.findOne.mockResolvedValue(makeUser());

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('token');
    expect(res.body.data).toHaveProperty('refreshToken');
    expect(res.body.data).toHaveProperty('user');
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

  it('returns 400 for a Microsoft SSO account attempting password login', async () => {
    User.findOne.mockResolvedValue(makeUser({ authProvider: 'microsoft', password: null }));

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'john@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Microsoft SSO/i);
  });
});

// ─── POST /api/auth/register ──────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'new@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New User', password: 'Password@1' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New User', email: 'new@aniston.com' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when password is too weak (no special character)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New User', email: 'new@aniston.com', password: 'Password1' });

    expect(res.status).toBe(400);
  });

  it('returns 409 when email already exists', async () => {
    User.findOne.mockResolvedValue(makeUser());

    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New User', email: 'john@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);
  });

  it('returns 201 on valid registration', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue(makeUser({ accountStatus: 'pending' }));

    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New User', email: 'newuser@aniston.com', password: 'Password@1' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('pending', true);
  });

  it('stores the email in lowercase when creating the user', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue(makeUser());

    await request(app)
      .post('/api/auth/register')
      .send({ name: 'New User', email: 'UPPER@ANISTON.COM', password: 'Password@1' });

    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'upper@aniston.com' })
    );
  });
});

// ─── GET /api/auth/profile ────────────────────────────────────────────────────

describe('GET /api/auth/profile', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when no Authorization header is provided', async () => {
    // The authenticate middleware will reject the request before the controller.
    // We need a real jwt.verify to throw — don't mock it for this call.
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

  it('returns 400 when email is not supplied', async () => {
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
    // Should not leak whether the email exists
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
  });
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────

describe('POST /api/auth/reset-password', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 400 when token or newPassword is missing', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'some-token' }); // no newPassword

    expect(res.status).toBe(400);
  });

  it('returns 400 when password does not meet strength requirements', async () => {
    const resetToken = jwt.sign(
      { id: 'user-uuid-1', type: 'reset' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, newPassword: 'weak' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when the token type is not "reset"', async () => {
    const wrongToken = jwt.sign({ id: 'user-uuid-1', type: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: wrongToken, newPassword: 'NewPass@123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid reset token/i);
  });

  it('returns 400 when the token is expired', async () => {
    // An already-expired token
    const expiredToken = jwt.sign(
      { id: 'user-uuid-1', type: 'reset' },
      process.env.JWT_SECRET,
      { expiresIn: '-1s' }
    );

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: expiredToken, newPassword: 'NewPass@123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid or has expired/i);
  });

  it('returns 200 and resets the password with a valid token', async () => {
    const resetToken = jwt.sign(
      { id: 'user-uuid-1', type: 'reset' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    const mockUser = makeUser();
    User.findByPk.mockResolvedValue(mockUser);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: resetToken, newPassword: 'NewPass@123' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUser.update).toHaveBeenCalledWith({ password: 'NewPass@123' });
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
