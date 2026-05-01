const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Subtask = sequelize.define('Subtask', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  title: {
    type: DataTypes.STRING(300),
    allowNull: false,
    validate: {
      len: [1, 300],
    },
  },
  status: {
    type: DataTypes.ENUM('not_started', 'working_on_it', 'stuck', 'done'),
    defaultValue: 'not_started',
  },
  priority: {
    type: DataTypes.ENUM('low', 'medium', 'high', 'critical'),
    allowNull: true,
  },
  progress: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: { min: 0, max: 100 },
  },
  dueDate: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  position: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  taskId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'tasks',
      key: 'id',
    },
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id',
    },
  },
  assignedTo: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'users',
      key: 'id',
    },
  },
  plannedStartTime: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  plannedEndTime: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  estimatedMinutes: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
  },
  actualMinutes: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
  },
}, {
  tableName: 'subtasks',
  timestamps: true,
  indexes: [
    { fields: ['taskId'] },
    { fields: ['assignedTo'] },
    { fields: ['status'] },
    { fields: ['dueDate'] },
  ],
});

module.exports = Subtask;
