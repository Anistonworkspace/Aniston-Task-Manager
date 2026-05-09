const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// A DependencyRequest is the "blocker work" Sunny asks Shubhanshu to do so her
// parent task can move forward. It does NOT create a Task row — that was the
// old behaviour and the source of the duplicate-task bug. Lifecycle lives on
// `status` (pending → accepted/working_on_it → done | rejected | cancelled);
// the parent task's blocked state is computed from the set of active rows.
const STATUSES = ['pending', 'accepted', 'working_on_it', 'done', 'rejected', 'cancelled'];
const ACTIVE_STATUSES = ['pending', 'accepted', 'working_on_it'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

const DependencyRequest = sequelize.define('DependencyRequest', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  parentTaskId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  title: {
    type: DataTypes.STRING(300),
    allowNull: false,
    validate: { notEmpty: true },
  },
  blockingReason: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  requestedByUserId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  assignedToUserId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  // Snapshot of who originally assigned the parent task to its current owner.
  // Captured at request-creation time so it survives parent reassignment and
  // we can show the full chain ("Super Admin → Sunny → Shubhanshu").
  originalAssignerUserId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  boardId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  workspaceId: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'pending',
    validate: { isIn: [STATUSES] },
  },
  priority: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'medium',
    validate: { isIn: [PRIORITIES] },
  },
  dueDate: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  // Lifecycle timestamps — set by the controller on the corresponding
  // transition. Kept as separate columns rather than a single audit log so
  // SLA reports ("how long did pending → done take?") are cheap.
  acceptedAt: { type: DataTypes.DATE, allowNull: true },
  startedAt: { type: DataTypes.DATE, allowNull: true },
  completedAt: { type: DataTypes.DATE, allowNull: true },
  rejectedAt: { type: DataTypes.DATE, allowNull: true },
  cancelledAt: { type: DataTypes.DATE, allowNull: true },
  rejectionReason: { type: DataTypes.TEXT, allowNull: true },
  cancellationReason: { type: DataTypes.TEXT, allowNull: true },
  completedByUserId: { type: DataTypes.UUID, allowNull: true },
  // Soft archive — separate from the `cancelled` status. Cancelled is a
  // lifecycle state ("we don't need this anymore"); archived is a UI state
  // ("hide from active views"). Mirrors the TaskDependency archive pattern.
  archivedAt: { type: DataTypes.DATE, allowNull: true },
  archivedBy: { type: DataTypes.UUID, allowNull: true },
  // Phase 13 — materialized "shadow" task for the assignee's board surface.
  // When the assignee transitions OUT of pending (accept / start / done), we
  // create a single Task on the parent's board owned by the assignee so the
  // dep work is visible alongside their other work. This column is the
  // idempotency key — set exactly once on first transition; subsequent
  // status changes sync TO this task instead of creating a new one. Stays
  // null for deps that are rejected straight from pending (no Task ever
  // appeared, nothing to clean up).
  linkedTaskId: {
    type: DataTypes.UUID,
    allowNull: true,
    defaultValue: null,
  },
}, {
  tableName: 'dependency_requests',
  timestamps: true,
  indexes: [
    { fields: ['parentTaskId'] },
    { fields: ['assignedToUserId', 'status'] },
    { fields: ['requestedByUserId', 'status'] },
    { fields: ['boardId'] },
    { fields: ['status'] },
    { fields: ['dueDate'] },
    { fields: ['createdAt'] },
    { fields: ['linkedTaskId'] },
  ],
});

DependencyRequest.STATUSES = STATUSES;
DependencyRequest.ACTIVE_STATUSES = ACTIVE_STATUSES;
DependencyRequest.PRIORITIES = PRIORITIES;

module.exports = DependencyRequest;
