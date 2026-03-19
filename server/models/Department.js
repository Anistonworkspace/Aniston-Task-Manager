const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Department = sequelize.define(
  'Department',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: { msg: 'Department name already exists' },
      validate: {
        notEmpty: { msg: 'Department name is required' },
        len: { args: [2, 100], msg: 'Name must be between 2 and 100 characters' },
      },
    },
    description: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: null,
    },
    color: {
      type: DataTypes.STRING(7),
      allowNull: true,
      defaultValue: '#0073ea',
    },
    head: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      allowNull: false,
    },
  },
  {
    tableName: 'departments',
    timestamps: true,
    indexes: [
      { fields: ['name'], unique: true },
    ],
  }
);

module.exports = Department;
