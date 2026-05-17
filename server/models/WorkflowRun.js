const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * WorkflowRun — one row per execution of a workflow.
 *
 * Written by `workflowEngine.executeWorkflow` once a chain finishes
 * (successfully or otherwise). The `runs` list page reads from this
 * table to show recent executions with their status + duration so an
 * author can spot misconfigured workflows.
 *
 * `context` is a SANITIZED snapshot of the trigger context — we keep
 * just the IDs (taskId, userId, previousStatus / newStatus) rather than
 * the full task body, so the audit log doesn't accidentally archive
 * sensitive task descriptions or attachments inline. The full task can
 * be re-fetched via taskId at view time.
 *
 * `status`:
 *   - 'ok'      — every action node executed without throwing
 *   - 'partial' — some nodes were skipped (condition branches, unknown kinds)
 *   - 'error'   — at least one action node threw
 */
const WorkflowRun = sequelize.define(
  'WorkflowRun',
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
    trigger: {
      type: DataTypes.STRING(64),
      allowNull: false,
      comment: 'The trigger kind that fired this run.',
    },
    context: {
      type: DataTypes.JSONB,
      allowNull: true,
      comment: 'Sanitized trigger context (IDs only — not full task body).',
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      comment: "'ok' | 'error' | 'partial'",
    },
    nodesRun: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    durationMs: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'workflow_runs',
    timestamps: true,
    indexes: [
      { fields: ['workflowId', 'startedAt'] },
    ],
  }
);

module.exports = WorkflowRun;
