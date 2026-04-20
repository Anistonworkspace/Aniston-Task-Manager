const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const TaskAssignee = sequelize.define('TaskAssignee', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  taskId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tasks', key: 'id' },
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  role: {
    type: DataTypes.ENUM('assignee', 'supervisor'),
    allowNull: false,
    defaultValue: 'assignee',
  },
  assignedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  // Who triggered this assignment. Used to scope receipt-icon visibility —
  // only the assigner (or task creator) sees the read-receipt UI.
  assignerId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  // Delivered = the app has the task in the assignee's view (list fetch).
  // Seen = the assignee opened the task modal / detail view.
  // Both are nullable and idempotent-set-once.
  deliveredAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  seenAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'task_assignees',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['taskId', 'userId', 'role'] },
    { fields: ['userId'] },
  ],
});

module.exports = TaskAssignee;
