const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Webhook = sequelize.define('Webhook', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  apiKeyId: {
    type: DataTypes.UUID,
    allowNull: false,
    comment: 'The API key this webhook is bound to. Revoking the key disables the webhook.',
  },
  name: {
    type: DataTypes.STRING(150),
    allowNull: false,
  },
  url: {
    type: DataTypes.STRING(1000),
    allowNull: false,
    comment: 'HTTPS endpoint on the receiving application',
  },
  secret: {
    type: DataTypes.STRING(128),
    allowNull: false,
    comment: 'Shared secret used to sign payloads with HMAC-SHA256',
  },
  events: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: ['task.created', 'task.updated', 'task.deleted'],
    comment: 'Array of event names this webhook subscribes to',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  lastDeliveredAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  lastErrorAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  lastErrorMessage: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: false,
  },
}, {
  tableName: 'webhooks',
  timestamps: true,
});

module.exports = Webhook;
