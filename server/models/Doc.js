const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * Doc — personal document (Notion-style).
 *
 * feat/docs-personal-notion Phase 2: docs are personal/private by default.
 * Access is governed by `ownerUserId` + the `doc_access` table (see
 * services/docAccessService.js); workspaceId is informational metadata on
 * legacy rows only.
 *
 * Content lifecycle:
 *   - Tiptap JSON (legacy, contentFormat='tiptap_json')
 *   - BlockNote JSON (Phase 6, contentFormat='blocknote_json')
 *   - On in-place conversion, the original Tiptap JSON is preserved in
 *     `legacyContentJson` so the user never loses the original source.
 *
 * The `sharePolicy` ENUM column is retained for backward compat but no
 * longer drives access — the new flow uses doc_access rows directly.
 */
const Doc = sequelize.define(
  'Doc',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    workspaceId: {
      // feat/docs-personal-notion Phase 2: nullable. Docs are personal by
      // default; workspaceId is retained on legacy rows as informational
      // metadata only — it no longer governs access (doc_access does).
      // New docs created via POST /api/docs leave this NULL.
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'workspaces', key: 'id' },
      comment: 'Legacy metadata only — NOT the access source. doc_access is canonical.',
    },
    // feat/docs-personal-notion Phase 2: canonical owner. Backfilled from
    // createdBy for existing rows. Required for new docs (created via
    // POST /api/docs); the controller sets this to req.user.id.
    ownerUserId: {
      type: DataTypes.UUID,
      allowNull: true, // nullable so the SET NULL FK on user delete works
      references: { model: 'users', key: 'id' },
      comment: 'Doc owner. Canonical for access checks. Backfilled from createdBy on existing rows.',
    },
    // 'private' (only owner + explicit doc_access rows) or 'shared' (any
    // doc with one or more non-owner doc_access rows). visibility is a
    // denormalization for fast list filtering; the doc_access table is the
    // source of truth.
    visibility: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'private',
      validate: { isIn: [['private', 'shared']] },
    },
    // Tiptap (legacy) vs BlockNote (Phase 6). New docs default to
    // 'blocknote_json'; existing docs are marked 'tiptap_json' in the
    // Phase 2 boot migration so the editor knows which renderer to use.
    contentFormat: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'blocknote_json',
      validate: { isIn: [['tiptap_json', 'blocknote_json']] },
    },
    // Preserved Tiptap contentJson for any doc converted into BlockNote in
    // Phase 6+. NULL on docs that have not been converted (the live
    // contentJson is still their source of truth in their original format).
    legacyContentJson: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    title: {
      type: DataTypes.STRING(300),
      allowNull: false,
      defaultValue: 'Untitled doc',
      validate: {
        notEmpty: { msg: 'Doc title is required' },
        len: { args: [1, 300], msg: 'Doc title must be 1–300 characters' },
      },
    },
    // Doc body. Two shapes coexist (branched on `contentFormat` above):
    //   - blocknote_json (default) → `Block[]` (empty array seeds a
    //     single empty paragraph in the editor)
    //   - tiptap_json (legacy)     → `{ type: 'doc', content: [...] }`
    // Default is `[]` so any caller that omits contentJson on a new
    // BlockNote doc gets a valid empty seed. The previous Tiptap-shaped
    // default (`{ type:'doc', content:[] }`) was unreadable by BlockNote
    // and crashed the editor on first open (May 2026 regression).
    contentJson: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    // Plain-text shadow for full-text search. Server-derived from
    // contentJson on every save so consumers don't have to load JSON to
    // search. Indexed via Postgres GIN trigram (boot-time migration).
    contentText: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '',
    },
    // Slug for stable share links. Derived from title at creation; NOT
    // updated on rename (so existing share URLs stay valid).
    slug: {
      type: DataTypes.STRING(180),
      allowNull: true,
    },
    sharePolicy: {
      type: DataTypes.ENUM('private', 'workspace', 'public_link'),
      allowNull: false,
      defaultValue: 'workspace',
      comment: 'private = owner+explicit only · workspace = inherit ws perms · public_link = read-only via slug',
    },
    isArchived: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    archivedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    archivedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    lastEditedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      comment: 'Most recent author. Updated on every successful autosave.',
    },
    lastEditedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Updated on every successful save. Distinct from updatedAt which Sequelize bumps for any column change.',
    },
    // Doc Editor Phase G — Y.js CRDT state. Hocuspocus persists encoded
    // Y.doc updates (Y.encodeStateAsUpdate -> Uint8Array) into this BYTEA
    // column on debounced flushes. NULL on existing rows that predate
    // collab; the service either rejects collab for non-trivial legacy
    // docs (no auto-migration) or starts a fresh CRDT for empty docs.
    yjsState: {
      type: DataTypes.BLOB,
      allowNull: true,
      comment: 'Encoded Y.doc state (Y.encodeStateAsUpdate). Populated by Hocuspocus onStoreDocument. Source of truth for live collab once non-null.',
    },
  },
  {
    tableName: 'docs',
    timestamps: true,
    indexes: [
      { fields: ['workspaceId'] },
      { fields: ['createdBy'] },
      { fields: ['ownerUserId'] },
      { fields: ['visibility'] },
      { fields: ['isArchived'] },
      { fields: ['slug'] },
    ],
  }
);

module.exports = Doc;
