'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * Form — Phase F1 public-or-internal data collection surface.
 *
 * Submissions live in `form_submissions`. A form belongs to a workspace and
 * (optionally) targets a specific board — when targetBoardId is set, each
 * submission can auto-create a task on that board via the form's
 * targetColumnMap (which form field id maps to which task column). v1
 * stores the raw payload only; auto-task-creation is an iteration on top.
 *
 * `fields` JSONB shape (one entry per field):
 *   {
 *     id: string,                     // stable client-generated id
 *     type: 'text' | 'textarea' | 'number' | 'email' | 'date' | 'select' | 'checkbox',
 *     label: string,
 *     required: boolean,
 *     placeholder?: string,
 *     options?: string[],              // for type: 'select'
 *   }
 *
 * `slug` is the public URL key — /f/<slug>. Unique. Lowercase + dashes.
 */
const Form = sequelize.define(
  'Form',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    slug: {
      type: DataTypes.STRING(80),
      allowNull: false,
      unique: true,
    },
    workspaceId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workspaces', key: 'id' },
      onDelete: 'CASCADE',
    },
    targetBoardId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'boards', key: 'id' },
      onDelete: 'SET NULL',
      comment: 'When set, submissions can be promoted to tasks on this board.',
    },
    targetColumnMap: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment:
        'Maps a Task field name → a form field id. Supported task fields: '
        + "title / description / dueDate / priority / status. e.g. "
        + "{ title: 'f_abc', description: 'f_xyz' }. When `title` is mapped "
        + 'and `targetBoardId` is set, every submission auto-creates a Task; '
        + 'unmapped fields fall back to sensible defaults.',
    },
    fields: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    isPublic: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Public forms accept submissions without authentication via /api/forms/public/:slug/submit.',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    submissionCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Denormalized counter bumped on each submit — saves a COUNT(*) on the list page.',
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
    },
  },
  {
    tableName: 'forms',
    timestamps: true,
    indexes: [
      { fields: ['workspaceId'] },
      { fields: ['slug'], unique: true },
      { fields: ['targetBoardId'] },
    ],
  }
);

module.exports = Form;
