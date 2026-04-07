const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Activity = sequelize.define('Activity', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  action: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'e.g. task_created, task_updated, subtask_added, status_changed, worklog_added',
  },
  description: {
    type: DataTypes.STRING(500),
    allowNull: false,
    comment: 'Human-readable description e.g. "John changed status to Done"',
  },
  entityType: {
    type: DataTypes.STRING(30),
    allowNull: false,
    comment: 'task, subtask, worklog, comment',
  },
  entityId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  taskId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'tasks', key: 'id' },
  },
  boardId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'boards', key: 'id' },
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  meta: {
    type: DataTypes.JSONB,
    defaultValue: {},
    comment: 'Extra details like { field: "status", from: "not_started", to: "done" }',
  },
}, {
  tableName: 'activities',
  timestamps: true,
  updatedAt: false,
  indexes: [
    { fields: ['taskId'] },
    { fields: ['boardId'] },
    { fields: ['userId'] },
    { fields: ['createdAt'] },
    { fields: ['entityType', 'entityId'] },
  ],
});

module.exports = Activity;
