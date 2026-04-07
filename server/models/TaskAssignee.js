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
}, {
  tableName: 'task_assignees',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['taskId', 'userId', 'role'] },
    { fields: ['userId'] },
  ],
});

module.exports = TaskAssignee;