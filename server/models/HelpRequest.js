const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const HelpRequest = sequelize.define('HelpRequest', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  taskId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tasks', key: 'id' } },
  requestedBy: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
  requestedTo: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
  description: { type: DataTypes.TEXT, allowNull: false },
  urgency: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'medium' },
  preferredTime: { type: DataTypes.STRING(100), allowNull: true },
  status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'pending' },
  meetingLink: { type: DataTypes.TEXT, allowNull: true },
  meetingScheduledAt: { type: DataTypes.DATE, allowNull: true },
  resolvedAt: { type: DataTypes.DATE, allowNull: true },
}, { tableName: 'help_requests', timestamps: true });

module.exports = HelpRequest;
