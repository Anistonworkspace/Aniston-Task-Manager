const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * TaskReminder — every row represents a scheduled reminder for a task.
 *
 *   reminderType    meaning
 *   ──────────────  ───────────────────────────────────────────────────
 *   '2_day'         legacy — 48h before deadline (auto-scheduled)
 *   '2_hour'        legacy — 2h before deadline (auto-scheduled)
 *   'at_due'        fires at the exact dueDate moment
 *   'offset'        fires `offsetMinutes` BEFORE the dueDate
 *   'custom'        fires at the explicit `customReminderAt` timestamp
 *   'interval'      RECURRING. Re-arms every `intervalMinutes` until the
 *                   task is done/archived. Independent of dueDate.
 *   'daily_times'   RECURRING. Re-arms at the next `HH:MM` slot in
 *                   `timezone` until the task is done/archived. Independent
 *                   of dueDate.
 *
 * Idempotency: the partial unique index defined in the boot migration is
 *   (taskId, reminderType, COALESCE(offsetMinutes,-1), COALESCE(customReminderAt,'1970-01-01'))
 * Since `interval` and `daily_times` leave both COALESCE columns null, the
 * index gives us "one such row per task" for free — exactly what we want.
 *
 * Lifecycle:
 *   - sentAt set by claim-first UPDATE in reminderService.processReminders.
 *   - For one-shot types: stays set forever after fire.
 *   - For recurring types (interval / daily_times): re-armed by clearing
 *     sentAt and advancing scheduledFor in the same processReminders pass,
 *     unless the task is done or archived.
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
      comment: '2_day | 2_hour | at_due | offset | custom | interval | daily_times',
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
    // For reminderType='interval' — repeat period. After each fire,
    // scheduledFor advances by this many minutes.
    // Allowed range: 15 ≤ N ≤ 10080 (7 days). Null for non-interval types.
    intervalMinutes: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    // For reminderType='daily_times' — JSONB array of "HH:MM" strings (24h
    // format). 1–12 entries. Each entry triggers one fire per day in the
    // configured `timezone`. Null for non-daily_times types.
    timesOfDay: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: null,
    },
    // For reminderType='daily_times' — IANA timezone the HH:MM entries are
    // interpreted in (e.g. 'Asia/Kolkata'). Defaults applied at the service
    // layer when the client omits one.
    timezone: {
      type: DataTypes.STRING(64),
      allowNull: true,
      defaultValue: null,
    },
    scheduledFor: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'When this reminder should fire (UTC). Recomputed on dueDate change or after each recurring fire.',
    },
    sentAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
      comment: 'NULL means not yet sent. Re-armed to NULL by recurring types after each fire.',
    },
    lastFiredAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
      comment: 'Audit-only: timestamp of the most recent fire for recurring reminders.',
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
