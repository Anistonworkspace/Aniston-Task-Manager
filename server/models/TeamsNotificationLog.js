const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const TeamsNotificationLog = sequelize.define(
  'TeamsNotificationLog',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    eventId: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      field: 'event_id',
    },
    taskId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: 'task_id',
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'user_id',
    },
    notificationType: {
      type: DataTypes.STRING(50),
      allowNull: false,
      field: 'notification_type',
    },
    cardPayload: {
      type: DataTypes.JSONB,
      allowNull: false,
      field: 'card_payload',
    },
    status: {
      type: DataTypes.STRING(20),
      defaultValue: 'pending',
    },
    sentAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'sent_at',
    },
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'error_message',
    },
    retryCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      field: 'retry_count',
    },
  },
  {
    tableName: 'teams_notification_log',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

module.exports = TeamsNotificationLog;
