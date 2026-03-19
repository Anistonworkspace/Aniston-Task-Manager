const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Notification = sequelize.define(
  'Notification',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.ENUM(
        'task_assigned',
        'task_updated',
        'comment_added',
        'due_date',
        'mention'
      ),
      allowNull: false,
    },
    message: {
      type: DataTypes.STRING(500),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Notification message is required' },
      },
    },
    entityType: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: null,
      comment: 'Type of entity this notification relates to (task, board, comment)',
    },
    entityId: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
      comment: 'UUID of the related entity',
    },
    isRead: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
  },
  {
    tableName: 'notifications',
    timestamps: true,
    indexes: [
      { fields: ['userId'] },
      { fields: ['isRead'] },
      { fields: ['type'] },
      { fields: ['userId', 'isRead'] },
    ],
  }
);

module.exports = Notification;
