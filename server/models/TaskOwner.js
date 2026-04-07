const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const TaskOwner = sequelize.define('TaskOwner', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
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
  isPrimary: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  tableName: 'task_owners',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['taskId', 'userId'] },
  ],
});

module.exports = TaskOwner;
