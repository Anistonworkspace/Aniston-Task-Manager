const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const PermissionGrant = sequelize.define(
  'PermissionGrant',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    resourceType: {
      type: DataTypes.STRING(50),
      allowNull: false,
      comment: 'workspace | board | team | dashboard',
    },
    resourceId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'UUID of workspace/board/team. NULL = global permission',
    },
    permissionLevel: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'view',
      comment: 'view | edit | assign | manage | admin',
    },
    grantedBy: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
      comment: 'NULL = permanent, DATE = temporary access',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: 'permission_grants',
    timestamps: true,
    indexes: [
      { fields: ['userId'] },
      { fields: ['resourceType', 'resourceId'] },
      { fields: ['userId', 'resourceType', 'resourceId'] },
      { fields: ['isActive'] },
    ],
  }
);

module.exports = PermissionGrant;
