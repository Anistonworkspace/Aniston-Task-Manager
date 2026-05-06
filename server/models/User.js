const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/db');
const { syncTierAndLegacyOnUser } = require('./userTierSync');

const User = sequelize.define(
  'User',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Name is required' },
        len: { args: [2, 100], msg: 'Name must be between 2 and 100 characters' },
      },
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: { msg: 'Email address already in use' },
      validate: {
        isEmail: { msg: 'Must be a valid email address' },
        notEmpty: { msg: 'Email is required' },
      },
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    authProvider: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'local',
    },
    avatar: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: null,
      get() {
        const val = this.getDataValue('avatar');
        if (!val || !val.trim() || val === 'null' || val === 'undefined') return null;
        return val;
      },
    },
    role: {
      type: DataTypes.ENUM('admin', 'manager', 'assistant_manager', 'member'),
      defaultValue: 'member',
      allowNull: false,
    },
    department: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },
    designation: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },
    teamsUserId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    teamsAccessToken: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    teamsRefreshToken: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    teamsTokenExpiry: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    teamsNotificationsEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false,
      field: 'teams_notifications_enabled',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false,
    },
    localStatusOverride: {
      // Set to true the moment an admin manually flips isActive via Admin
      // Settings (PUT /api/users/:id or /toggle-status). Microsoft sync
      // reads this and skips the user's isActive field so manual
      // deactivations are not silently undone on the next sync run.
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
      field: 'local_status_override',
    },
    isSuperAdmin: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Phase 2/3 of the tier-based RBAC migration. The canonical privilege
    // level going forward; `role` + `isSuperAdmin` are kept in sync via the
    // beforeSave hook below for the duration of the compatibility window.
    //
    // Mapping (see server/config/tiers.js — single source of truth):
    //   1 = full system access  (legacy: isSuperAdmin=true)
    //   2 = broad management    (legacy: role IN ('admin','manager'))
    //   3 = subtree management  (legacy: role='assistant_manager')
    //   4 = self-scoped         (legacy: role='member')
    //
    // REQUIRES migration 014 to be applied first (`node server/migrations/run_014.js`).
    tier: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 4,
      validate: {
        isInt: { msg: 'tier must be an integer' },
        min: { args: [1], msg: 'tier must be between 1 and 4' },
        max: { args: [4], msg: 'tier must be between 1 and 4' },
      },
    },
    accountStatus: {
      type: DataTypes.STRING(20),
      defaultValue: 'approved',
      allowNull: false,
    },
    hierarchyLevel: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: 'member',
    },
    title: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },
    hasLocalPassword: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
      field: 'has_local_password',
    },
    passwordChangedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
      field: 'password_changed_at',
    },
    passwordResetToken: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
      field: 'password_reset_token',
    },
    passwordResetExpires: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
      field: 'password_reset_expires',
    },
    fontSizePreference: {
      // 'compact' | 'default' | 'comfortable' | 'large' — drives the global
      // typography scale on the client. NULL means "use the app default".
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: null,
      field: 'font_size_preference',
      validate: {
        isIn: {
          args: [['compact', 'default', 'comfortable', 'large']],
          msg: 'fontSizePreference must be one of: compact, default, comfortable, large',
        },
      },
    },
  },
  {
    tableName: 'users',
    timestamps: true,
    hooks: {
      beforeCreate: async (user) => {
        if (user.password) {
          const salt = await bcrypt.genSalt(12);
          user.password = await bcrypt.hash(user.password, salt);
        }
      },
      beforeUpdate: async (user) => {
        if (user.changed('password')) {
          const salt = await bcrypt.genSalt(12);
          user.password = await bcrypt.hash(user.password, salt);
        }
      },
      // Tier ↔ legacy sync. Runs on both create and update, AFTER the password
      // hooks above. Loop-safe: only mutates fields when at least one side has
      // explicitly changed; never calls .save(). See models/userTierSync.js.
      beforeSave: (user) => {
        syncTierAndLegacyOnUser(user);
      },
    },
  }
);

/**
 * Compare a candidate password against the stored hash.
 */
User.prototype.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Override toJSON to strip sensitive fields from any serialized output.
 */
User.prototype.toJSON = function () {
  const values = { ...this.get() };
  delete values.password;
  delete values.teamsAccessToken;
  delete values.teamsRefreshToken;
  delete values.teamsTokenExpiry;
  delete values.passwordResetToken;
  delete values.passwordResetExpires;
  return values;
};

module.exports = User;
