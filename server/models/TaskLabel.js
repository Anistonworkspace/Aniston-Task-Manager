const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const TaskLabel = sequelize.define('TaskLabel', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  taskId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tasks', key: 'id' } },
  labelId: { type: DataTypes.UUID, allowNull: false, references: { model: 'labels', key: 'id' } },
}, { tableName: 'task_labels', timestamps: true, indexes: [{ unique: true, fields: ['taskId', 'labelId'] }] });

module.exports = TaskLabel;
