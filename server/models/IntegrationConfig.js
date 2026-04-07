const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const IntegrationConfig = sequelize.define(
  'IntegrationConfig',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    provider: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
    },
    clientId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    clientSecret: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    tenantId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    redirectUri: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ssoRedirectUri: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ssoEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    configuredBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    tableName: 'integration_configs',
    timestamps: true,
  }
);

module.exports = IntegrationConfig;
