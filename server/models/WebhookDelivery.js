const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const WebhookDelivery = sequelize.define('WebhookDelivery', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  webhookId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  event: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  payload: {
    type: DataTypes.JSONB,
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('pending', 'success', 'failed', 'dead'),
    allowNull: false,
    defaultValue: 'pending',
  },
  responseStatus: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  responseBody: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  lastAttemptAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  nextRetryAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'When the retry job should pick this delivery up next',
  },
  errorMessage: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'webhook_deliveries',
  timestamps: true,
  indexes: [
    { fields: ['status', 'nextRetryAt'] },
    { fields: ['webhookId', 'createdAt'] },
  ],
});

module.exports = WebhookDelivery;
