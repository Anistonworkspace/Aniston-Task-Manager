const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// Per-user workspace ordering preference for the sidebar. One row per
// (user, workspace) tuple. The `position` is the user's chosen index for
// that workspace in the sidebar list. Workspaces without a row fall through
// to the default (recency-weighted) order at render time. Mirrors
// UserBoardOrder, but scoped globally per user rather than per-workspace.
const UserWorkspaceOrder = sequelize.define(
  'UserWorkspaceOrder',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    workspaceId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workspaces', key: 'id' },
    },
    position: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: 'user_workspace_orders',
    timestamps: true,
    indexes: [
      { unique: true, fields: ['userId', 'workspaceId'], name: 'user_workspace_orders_uniq' },
      { fields: ['userId', 'position'], name: 'user_workspace_orders_lookup' },
    ],
  }
);

module.exports = UserWorkspaceOrder;
