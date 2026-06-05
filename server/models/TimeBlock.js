const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const TimeBlock = sequelize.define('TimeBlock', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  startTime: {
    type: DataTypes.STRING(5), // "09:30"
    allowNull: false,
    validate: {
      is: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
  },
  endTime: {
    type: DataTypes.STRING(5), // "12:30"
    allowNull: false,
    validate: {
      is: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
  },
  // Rich note — sanitized HTML (a small tag allowlist). TEXT so it can hold a
  // multi-line formatted description. Length is bounded in the controller.
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: '',
  },
  // Display label. Nullable for backward-compat with legacy rows (which only
  // had a `description`). The controller requires it for custom blocks that
  // have no linked task; task-linked rows fall back to the task title at read.
  title: {
    type: DataTypes.STRING(300),
    allowNull: true,
  },
  // Block classification. De-enumed (VARCHAR + validate) per project convention.
  type: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'task_work',
    validate: {
      isIn: [['task_work', 'meeting', 'focus', 'break', 'admin', 'review', 'approval', 'travel', 'other']],
    },
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'planned',
    validate: {
      isIn: [['planned', 'in_progress', 'done', 'missed', 'rescheduled']],
    },
  },
  priority: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'normal',
    validate: {
      isIn: [['low', 'normal', 'high', 'urgent']],
    },
  },
  // Provenance — kept for future drag/AI/template/calendar features (Phase 7).
  source: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'manual',
    validate: {
      isIn: [['manual', 'task', 'template', 'calendar', 'ai']],
    },
  },
  // null = no reminder. Minutes-before-start the reminder fires.
  reminderMinutesBefore: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: {
      isIn: [[5, 10, 15, 30, 60]],
    },
  },
  // Per-block colour (a palette hex). NULL => fall back to the type colour.
  color: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  // Set once the pre-start reminder has been delivered (dedupe for the cron).
  reminderSentAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Bounded recurrence (MVP): the rule a group of instances was generated from.
  // 'daily' | 'weekdays' | 'weekly' | 'custom:1,3,5' | null
  recurrenceRule: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  // Shared id across instances generated from one repeat rule (for delete-series).
  recurrenceGroupId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  taskId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'tasks', key: 'id' },
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  // Who actually authored the row — distinct from userId (the owner) so we
  // can audit blocks created on someone else's planner via delegation.
  createdById: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'users', key: 'id' },
  },
  boardId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'boards', key: 'id' },
  },
}, {
  tableName: 'time_blocks',
  timestamps: true,
  indexes: [
    { fields: ['userId'] },
    { fields: ['date'] },
    { fields: ['userId', 'date'] },
    { fields: ['taskId'] },
    { fields: ['createdById'] },
  ],
});

module.exports = TimeBlock;
