const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const TaskDependency = sequelize.define('TaskDependency', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  taskId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  dependsOnTaskId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  dependencyType: {
    type: DataTypes.ENUM('blocks', 'required_for', 'related'),
    defaultValue: 'blocks',
  },
  autoAssignOnComplete: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  autoAssignToUserId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  createdById: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  isArchived: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  archivedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  archivedBy: {
    type: DataTypes.UUID,
    allowNull: true,
  },
}, {
  tableName: 'task_dependencies',
  timestamps: true,
  indexes: [
    { fields: ['taskId'] },
    { fields: ['dependsOnTaskId'] },
    { unique: true, fields: ['taskId', 'dependsOnTaskId'], name: 'unique_task_dependency' },
  ],
});

module.exports = TaskDependency;
