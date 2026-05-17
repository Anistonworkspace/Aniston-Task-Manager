'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * WorkflowWait — Phase W3 DB-backed resumable wait.
 *
 * Each row represents a workflow run that hit a `wait` action with a
 * duration longer than the in-memory cap (5 min). The engine writes the row
 * and stops walking; a cron job (`workflowWaitJob`) wakes up periodically
 * and resumes the walk from `fromNodeId` once `resumeAt <= NOW()`.
 *
 * Why a dedicated table instead of WorkflowRun extension:
 *   - The wait can outlive a process restart; survival is the whole point.
 *   - WorkflowRun is the audit log (one row per RUN), this is the queue
 *     (one row per PENDING resume). Different access patterns.
 *
 * `context` is a snapshot of the trigger context that originally fired the
 * workflow — task fields, userId, etc. Stored as JSONB so the resumer can
 * rehydrate without re-fetching the task (the task might have changed by
 * the time we resume; using the snapshot keeps the workflow's view
 * consistent with what fired it).
 */
const WorkflowWait = sequelize.define(
  'WorkflowWait',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    workflowId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workflows', key: 'id' },
      onDelete: 'CASCADE',
    },
    fromNodeId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workflow_nodes', key: 'id' },
      onDelete: 'CASCADE',
      comment: 'The wait action node — resume walks from its outgoing edges.',
    },
    context: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
      comment: 'Snapshot of the trigger context (task, userId, etc.).',
    },
    resumeAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    attemptCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Bumped on each resume attempt — used to short-circuit waits that keep failing.',
    },
  },
  {
    tableName: 'workflow_waits',
    timestamps: true,
    indexes: [
      { fields: ['resumeAt'] },
      { fields: ['workflowId'] },
    ],
  }
);

module.exports = WorkflowWait;
