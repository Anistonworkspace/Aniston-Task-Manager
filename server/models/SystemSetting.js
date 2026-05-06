const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// Generic key/value store for system-wide settings that aren't a natural fit
// for a dedicated config model (IntegrationConfig, AIConfig, etc). Use sparingly
// — prefer a typed model when a setting has its own lifecycle or schema.
const SystemSetting = sequelize.define('SystemSetting', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  key: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true,
  },
  value: {
    type: DataTypes.JSONB,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  updatedBy: {
    type: DataTypes.UUID,
    allowNull: true,
  },
}, {
  tableName: 'system_settings',
  timestamps: true,
});

module.exports = SystemSetting;
