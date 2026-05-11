const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// Composite primary key on (taskId, labelId) — matches the live DB schema
// created by the boot DDL in server.js (CREATE TABLE task_labels ... PRIMARY KEY
// ("taskId", "labelId")). Earlier revisions of this model declared a separate
// UUID `id` PK which never matched the DB; aligning to the composite PK avoids
// a Sequelize sync attempting to add an `id` column with a conflicting PK.
// No callers use TaskLabel.findByPk(uuid) (verified via grep) — junction-table
// rows are always located by the (taskId, labelId) pair.
const TaskLabel = sequelize.define('TaskLabel', {
  taskId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: 'tasks', key: 'id' } },
  labelId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, references: { model: 'labels', key: 'id' } },
}, { tableName: 'task_labels', timestamps: true });

module.exports = TaskLabel;
