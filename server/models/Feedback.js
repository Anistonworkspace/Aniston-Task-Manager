const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Feedback = sequelize.define('Feedback', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  category: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'other' },
  rating: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 5 } },
  message: { type: DataTypes.TEXT, allowNull: false },
  page: { type: DataTypes.STRING(200), defaultValue: '' },
  status: { type: DataTypes.STRING(20), defaultValue: 'new' },
  adminNotes: { type: DataTypes.TEXT, defaultValue: '' },
  userId: { type: DataTypes.UUID, allowNull: false },
}, { tableName: 'feedback', timestamps: true });

module.exports = Feedback;
