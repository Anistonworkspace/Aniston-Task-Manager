const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// One row per external URL on a task. Stored relationally so each link has
// its own id (for individual delete/edit) and clear validation surface.
// `url` is the canonical href; `title` is the optional human label shown
// in the popover. Validation lives at the controller level so we can return
// a clean 400 instead of a Sequelize stack on bad input.
const TaskLink = sequelize.define('TaskLink', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  taskId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tasks', key: 'id' } },
  url: { type: DataTypes.STRING(2048), allowNull: false },
  title: { type: DataTypes.STRING(200), allowNull: true },
  position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  createdBy: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
}, {
  tableName: 'task_links',
  timestamps: true,
  indexes: [{ fields: ['taskId'] }, { fields: ['taskId', 'position'] }],
});

module.exports = TaskLink;
