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
    // ── May-19 audit follow-up. All NULL-safe + additive. ─────────────
    finishedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'When the chain finished walking. NULL while running.',
    },
    actorId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'User who triggered the run (NULL = system / cron / form).',
    },
    failedStepId: {
      type: DataTypes.UUID,
      allowNull: true,
      comment: 'workflow_nodes.id of the first failed step, if any.',
    },
    retryCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Bumped by retry plumbing; 0 means the first attempt.',
    },
    idempotencyKey: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment:
        'Dedup key for trigger fires across replicas. '
        + 'Partial-unique on (workflowId, idempotencyKey) WHERE NOT NULL.',
    },
    workflowVersion: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Version tag — reserved for future WorkflowVersion table.',
    },
  },
  {
    tableName: 'workflow_runs',
    timestamps: true,
    indexes: [
      { fields: ['workflowId', 'startedAt'] },
      { fields: ['actorId'] },
      { fields: ['startedAt'] },
      {
        unique: true,
        fields: ['workflowId', 'idempotencyKey'],
        where: { idempotencyKey: { [require('sequelize').Op.ne]: null } },
      },
    ],
  }
);

module.exports = WorkflowRun;
