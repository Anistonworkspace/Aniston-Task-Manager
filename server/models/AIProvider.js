const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const AIProvider = sequelize.define('AIProvider', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  provider: {
    type: DataTypes.STRING(20),
    allowNull: false,
  },
  displayName: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  apiKey: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  model: {
    type: DataTypes.STRING(100),
    defaultValue: '',
  },
  baseUrl: {
    type: DataTypes.STRING(500),
    defaultValue: '',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  isDefault: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  lastTestedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  configuredBy: {
    type: DataTypes.UUID,
    allowNull: true,
  },
}, {
  tableName: 'ai_providers',
  timestamps: true,
});

module.exports = AIProvider;
