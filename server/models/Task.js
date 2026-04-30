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
      type: DataTypes.STRING(50),
      defaultValue: 'not_started',
      allowNull: false,
      comment: 'Task status — validated against task-level then board-level status config',
    },
    statusConfig: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: null,
      comment: 'Task-specific allowed statuses: [{ key, label, color }]. Overrides board/global defaults when set.',
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
    teamsCalendarUserId: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Azure AD user ID (teamsUserId) whose mailbox holds teamsEventId. Needed because task.assignedTo can change after the event is created, and Graph DELETE/PATCH must target the original mailbox.',
    },
    syncStatus: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'not_synced',
      comment: 'not_synced | pending | synced | failed | skipped',
    },
    lastSyncedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    syncError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    syncAttempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
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
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
      comment: 'Set when status transitions to "done"; cleared when it transitions away. Reporting-friendly timestamp.',
    },
    // ─── Daily Work / Recurring Task instance bookkeeping ─────────
    // The legacy `recurrence` JSONB above remains for backward-compat. NEW
    // recurring work uses RecurringTaskTemplate + the columns below. The DB
    // partial unique index on (recurringTemplateId, occurrenceDate) is what
    // guarantees idempotent generation.
    recurringTemplateId: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
      references: { model: 'recurring_task_templates', key: 'id' },
      comment: 'Back-pointer to the RecurringTaskTemplate that produced this instance.',
    },
    occurrenceDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      defaultValue: null,
      comment: 'Calendar date this instance is "for" (in the template timezone).',
    },
    isRecurringInstance: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Fast filter for recurring-instance views.',
    },
    missedEscalationSent: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Idempotency flag for missed-recurring-task escalation notifications.',
    },
    missedEscalationSentAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    isArchived: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    archivedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    archivedBy: {
      type: DataTypes.UUID,
      allowNull: true,
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
