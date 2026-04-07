const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const AIConfig = sequelize.define('AIConfig', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  provider: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'deepseek',
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
  lastTestedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  configuredBy: {
    type: DataTypes.UUID,
    allowNull: true,
  },
}, {
  tableName: 'ai_configs',
  timestamps: true,
});

module.exports = AIConfig;
