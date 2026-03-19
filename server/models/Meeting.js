const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Meeting = sequelize.define(
  'Meeting',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING(200),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Meeting title is required' },
      },
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    startTime: {
      type: DataTypes.STRING(5),
      allowNull: false,
      validate: {
        is: { args: /^([01]\d|2[0-3]):[0-5]\d$/, msg: 'Start time must be in HH:MM format' },
      },
    },
    endTime: {
      type: DataTypes.STRING(5),
      allowNull: false,
      validate: {
        is: { args: /^([01]\d|2[0-3]):[0-5]\d$/, msg: 'End time must be in HH:MM format' },
      },
    },
    location: {
      type: DataTypes.STRING(200),
      allowNull: true,
      defaultValue: null,
    },
    type: {
      type: DataTypes.ENUM('meeting', 'reminder', 'follow_up'),
      defaultValue: 'meeting',
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('scheduled', 'completed', 'cancelled'),
      defaultValue: 'scheduled',
      allowNull: false,
    },
    participants: {
      type: DataTypes.JSONB,
      defaultValue: [],
      allowNull: false,
    },
    boardId: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
    },
    taskId: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    tableName: 'meetings',
    timestamps: true,
    indexes: [
      { fields: ['date'] },
      { fields: ['createdBy'] },
      { fields: ['date', 'createdBy'] },
      { fields: ['status'] },
    ],
  }
);

module.exports = Meeting;
