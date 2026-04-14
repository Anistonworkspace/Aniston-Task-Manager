const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * Explicit model for the BoardMembers join table.
 *
 * `autoAdded` tracks HOW the membership was created:
 *   true  → user was auto-added because a task was assigned to them on this board
 *   false → user was explicitly added via Board Settings / addMember endpoint
 *
 * On task unassignment, only autoAdded=true rows are eligible for cleanup.
 */
const BoardMember = sequelize.define('BoardMember', {
  boardId: {
    type: DataTypes.UUID,
    allowNull: false,
    primaryKey: true,
    references: { model: 'boards', key: 'id' },
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    primaryKey: true,
    references: { model: 'users', key: 'id' },
  },
  autoAdded: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
}, {
  tableName: 'BoardMembers',
  timestamps: true,
});

module.exports = BoardMember;
