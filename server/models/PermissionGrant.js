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
      comment: 'Resource key from permissionMatrix (e.g. users, boards, tasks, dashboard)',
    },
    resourceId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'UUID of specific resource. NULL = global permission for this resource type',
    },
    action: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Specific action: view, create, edit, delete, assign, approve, export, manage, etc.',
    },
    permissionLevel: {
      type: DataTypes.STRING(30),
      allowNull: true,
      defaultValue: null,
      comment: 'Legacy level field. New grants use action instead.',
    },
    scope: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'global',
      comment: 'global | workspace | board',
    },
    isOverride: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
      comment: 'true = this is an override grant beyond base role',
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
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Why this permission was granted',
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    revokedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
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
      { fields: ['action'] },
      { fields: ['resourceType', 'action'] },
      { fields: ['userId', 'resourceType', 'action'] },
    ],
  }
);

module.exports = PermissionGrant;
