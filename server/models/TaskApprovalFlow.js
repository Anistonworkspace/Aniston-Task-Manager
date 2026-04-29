const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// Normalized per-level approval row. One Task has many TaskApprovalFlow rows
// arranged by `level`. Level 0 = the submitter (status: 'submitted'); levels
// 1..N walk up the org chart (Asst Manager -> Manager -> Admin -> Super Admin).
// Replaces the previous JSONB-only `Task.approvalChain` audit log; the JSONB
// column is kept as a deprecated mirror for one release.
const TaskApprovalFlow = sequelize.define(
  'TaskApprovalFlow',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    taskId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'tasks', key: 'id' },
    },
    userId: {
      // Nullable so a deleted-user row in the chain can survive (FK SET NULL).
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
    },
    userName: {
      // Denormalized snapshot so the timeline keeps rendering after a user is deleted.
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    role: {
      // Snapshot of the user's role at the time the chain was generated.
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    level: {
      // 0 = submitter; 1..N = sequential approvers (lowest = most junior approver).
      // Stays globally unique per task (the (taskId, level) constraint is the
      // row identifier). Multiple rows can share a `stage` for parallel
      // approvers — see field below.
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    stage: {
      // Grouping key for parallel approvers. Sequential rows have stage = level.
      // Parallel rows (e.g. final Manager+Admin+SuperAdmin step) share one
      // stage value but each carry a unique `level`. Nullable for backward
      // compatibility with chains created before this field existed; the
      // controller treats NULL as stage = level.
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    status: {
      // STRING (not ENUM) so future states can be added without a Postgres ENUM alter.
      // Allowed: 'submitted' (level 0 only), 'pending', 'approved', 'rejected',
      // 'changes_requested', 'skipped' (deleted user / skipped level),
      // 'skipped_parallel' (a peer at the same parallel stage approved first),
      // 'cancelled_peer' (a peer at the same stage rejected/requested-changes).
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'pending',
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    attachmentUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    actionAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'task_approval_flows',
    timestamps: true,
    indexes: [
      // One row per (task, level). Prevents duplicate level rows under concurrent inserts.
      { unique: true, fields: ['taskId', 'level'], name: 'task_approval_flows_task_level_unique' },
      // "Which level is currently pending for this task?" — hot path on every action.
      { fields: ['taskId', 'status'], name: 'task_approval_flows_task_status_idx' },
      // "What needs my approval?" — dashboard / pending-approvals queries.
      { fields: ['userId', 'status'], name: 'task_approval_flows_user_status_idx' },
      // "What's the current stage for this task?" — replaces level-only lookups
      // now that stages can group parallel approvers.
      { fields: ['taskId', 'stage', 'status'], name: 'task_approval_flows_task_stage_status_idx' },
    ],
  }
);

module.exports = TaskApprovalFlow;
