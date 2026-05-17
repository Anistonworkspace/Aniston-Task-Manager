'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * FormSubmission — one row per public-or-internal submit on a Form.
 *
 * `payload` is the {fieldId: value} map the submitter sent, validated
 * against the parent form's `fields` schema in the controller.
 *
 * `submitterEmail` / `submitterIp` / `submitterUserAgent` are best-effort
 * audit data we capture from the request. submitterEmail is null when no
 * email field exists on the form. IP comes from req.ip — see comment in
 * formController.submitPublicForm.
 *
 * `taskId` is set when (and only when) the submission has been promoted to
 * a task on the parent form's targetBoardId — that's a v2 feature; v1
 * stores the raw payload and shows it in the FormSubmissionsTab.
 */
const FormSubmission = sequelize.define(
  'FormSubmission',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    formId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'forms', key: 'id' },
      onDelete: 'CASCADE',
    },
    payload: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    submitterEmail: {
      type: DataTypes.STRING(320),
      allowNull: true,
    },
    submitterIp: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    submitterUserAgent: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    submittedByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
      comment: 'When the form was submitted by a logged-in user, links the row to them. NULL for anonymous submits.',
    },
    taskId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'tasks', key: 'id' },
      onDelete: 'SET NULL',
      comment: 'v2: set when the submission was auto-promoted to a task on the form\'s targetBoardId.',
    },
  },
  {
    tableName: 'form_submissions',
    timestamps: true,
    indexes: [
      { fields: ['formId'] },
      { fields: ['formId', 'createdAt'] },
    ],
  }
);

module.exports = FormSubmission;
