const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const TranscriptionProvider = sequelize.define('TranscriptionProvider', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  providerType: {
    type: DataTypes.STRING(30),
    allowNull: false,
  },
  apiKey: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  model: {
    type: DataTypes.STRING(100),
    defaultValue: '',
  },
  language: {
    type: DataTypes.STRING(10),
    defaultValue: 'en-US',
  },
  baseUrl: {
    type: DataTypes.STRING(500),
    defaultValue: '',
  },
  diarizationEnabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
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
  tableName: 'transcription_providers',
  timestamps: true,
});

module.exports = TranscriptionProvider;
