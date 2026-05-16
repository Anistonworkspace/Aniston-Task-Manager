const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  getDoc, updateDoc, archiveDoc, restoreDoc,
  listVersions, restoreVersion,
} = require('../controllers/docController');

/**
 * /api/docs/:id family — flat routes for a single doc + its versions.
 *
 * The list / create routes live on /api/workspaces/:workspaceId/docs
 * (workspace-nested) and are wired separately in server.js. That mirrors
 * the existing pattern boards / tasks use.
 */

router.use(authenticate);

router.get('/:id',     getDoc);
router.patch('/:id',   updateDoc);   // autosave entry point
router.delete('/:id',  archiveDoc);
router.post('/:id/restore', restoreDoc);

router.get('/:id/versions', listVersions);
router.post('/:id/versions/:versionId/restore', restoreVersion);

module.exports = router;
