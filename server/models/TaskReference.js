const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// One row per reference entry on a task. References are free-form text
// (ticket IDs, doc names, external system IDs, notes) — stored relationally
// rather than in a JSONB blob so each entry has its own id for delete/edit
// without optimistic-concurrency headaches when two users edit at once.
const TaskReference = sequelize.define('TaskReference', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  taskId: { type: DataTypes.UUID, allowNull: false, references: { model: 'tasks', key: 'id' } },
  text: {
    type: DataTypes.STRING(500),
    allowNull: false,
    validate: { notEmpty: true, len: [1, 500] },
  },
  position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  createdBy: { type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
}, {
  tableName: 'task_references',
  timestamps: true,
  indexes: [{ fields: ['taskId'] }, { fields: ['taskId', 'position'] }],
});

module.exports = TaskReference;
