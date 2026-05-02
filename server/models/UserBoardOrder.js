const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// Per-user board ordering preference inside a workspace. One row per
// (user, workspace, board) tuple. The `position` is the user's chosen index
// for that board in that workspace's sidebar list. Boards without a row
// fall through to the default order at render time.
const UserBoardOrder = sequelize.define(
  'UserBoardOrder',
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
    boardId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'boards', key: 'id' },
    },
    position: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: 'user_board_orders',
    timestamps: true,
    indexes: [
      { unique: true, fields: ['userId', 'workspaceId', 'boardId'], name: 'user_board_orders_uniq' },
      { fields: ['userId', 'workspaceId', 'position'], name: 'user_board_orders_lookup' },
    ],
  }
);

module.exports = UserBoardOrder;
