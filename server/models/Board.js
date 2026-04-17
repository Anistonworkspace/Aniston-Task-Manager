const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Board = sequelize.define(
  'Board',
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
        notEmpty: { msg: 'Board name is required' },
        len: { args: [1, 150], msg: 'Board name must be between 1 and 150 characters' },
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
      validate: {
        is: { args: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, msg: 'Color must be a valid hex code' },
      },
    },
    columns: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [
        { id: 'status', title: 'Status', type: 'status', width: 140 },
        { id: 'person', title: 'Person', type: 'person', width: 140 },
        { id: 'date', title: 'Date', type: 'date', width: 140 },
        { id: 'priority', title: 'Priority', type: 'priority', width: 140 },
      ],
      comment: 'Configurable column definitions for the board view',
    },
    groups: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [
        { id: 'new', title: 'New', color: '#579bfc', position: 0 },
        { id: 'in_progress', title: 'In Progress', color: '#fdab3d', position: 1 },
        { id: 'done', title: 'Done', color: '#00c875', position: 2 },
      ],
      comment: 'Task groups (swim lanes) within the board',
    },
    workspaceId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'workspaces',
        key: 'id',
      },
    },
    archivedGroups: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: 'Groups that have been archived from this board',
    },
    customColumns: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      comment: 'User-added custom columns beyond the defaults',
    },
    isArchived: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
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
    tableName: 'boards',
    timestamps: true,
  }
);

module.exports = Board;
