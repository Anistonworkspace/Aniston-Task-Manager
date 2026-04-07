const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Automation = sequelize.define('Automation', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING(200), allowNull: false },
  boardId: { type: DataTypes.UUID, allowNull: false },
  trigger: {
    type: DataTypes.STRING(50), allowNull: false,
    // status_changed, task_created, task_assigned, due_date_arrived, task_moved
  },
  triggerValue: { type: DataTypes.STRING(100), allowNull: true }, // e.g. 'done', specific status
  action: {
    type: DataTypes.STRING(50), allowNull: false,
    // notify_user, change_status, change_priority, move_to_group, assign_to, send_notification
  },
  actionConfig: { type: DataTypes.JSONB, defaultValue: {}, allowNull: false },
  // { targetStatus, targetPriority, targetGroupId, targetUserId, notifyMessage }
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  createdBy: { type: DataTypes.UUID, allowNull: false },
}, {
  tableName: 'automations',
  timestamps: true,
  indexes: [{ fields: ['boardId'] }, { fields: ['trigger'] }, { fields: ['isActive'] }],
});

module.exports = Automation;
