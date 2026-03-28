/**
 * Unit tests for the User model.
 *
 * All database and bcrypt calls are fully mocked — no real DB connection is
 * made. The tests exercise:
 *   - beforeCreate hook: password is hashed on creation
 *   - beforeUpdate hook: password is rehashed only when changed()
 *   - toJSON: strips the password field from serialised output
 *   - comparePassword: delegates to bcrypt.compare
 *   - Model-level validations: email format, name required, name length
 */

'use strict';

// ─── Mock the DB connection before anything else loads ───────────────────────
// We stub sequelize.define() so that the model file can be required without
// any real database dialect or connection being needed.
jest.mock('../../config/db', () => {
  const { DataTypes } = require('sequelize');

  // Minimal sequelize stub — only implements what User.js calls at module load
  const sequelize = {
    define: (modelName, attributes, options) => {
      // We need to return something that behaves like a Sequelize Model class
      // enough for our tests. We re-use Sequelize's actual define() behaviour
      // by delegating to a real in-memory instance, but only if the dialect
      // is available. Instead, we build a plain function/class with the
      // rawAttributes and options we care about.
      function ModelClass() {}
      ModelClass.rawAttributes = attributes;
      ModelClass.options = options || {};
      ModelClass.tableName = (options && options.tableName) || modelName;
      ModelClass.prototype = {};
      return ModelClass;
    },
  };
  return { sequelize };
});

// ─── Mock bcryptjs ────────────────────────────────────────────────────────────
jest.mock('bcryptjs', () => ({
  genSalt: jest.fn().mockResolvedValue('mock_salt'),
  hash: jest.fn().mockResolvedValue('hashed_password'),
  compare: jest.fn(),
}));

