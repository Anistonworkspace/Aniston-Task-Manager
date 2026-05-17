const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * WorkflowNode — a single node on the workflow canvas.
 *
 * `type` is the node category: 'trigger' (entry point), 'action' (does
 * something), or 'condition' (branches; scaffolded for v1, walker just
 * skips its outgoing edges and logs).
 *
 * `kind` is the specific identifier inside the catalog:
 *   - trigger: 'task_created' | 'task_updated' | 'status_changed' | 'task_assigned'
 *   - action:  'notify_user' | 'change_status' | 'change_priority' | 'assign_to' | 'send_message' | 'wait'
 *   - condition: (future)
 *
 * `config` is per-kind JSONB. Examples:
 *   - status_changed trigger:  { status: 'done' }   (match only when newStatus === 'done')
 *   - notify_user action:      { userId: '<uuid>' | 'assignee', message: 'Heads up' }
 *   - change_status action:    { to: 'done' }
 *   - wait action:             { minutes: 15 }   (no-op stub in v1)
 *
 * `position` is the canvas coordinate the client uses for layout. The
 * engine ignores it — it's purely for the React Flow canvas.
 */
const WorkflowNode = sequelize.define(
  'WorkflowNode',
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
    type: {
      type: DataTypes.STRING(16),
      allowNull: false,
      comment: "'trigger' | 'action' | 'condition'",
    },
    kind: {
      type: DataTypes.STRING(64),
      allowNull: false,
      comment: "Per-type identifier — e.g. 'task_created', 'notify_user'.",
    },
    config: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    position: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: { x: 0, y: 0 },
      comment: 'Canvas coordinates {x, y} — ignored by the engine.',
    },
  },
  {
    tableName: 'workflow_nodes',
    timestamps: true,
    indexes: [
      { fields: ['workflowId'] },
      { fields: ['workflowId', 'type'] },
    ],
  }
);

module.exports = WorkflowNode;
