const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Workspace = sequelize.define(
  'Workspace',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(150),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Workspace name is required' },
        len: { args: [1, 150], msg: 'Workspace name must be between 1 and 150 characters' },
      },
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: '',
    },
    color: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: '#0073ea',
    },
    icon: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: 'Briefcase',
      comment: 'Lucide icon name',
    },
    isDefault: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Default workspace for boards without explicit workspace',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    archivedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    archivedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
  },
  {
    tableName: 'workspaces',
    timestamps: true,
  }
);

module.exports = Workspace;
