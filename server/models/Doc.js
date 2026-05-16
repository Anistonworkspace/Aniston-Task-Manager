const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * Doc — collaborative document inside a workspace.
 *
 * Phase B of the Doc Editor pillar. This model stores the Tiptap JSON
 * content as the source of truth, plus a plain-text shadow for full-text
 * search and a small set of metadata for permissioning + activity log
 * integration. Real-time collab state (Y.js) lives in a separate table
 * shipped later (Phase G); for Phase B every save is an HTTP autosave.
 *
 * Permissions model: by default a doc inherits its workspace's permissions.
 * `sharePolicy` overrides — see `doc_collaborators` (Phase F/H).
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
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'workspaces', key: 'id' },
      comment: 'Owning workspace. Permissions inherit from this workspace unless overridden.',
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
    // Tiptap-emitted JSON document. Source of truth. HTML and plain text
    // are derived on save (see contentText below).
    contentJson: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: { type: 'doc', content: [] },
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
  },
  {
    tableName: 'docs',
    timestamps: true,
    indexes: [
      { fields: ['workspaceId'] },
      { fields: ['createdBy'] },
      { fields: ['isArchived'] },
      { fields: ['slug'] },
    ],
  }
);

module.exports = Doc;
