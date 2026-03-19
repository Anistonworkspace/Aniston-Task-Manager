const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const DueDateExtension = sequelize.define('DueDateExtension', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  taskId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tasks', key: 'id' } },
  requestedBy: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
  currentDueDate: { type: DataTypes.DATEONLY, allowNull: true },
  proposedDueDate: { type: DataTypes.DATEONLY, allowNull: false },
  reason: { type: DataTypes.TEXT, allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending' },
  reviewedBy: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
  reviewedAt: { type: DataTypes.DATE, allowNull: true },
  reviewNote: { type: DataTypes.TEXT, allowNull: true },
  suggestedDate: { type: DataTypes.DATEONLY, allowNull: true },
}, { tableName: 'due_date_extensions', timestamps: true });

module.exports = DueDateExtension;
