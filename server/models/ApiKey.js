const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const ApiKey = sequelize.define('ApiKey', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
    comment: 'Friendly label, e.g. "HRMS Production"',
  },
  keyHash: {
    type: DataTypes.STRING(128),
    allowNull: false,
    unique: true,
    comment: 'SHA-256 hash of the raw key (raw key is only shown once)',
  },
  keyPrefix: {
    type: DataTypes.STRING(12),
    allowNull: false,
    comment: 'First 8 chars of the key for identification',
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Null = never expires',
  },
  lastUsedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: false,
  },
}, {
  tableName: 'api_keys',
  timestamps: true,
});

module.exports = ApiKey;