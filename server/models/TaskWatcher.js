const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const TaskWatcher = sequelize.define(
  'TaskWatcher',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    taskId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'tasks',
        key: 'id',
      },
    },
  },
  {
    tableName: 'task_watchers',
    timestamps: true,
    indexes: [
      { fields: ['userId'] },
      { fields: ['taskId'] },
      { unique: true, fields: ['userId', 'taskId'] },
    ],
  }
);

module.exports = TaskWatcher;
