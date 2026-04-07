const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

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
      comment: '2_day or 2_hour',
    },
    scheduledFor: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'When this reminder should fire (UTC)',
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
      {
        unique: true,
        fields: ['taskId', 'reminderType'],
        name: 'idx_task_reminder_unique',
      },
      {
        fields: ['scheduledFor'],
        name: 'idx_task_reminder_pending',
        where: { sentAt: null, cancelled: false },
      },
    ],
  }
);

module.exports = TaskReminder;