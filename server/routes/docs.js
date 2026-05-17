const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  getDoc, updateDoc, archiveDoc, restoreDoc,
  listVersions, restoreVersion,
  // Phase D Slice 1 — @-mention picker backing endpoint.
  listMentionableUsers,
  // Phase D Slice 2 — task-chip picker backing endpoint.
  listSearchableTasks,
  // Phase G follow-up — admin migration to Y.js collab.
  migrateDocToCollab,
} = require('../controllers/docController');
// Phase F — selection-anchored doc comments (Notion/Google Docs style).
const {
  listComments,
  createComment,
  updateComment,
  deleteComment,
  resolveComment,
  unresolveComment,
} = require('../controllers/docCommentController');

/**
 * /api/docs/:id family — flat routes for a single doc + its versions.
 *
 * The list / create routes live on /api/workspaces/:workspaceId/docs
 * (workspace-nested) and are wired separately in server.js. That mirrors
 * the existing pattern boards / tasks use.
 */

router.use(authenticate);

// Phase D Slice 1 — list users the caller can @-mention in the workspace.
// Registered BEFORE the /:id catch-all so "mentionable" doesn't get parsed
// as a doc id. The route requires ?workspaceId= in the query string.
router.get('/mentionable', listMentionableUsers);

// Phase D Slice 2 — search tasks the caller can reference inside a doc.
// Also BEFORE the /:id catch-all. Requires ?workspaceId= and optional &q=.
router.get('/searchable-tasks', listSearchableTasks);

router.get('/:id',     getDoc);
router.patch('/:id',   updateDoc);   // autosave entry point
router.delete('/:id',  archiveDoc);
router.post('/:id/restore', restoreDoc);

router.get('/:id/versions', listVersions);
router.post('/:id/versions/:versionId/restore', restoreVersion);

// Phase G follow-up — owner/admin opt-in migration of an existing doc to
// Y.js collab. Snapshots the current contentJson to version history,
// then resets yjsState to a clean empty Y.doc.
router.post('/:id/migrate-to-collab', migrateDocToCollab);

// Phase F — threaded comments. Listed AFTER the bare /:id family so
// /comments doesn't shadow them. The specific commentId routes go
// before the resolve/unresolve POSTs in the file to keep the order
// readable but Express matches by exact path so order is non-critical here.
router.get('/:id/comments', listComments);
router.post('/:id/comments', createComment);
router.patch('/:id/comments/:commentId', updateComment);
router.delete('/:id/comments/:commentId', deleteComment);
router.post('/:id/comments/:commentId/resolve', resolveComment);
router.post('/:id/comments/:commentId/unresolve', unresolveComment);

module.exports = router;
