const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * Workflow — Phase W1 Workflow Canvas (visual automation builder).
 *
 * A Workflow is the top-level container for a node-graph automation. It
 * COEXISTS with the legacy `Automation` table — both engines fire on the
 * same trigger events (see services/automationService.js + services/
 * workflowEngine.js). The legacy table is single-trigger-single-action
 * per row; this table backs the canvas where a trigger node can chain
 * to many action / condition nodes.
 *
 * Scope: a workflow always lives inside a workspace and may be further
 * scoped to a single board (boardId). When boardId is NULL the workflow
 * runs for every task event in the workspace (v1 currently still filters
 * by `context.task?.boardId` matching the workflow's board, so workspace-
 * wide workflows simply omit the board filter).
 *
 * Lifecycle: `isActive=false` is the default — the canvas is a draft.
 * Setting `isActive=true` publishes the workflow so the engine picks it
 * up on the next trigger. `lastRunAt` + `lastRunStatus` are populated by
 * `executeWorkflow` so the list page can show a status badge without
 * having to JOIN against workflow_runs.
 */
const Workflow = sequelize.define(
  'Workflow',
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
    boardId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'boards', key: 'id' },
      onDelete: 'CASCADE',
      comment: 'Optional: scope this workflow to a single board. NULL = workspace-wide.',
    },
    workspaceId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workspaces', key: 'id' },
      onDelete: 'CASCADE',
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'false = draft (engine ignores). true = published (engine picks up).',
    },
    lastRunAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lastRunStatus: {
      type: DataTypes.STRING(20),
      allowNull: true,
      comment: "'ok' | 'error' | 'partial' — last run summary.",
    },
  },
  {
    tableName: 'workflows',
    timestamps: true,
    indexes: [
      { fields: ['workspaceId'] },
      { fields: ['boardId'] },
      { fields: ['boardId', 'isActive'] },
    ],
  }
);

module.exports = Workflow;
