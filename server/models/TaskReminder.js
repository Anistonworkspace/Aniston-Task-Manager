const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * TaskReminder — every row represents a single scheduled reminder for a task.
 *
 * Phase 5 (Notification system fix) extends the original 2_day/2_hour-only
 * shape to support task-level user-configured reminders:
 *
 *   reminderType  meaning
 *   ────────────  ───────────────────────────────────────────────────
 *   '2_day'       legacy — 48h before deadline (auto-scheduled)
 *   '2_hour'      legacy — 2h before deadline (auto-scheduled)
 *   'at_due'      fires at the exact dueDate moment
 *   'offset'      fires `offsetMinutes` BEFORE the dueDate
 *   'custom'      fires at the explicit `customReminderAt` timestamp
 *
 * Idempotency: the partial unique index defined in the boot migration is
 *   (taskId, reminderType, COALESCE(offsetMinutes,-1), COALESCE(customReminderAt,'1970-01-01'))
 * so the same logical reminder cannot be inserted twice. Re-applying the
 * same reminder spec on task update is a no-op.
 *
 * Lifecycle:
 *   - sentAt set by claim-first UPDATE in reminderService.processReminders.
 *   - cancelled flipped on task complete / archive / delete / reschedule
 *     when the new spec list no longer contains the row's spec.
 */
const TaskReminder = sequelize.define(
  'TaskReminder',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    taskId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'tasks',
        key: 'id',
      },
    },
    reminderType: {
      type: DataTypes.STRING(20),
      allowNull: false,
      comment: '2_day | 2_hour | at_due | offset | custom',
    },
    // For reminderType='offset' — minutes BEFORE the due moment.
    // 5, 15, 30, 60 (1h), 120 (2h), 1440 (1d), 2880 (2d), etc.
    // Null for non-offset types.
    offsetMinutes: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    // For reminderType='custom' — exact UTC timestamp the user picked.
    // Null for non-custom types.
    customReminderAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    scheduledFor: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'When this reminder should fire (UTC). Recomputed on dueDate change.',
    },
    sentAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
      comment: 'NULL means not yet sent',
    },
    cancelled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    tableName: 'task_reminders',
    timestamps: true,
    indexes: [
      // Pending-due lookup: hot path for the every-15-min cron.
      {
        fields: ['scheduledFor'],
        name: 'idx_task_reminder_pending',
        where: { sentAt: null, cancelled: false },
      },
      // Per-task lookup for cancel/reschedule.
      { fields: ['taskId'], name: 'idx_task_reminder_taskid' },
    ],
  }
);

module.exports = TaskReminder;
