const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * RecurringTaskTemplate — the source of truth for "Daily Work / Recurring Work".
 *
 * One template generates many concrete Task instances over time. The instances
 * live in the `tasks` table with `isRecurringInstance = true` and a back-pointer
 * via `recurringTemplateId` + `occurrenceDate`. Duplicate generation is blocked
 * by a partial unique index on (recurringTemplateId, occurrenceDate) — see
 * server/scripts/add-recurring-fields-to-tasks.js.
 *
 * NOT to be confused with `Task.recurrence` (legacy JSONB on Task) — that path
 * is preserved for backward compatibility but new work should use this model.
 */
const RecurringTaskTemplate = sequelize.define(
  'RecurringTaskTemplate',
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
        notEmpty: { msg: 'Template title is required' },
        len: { args: [1, 300], msg: 'Template title must be between 1 and 300 characters' },
      },
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: '',
    },
    boardId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'boards', key: 'id' },
    },
    groupId: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: 'new',
      comment: 'References a group id within board.groups JSONB',
    },
    assigneeId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      comment: 'Single assignee for v1. Multi-assignee can be added later via a junction.',
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    priority: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'medium',
      validate: {
        isIn: {
          args: [['low', 'medium', 'high', 'critical']],
          msg: 'Priority must be one of low, medium, high, critical',
        },
      },
    },
    frequency: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'daily',
      validate: {
        isIn: {
          args: [['daily', 'weekdays', 'weekly', 'monthly', 'custom']],
          msg: 'Frequency must be one of daily, weekdays, weekly, monthly, custom',
        },
      },
      comment: 'daily: every day. weekdays: Mon–Sat. weekly: weekdays array. monthly: daysOfMonth array (legacy dayOfMonth still honoured). custom: weekdays array.',
    },
    weekdays: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: 'Array of weekday integers (0=Sunday … 6=Saturday). Used by weekly + custom frequencies.',
    },
    dayOfMonth: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: { min: 1, max: 31 },
      comment: 'Legacy single-day field retained for backward compatibility. New code reads daysOfMonth (array). Writers continue to populate this with daysOfMonth[0] so old read paths still work.',
    },
    daysOfMonth: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: 'Array of day-of-month integers (1–31). Used by monthly frequency. Multi-day support — e.g. [5, 10, 15, 25]. Days exceeding the actual month length collapse to the last day; duplicate occurrence dates are blocked by the partial unique index on (recurringTemplateId, occurrenceDate).',
    },
    startDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      comment: 'First eligible occurrence date (inclusive). Generation never happens before this date.',
    },
    endDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      comment: 'Last eligible occurrence date (inclusive). Null = open-ended.',
    },
    dueTime: {
      // Postgres TIME — Sequelize maps to DataTypes.TIME but we accept STRING
      // shape ("HH:mm:ss" or "HH:mm") at the controller boundary and normalise.
      type: DataTypes.TIME,
      allowNull: false,
      defaultValue: '18:00:00',
      comment: 'Local time-of-day used to compute each generated instance dueDate.',
    },
    timezone: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: 'UTC',
      comment: 'IANA timezone (e.g. "Asia/Kolkata", "UTC"). Used for occurrence date computation.',
    },
    escalateIfMissed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'If true, missed-task job notifies escalationTargets after dueTime passes without status=done.',
    },
    escalationTargets: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: ['assignee', 'manager'],
      comment: 'Subset of ["assignee","manager","admin"]. Controls who is notified on miss.',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      comment: 'Pause/resume flag. Generation skips inactive templates.',
    },
    lastGeneratedDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      comment: 'occurrenceDate of the most recent successfully generated instance. Idempotency hint.',
    },
    nextRunAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Planned UTC timestamp at which the generation job should next consider this template.',
    },
    archivedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Soft-delete: archived templates stop generating but their historical instances remain.',
    },
  },
  {
    tableName: 'recurring_task_templates',
    timestamps: true,
    indexes: [
      { fields: ['nextRunAt'] },
      { fields: ['assigneeId'] },
      { fields: ['boardId'] },
      { fields: ['isActive', 'archivedAt'] },
      { fields: ['createdBy'] },
    ],
  }
);

module.exports = RecurringTaskTemplate;
