const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const WorkLog = sequelize.define('WorkLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    validate: { len: [1, 5000] },
  },
  date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  taskId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tasks', key: 'id' },
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'worklogs',
  timestamps: true,
  indexes: [
    { fields: ['taskId'] },
    { fields: ['userId'] },
    { fields: ['date'] },
    { fields: ['taskId', 'userId', 'date'] },
  ],
});

module.exports = WorkLog;
