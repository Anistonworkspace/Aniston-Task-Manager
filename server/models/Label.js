const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Label = sequelize.define('Label', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING(100), allowNull: false },
  color: { type: DataTypes.STRING(20), allowNull: false, defaultValue: '#579bfc' },
  boardId: { type: DataTypes.UUID, allowNull: true, references: { model: 'boards', key: 'id' } },
  createdBy: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
}, { tableName: 'labels', timestamps: true });

module.exports = Label;