const bcrypt = require('bcryptjs');
const User = require('../../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal plain object that looks like a Sequelize User instance.
 * We invoke the hooks and prototype methods directly — no real DB call needed.
 */
function buildUserInstance(overrides = {}) {
  const data = {
    id: 'test-uuid',
    name: 'Alice',
    email: 'alice@example.com',
    password: 'plaintext',
    role: 'member',
    isActive: true,
    authProvider: 'local',
    ...overrides,
  };

  // Simulate Sequelize's `instance.get()` and `instance.changed()`
  const changedFields = new Set();
  const instance = {
    ...data,
    get() {
      return { ...data, ...this };
    },
    changed(field) {
      return changedFields.has(field);
    },
    _markChanged(field) {
      changedFields.add(field);
    },
  };

  // Attach prototype methods under test
  instance.toJSON = User.prototype.toJSON.bind(instance);
  instance.comparePassword = User.prototype.comparePassword.bind(instance);

  return instance;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('User model', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock: hash always returns a predictable value
    bcrypt.hash.mockResolvedValue('hashed_password');
    bcrypt.genSalt.mockResolvedValue('mock_salt');
  });

  // ── beforeCreate hook ──────────────────────────────────────────────────────

  describe('beforeCreate hook', () => {
    it('hashes the password before creating a user', async () => {
      const user = buildUserInstance({ password: 'secret123' });

      // Invoke the hook directly (same function the model registers)
      const hook = User.options.hooks.beforeCreate;
      await hook(user);

      expect(bcrypt.genSalt).toHaveBeenCalledWith(12);
      expect(bcrypt.hash).toHaveBeenCalledWith('secret123', 'mock_salt');
      expect(user.password).toBe('hashed_password');
    });

    it('does not call bcrypt when password is null (SSO users)', async () => {
      const user = buildUserInstance({ password: null });

      const hook = User.options.hooks.beforeCreate;
      await hook(user);

      expect(bcrypt.genSalt).not.toHaveBeenCalled();
      expect(bcrypt.hash).not.toHaveBeenCalled();
      expect(user.password).toBeNull();
    });

    it('does not call bcrypt when password is an empty string', async () => {
      const user = buildUserInstance({ password: '' });

      const hook = User.options.hooks.beforeCreate;
      await hook(user);

      expect(bcrypt.hash).not.toHaveBeenCalled();
    });
  });

  // ── beforeUpdate hook ──────────────────────────────────────────────────────

  describe('beforeUpdate hook', () => {
    it('rehashes the password when the password field has changed', async () => {
      const user = buildUserInstance({ password: 'newpassword' });
      user._markChanged('password');

      const hook = User.options.hooks.beforeUpdate;
      await hook(user);

      expect(bcrypt.genSalt).toHaveBeenCalledWith(12);
      expect(bcrypt.hash).toHaveBeenCalledWith('newpassword', 'mock_salt');
      expect(user.password).toBe('hashed_password');
    });

    it('does NOT rehash when the password field is unchanged', async () => {
      const user = buildUserInstance({ password: 'already_hashed' });
      // changed('password') returns false — no field marked

      const hook = User.options.hooks.beforeUpdate;
      await hook(user);

      expect(bcrypt.genSalt).not.toHaveBeenCalled();
      expect(bcrypt.hash).not.toHaveBeenCalled();
      expect(user.password).toBe('already_hashed');
    });

    it('does not hash when an unrelated field changes', async () => {
      const user = buildUserInstance({ password: 'already_hashed' });
      user._markChanged('name'); // only name changed, not password

      const hook = User.options.hooks.beforeUpdate;
      await hook(user);

      expect(bcrypt.hash).not.toHaveBeenCalled();
    });
  });

  // ── toJSON ─────────────────────────────────────────────────────────────────

  describe('toJSON()', () => {
    it('strips the password field from the returned object', () => {
      const user = buildUserInstance({ password: 'super_secret' });
      const json = user.toJSON();

      expect(json).not.toHaveProperty('password');
    });

    it('returns all non-sensitive fields intact', () => {
      const user = buildUserInstance({
        id: 'abc-123',
        name: 'Bob',
        email: 'bob@example.com',
        role: 'admin',
      });
      const json = user.toJSON();

      expect(json.id).toBe('abc-123');
      expect(json.name).toBe('Bob');
      expect(json.email).toBe('bob@example.com');
      expect(json.role).toBe('admin');
    });

    it('does not mutate the original instance data', () => {
      const user = buildUserInstance({ password: 'keep_it' });
      user.toJSON(); // should not delete from instance itself

      // The instance's own property should still be accessible via get()
      expect(user.get().password).toBe('keep_it');
    });
  });

  // ── comparePassword ────────────────────────────────────────────────────────

  describe('comparePassword()', () => {
    it('returns true when the candidate matches the stored hash', async () => {
      bcrypt.compare.mockResolvedValue(true);
      const user = buildUserInstance({ password: 'hashed_value' });

      const result = await user.comparePassword('correct_plain');

      expect(bcrypt.compare).toHaveBeenCalledWith('correct_plain', 'hashed_value');
      expect(result).toBe(true);
    });

    it('returns false when the candidate does not match', async () => {
      bcrypt.compare.mockResolvedValue(false);
      const user = buildUserInstance({ password: 'hashed_value' });

      const result = await user.comparePassword('wrong_plain');

      expect(result).toBe(false);
    });

    it('returns false immediately when password is null (SSO user)', async () => {
      const user = buildUserInstance({ password: null });

      const result = await user.comparePassword('anything');

      expect(bcrypt.compare).not.toHaveBeenCalled();
      expect(result).toBe(false);
    });
  });

  // ── Model-level field definitions ──────────────────────────────────────────

  describe('model field definitions', () => {
    it('defines a UUID primary key', () => {
      const { DataTypes } = require('sequelize');
      const idAttr = User.rawAttributes.id;
      expect(idAttr).toBeDefined();
      expect(idAttr.primaryKey).toBe(true);
      expect(idAttr.defaultValue).toBe(DataTypes.UUIDV4);
    });

    it('sets role default to "member"', () => {
      const roleAttr = User.rawAttributes.role;
      expect(roleAttr.defaultValue).toBe('member');
    });

    it('sets isActive default to true', () => {
      const isActiveAttr = User.rawAttributes.isActive;
      expect(isActiveAttr.defaultValue).toBe(true);
    });

    it('sets authProvider default to "local"', () => {
      const authAttr = User.rawAttributes.authProvider;
      expect(authAttr.defaultValue).toBe('local');
    });

    it('sets accountStatus default to "approved"', () => {
      const attr = User.rawAttributes.accountStatus;
      expect(attr.defaultValue).toBe('approved');
    });

    it('requires name (allowNull false) with notEmpty validation', () => {
      const nameAttr = User.rawAttributes.name;
      expect(nameAttr.allowNull).toBe(false);
      expect(nameAttr.validate.notEmpty).toBeDefined();
    });

    it('requires email (allowNull false) with isEmail validation', () => {
      const emailAttr = User.rawAttributes.email;
      expect(emailAttr.allowNull).toBe(false);
      expect(emailAttr.validate.isEmail).toBeDefined();
    });

    it('enforces name length between 2 and 100 characters', () => {
      const nameAttr = User.rawAttributes.name;
      expect(nameAttr.validate.len.args).toEqual([2, 100]);
    });

    it('allows null password (for SSO-only users)', () => {
      const passwordAttr = User.rawAttributes.password;
      expect(passwordAttr.allowNull).toBe(true);
    });

    it('uses the correct table name', () => {
      expect(User.tableName).toBe('users');
    });
  });
});
