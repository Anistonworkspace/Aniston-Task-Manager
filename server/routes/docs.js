const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  // feat/docs-personal-notion Phase 2 — personal docs surface.
  listPersonalDocs,
  createPersonalDoc,
  // Phase 3 — manual-share endpoints (owner-only mutations on doc_access).
  listCollaborators,
  addCollaborator,
  updateCollaborator,
  removeCollaborator,
  // Single-doc surface — Phase 3 hardened with docAccessSvc.
  getDoc, updateDoc, archiveDoc, restoreDoc,
  listVersions, restoreVersion,
  // Phase D Slice 1 — @-mention picker backing endpoint.
  listMentionableUsers,
  // Phase D Slice 2 — task-chip picker backing endpoint.
  listSearchableTasks,
  // Phase G follow-up — admin migration to Y.js collab.
  migrateDocToCollab,
  // May 2026 — archive-page integration. Returns archived docs across
  // every workspace the caller can see + a permanent-delete affordance.
  listArchivedDocsForCaller,
  permanentDeleteDoc,
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

// feat/docs-personal-notion Phase 2 — personal docs list + create.
// Registered BEFORE the /:id catch-all so the bare `/` doesn't collide.
router.get('/', listPersonalDocs);
router.post('/', createPersonalDoc);

// Phase D Slice 1 — list users the caller can @-mention in the workspace.
// Registered BEFORE the /:id catch-all so "mentionable" doesn't get parsed
// as a doc id. The route requires ?workspaceId= in the query string.
router.get('/mentionable', listMentionableUsers);

// Phase D Slice 2 — search tasks the caller can reference inside a doc.
// Also BEFORE the /:id catch-all. Requires ?workspaceId= and optional &q=.
router.get('/searchable-tasks', listSearchableTasks);

// May 2026 — global archive integration. MUST sit before the /:id family
// so "archived" isn't parsed as a doc UUID by getDoc.
router.get('/archived', listArchivedDocsForCaller);

router.get('/:id',     getDoc);
router.patch('/:id',   updateDoc);   // autosave entry point
router.delete('/:id',  archiveDoc);
router.post('/:id/restore', restoreDoc);
// May 2026 — global archive integration. The base DELETE soft-archives;
// /permanent is the explicit destructive action surfaced from /archive.
router.delete('/:id/permanent', permanentDeleteDoc);

router.get('/:id/versions', listVersions);
router.post('/:id/versions/:versionId/restore', restoreVersion);

// Phase 3 — manual share / collaborator management. Owner-only mutations;
// list requires any access so existing collaborators can see who else has
// the doc.
router.get('/:id/collaborators', listCollaborators);
router.post('/:id/collaborators', addCollaborator);
router.patch('/:id/collaborators/:userId', updateCollaborator);
router.delete('/:id/collaborators/:userId', removeCollaborator);

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
