const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Announcement = sequelize.define(
  'Announcement',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING(300),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Announcement title is required' },
      },
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    type: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'info',
      comment: 'info | warning | success | urgent',
    },
    isPinned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    workspaceId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'workspaces',
        key: 'id',
      },
      comment: 'NULL = global announcement',
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
    tableName: 'announcements',
    timestamps: true,
    indexes: [
      { fields: ['workspaceId'] },
      { fields: ['isActive'] },
      { fields: ['isPinned'] },
    ],
  }
);

module.exports = Announcement;
