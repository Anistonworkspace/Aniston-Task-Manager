const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const ManagerRelation = sequelize.define('ManagerRelation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  employeeId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  managerId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  relationType: {
    type: DataTypes.STRING(30),
    allowNull: false,
    defaultValue: 'primary',
    validate: {
      isIn: [['primary', 'functional', 'project', 'dotted_line']],
    },
  },
  isPrimary: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
}, {
  timestamps: true,
  tableName: 'manager_relations',
  indexes: [
    { fields: ['employeeId'] },
    { fields: ['managerId'] },
    { unique: true, fields: ['employeeId', 'managerId'], name: 'unique_employee_manager' },
  ],
});

module.exports = ManagerRelation;
