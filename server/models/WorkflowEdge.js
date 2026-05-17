const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * WorkflowEdge — directed connection from one node to another inside the
 * same workflow.
 *
 * v1 supports linear chains: every edge with `condition === null` is
 * traversed unconditionally. Branching is scaffolded — when the engine
 * sees a non-null `condition` it logs "condition node skipped" and
 * stops walking that branch. Real condition evaluation lands in v2.
 *
 * Uniqueness on (sourceNodeId, targetNodeId) prevents the canvas from
 * accidentally registering duplicate edges between the same two nodes.
 * Self-edges (sourceNodeId === targetNodeId) are rejected by the
 * controller, not by a DB constraint.
 */
const WorkflowEdge = sequelize.define(
  'WorkflowEdge',
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
    sourceNodeId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workflow_nodes', key: 'id' },
      onDelete: 'CASCADE',
    },
    targetNodeId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workflow_nodes', key: 'id' },
      onDelete: 'CASCADE',
    },
    condition: {
      type: DataTypes.JSONB,
      allowNull: true,
      comment: 'Legacy edge-level condition. Prefer condition NODES + edge.branch in v2.',
    },
    branch: {
      type: DataTypes.STRING(8),
      allowNull: true,
      comment:
        "When source is a condition node: 'true' or 'false' selects which "
        + 'evaluation result follows this edge. NULL on edges from non-'
        + 'condition sources (always traversed). The canvas client assigns '
        + 'true/false by connection order when the source is a condition.',
    },
  },
  {
    tableName: 'workflow_edges',
    timestamps: true,
    indexes: [
      { fields: ['workflowId'] },
      { unique: true, fields: ['sourceNodeId', 'targetNodeId'] },
    ],
  }
);

module.exports = WorkflowEdge;
