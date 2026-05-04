const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Notification = sequelize.define(
  'Notification',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.ENUM(
        'task_assigned',
        'task_supervisor_added',
        'task_role_changed',
        'task_removed',
        'task_updated',
        'comment_added',
        'due_date',
        'mention',
        // Phase 4: approval workflow events. Live in DB enum already (see
        // add-approval-notification-types.js) — listing them here so model-
        // level Notification.create() doesn't reject the value.
        'approval_submitted',
        'approval_approved',
        'approval_rejected',
        'approval_changes_requested',
        'approval_completed',
        // Daily Work / Recurring Task workflow. DB enum is extended by
        // server/scripts/create-recurring-task-templates.js (ALTER TYPE ADD VALUE).
        'recurring_generated',
        'recurring_missed',
        // Phase 3 — Dependency Request lifecycle. DB enum extended in the
        // boot auto-migration block in server.js and in
        // server/migrations/012_create_dependency_requests.sql.
        'dependency_requested',
        'dependency_accepted',
        'dependency_started',
        'dependency_done',
        'dependency_rejected',
        'dependency_cancelled',
        // Notification fix pass — keep model enum aligned with the DB enum
        // extended in server.js boot migrations. priority_change was missing
        // both places, breaking priorityEscalationJob silently.
        'deadline_2day',
        'deadline_2hour',
        'priority_change',
        // Governance / lifecycle events that were previously misusing
        // 'task_updated'. The DB enum is extended at boot in server.js so
        // existing prod DBs pick these up without an out-of-band migration.
        'access_requested',
        'access_approved',
        'access_rejected',
        'extension_requested',
        'extension_approved',
        'extension_rejected',
        'help_requested',
        'help_responded',
        'promotion',
        'board_member_added',
        'board_member_removed'
      ),
      allowNull: false,
    },
    message: {
      type: DataTypes.STRING(500),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Notification message is required' },
      },
    },
    entityType: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: null,
      comment: 'Type of entity this notification relates to (task, board, comment)',
    },
    entityId: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
      comment: 'UUID of the related entity',
    },
    isRead: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
  },
  {
    tableName: 'notifications',
    timestamps: true,
    indexes: [
      { fields: ['userId'] },
      { fields: ['isRead'] },
      { fields: ['type'] },
      { fields: ['userId', 'isRead'] },
    ],
  }
);

module.exports = Notification;
