const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// Phase 2 — board-scoped reusable status tile group. Created/edited by
// Tier 1 / Tier 2 only; consumed by anyone who can see the board. The
// `statuses` JSONB column carries the ordered list:
//   [{ key, label, color, position }]
// `defaultStatusKey` MUST match one of the keys inside `statuses`; the
// controller validates this on write. `isDefault` flags one template per
// board as the board-wide default (partial unique index in migration 020).
const StatusTemplate = sequelize.define('StatusTemplate', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  boardId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'boards', key: 'id' },
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  statuses: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  defaultStatusKey: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  isDefault: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'status_templates',
  timestamps: true,
});

module.exports = StatusTemplate;
