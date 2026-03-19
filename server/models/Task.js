const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Task = sequelize.define(
  'Task',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING(300),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Task title is required' },
        len: { args: [1, 300], msg: 'Task title must be between 1 and 300 characters' },
      },
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: '',
    },
    status: {
      type: DataTypes.ENUM('not_started', 'working_on_it', 'stuck', 'done'),
      defaultValue: 'not_started',
      allowNull: false,
    },
    priority: {
      type: DataTypes.ENUM('low', 'medium', 'high', 'critical'),
      defaultValue: 'medium',
      allowNull: false,
    },
    groupId: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: 'new',
      comment: 'References the group id within the parent board groups JSONB',
    },
    dueDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      defaultValue: null,
    },
    startDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      defaultValue: null,
    },
    position: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Sort order within the group',
    },
    tags: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: 'Array of string tags for categorization',
    },
    customFields: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: 'Key-value pairs for board-specific custom columns',
    },
    plannedStartTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    plannedEndTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    estimatedHours: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      defaultValue: 0,
    },
    actualHours: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      defaultValue: 0,
    },
    autoAssigned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    teamsEventId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    approvalStatus: {
      type: DataTypes.STRING(30),
      allowNull: true,
      defaultValue: null,
      comment: 'pending_approval | approved | changes_requested | null',
    },
    approvalChain: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: 'Array of { userId, status, comment, timestamp }',
    },
    recurrence: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: null,
      comment: '{ type: daily|weekly|monthly, interval, nextRun, endDate }',
    },
    lastRecurrenceAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    escalationLevel: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: null,
      comment: 'low | medium | high | critical',
    },
    progress: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0, max: 100 },
    },
    isArchived: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    boardId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'boards',
        key: 'id',
      },
    },
    assignedTo: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
      references: {
        model: 'users',
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
  },
  {
    tableName: 'tasks',
    timestamps: true,
    indexes: [
      { fields: ['boardId'] },
      { fields: ['assignedTo'] },
      { fields: ['status'] },
      { fields: ['priority'] },
      { fields: ['groupId'] },
      { fields: ['dueDate'] },
    ],
  }
);

module.exports = Task;
