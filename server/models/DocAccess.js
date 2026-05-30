'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * DocAccess — explicit per-user access grant for a Doc.
 *
 * feat/docs-personal-notion Phase 2. Replaces the legacy
 * canCallerSeeWorkspace fallback (workspace/board/role membership) with an
 * explicit table. Resolver rule:
 *
 *   hasDocAccess(user, doc) = user.isSuperAdmin
 *                          OR doc.ownerUserId === user.id
 *                          OR EXISTS(doc_access WHERE docId=doc.id AND userId=user.id)
 *
 * Sources:
 *   - 'owner'              — the doc's ownerUserId. Created at doc create time.
 *   - 'mention'            — a Phase-5 @-mention inserted the user. Removed
 *                            when the mention is removed AND no other source
 *                            covers them (see syncDocMentionsAndAccess).
 *   - 'manual_share'       — owner explicitly shared via the Share panel.
 *   - 'legacy_workspace'   — Phase-2 backfill row preserving the access this
 *                            user would have had under the old
 *                            canCallerSeeWorkspace rule. Auditable / prunable
 *                            from the Share panel.
 *
 * Access levels (highest to lowest):
 *   owner > edit > comment > view
 * Multiple insert paths never DOWNGRADE — see upsertAccess() in
 * services/docAccessService.js.
 */
const DocAccess = sequelize.define(
  'DocAccess',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    docId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'docs', key: 'id' },
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    accessLevel: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'view',
      validate: { isIn: [['owner', 'edit', 'comment', 'view']] },
    },
    source: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'manual_share',
      validate: { isIn: [['owner', 'mention', 'manual_share', 'legacy_workspace']] },
    },
    grantedByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      comment: 'Who created this grant. NULL for owner/mention/legacy_workspace rows.',
    },
  },
  {
    tableName: 'doc_access',
    timestamps: true,
    indexes: [
      { unique: true, fields: ['docId', 'userId'] },
      { fields: ['userId'] },
      { fields: ['docId'] },
    ],
  }
);

module.exports = DocAccess;
