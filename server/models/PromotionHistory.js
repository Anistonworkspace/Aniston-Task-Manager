const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const PromotionHistory = sequelize.define('PromotionHistory', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
  previousRole: { type: DataTypes.STRING(50), allowNull: true },
  newRole: { type: DataTypes.STRING(50), allowNull: false },
  previousTitle: { type: DataTypes.STRING(100), allowNull: true },
  newTitle: { type: DataTypes.STRING(100), allowNull: true },
  promotedBy: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
  notes: { type: DataTypes.TEXT, allowNull: true },
  effectiveDate: { type: DataTypes.DATEONLY, allowNull: false, defaultValue: DataTypes.NOW },
}, { tableName: 'promotion_history', timestamps: true });

module.exports = PromotionHistory;
