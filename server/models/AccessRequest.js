const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const AccessRequest = sequelize.define(
  'AccessRequest',
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
      comment: 'User requesting access',
    },
    resourceType: {
      type: DataTypes.STRING(50),
      allowNull: false,
      comment: 'workspace | board | team | dashboard',
    },
    resourceId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'UUID of the resource being requested',
    },
    requestType: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'view',
      comment: 'view | edit | assign | admin',
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Justification for the request',
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'pending',
      comment: 'pending | approved | rejected | expired',
    },
    reviewedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    reviewedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    reviewNote: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Admin note on approval/rejection',
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Requested temporary access expiry',
    },
    isTemporary: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    tableName: 'access_requests',
    timestamps: true,
    indexes: [
      { fields: ['userId'] },
      { fields: ['status'] },
      { fields: ['resourceType', 'resourceId'] },
      { fields: ['reviewedBy'] },
    ],
  }
);

module.exports = AccessRequest;
