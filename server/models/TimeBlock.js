const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const TimeBlock = sequelize.define('TimeBlock', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  startTime: {
    type: DataTypes.STRING(5), // "09:30"
    allowNull: false,
    validate: {
      is: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
  },
  endTime: {
    type: DataTypes.STRING(5), // "12:30"
    allowNull: false,
    validate: {
      is: /^([01]\d|2[0-3]):[0-5]\d$/,
    },
  },
  description: {
    type: DataTypes.STRING(500),
    allowNull: true,
    defaultValue: '',
  },
  taskId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'tasks', key: 'id' },
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  boardId: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'boards', key: 'id' },
  },
}, {
  tableName: 'time_blocks',
  timestamps: true,
  indexes: [
    { fields: ['userId'] },
    { fields: ['date'] },
    { fields: ['userId', 'date'] },
    { fields: ['taskId'] },
  ],
});

module.exports = TimeBlock;
