const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const HierarchyLevel = sequelize.define('HierarchyLevel', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  label: { type: DataTypes.STRING(100), allowNull: false },
  order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  color: { type: DataTypes.STRING(20), defaultValue: '#6366f1' },
  icon: { type: DataTypes.STRING(50), defaultValue: 'User' },
  description: { type: DataTypes.TEXT, allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
}, {
  tableName: 'hierarchy_levels',
  timestamps: true,
});

module.exports = HierarchyLevel;
