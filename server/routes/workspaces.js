const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  getWorkspaces,
  getMyWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  assignBoard,
  assignMembers,
  removeMember,
  createFromTemplate,
  applyTemplate,
  getArchivedWorkspaces,
  restoreWorkspace,
} = require('../controllers/workspaceController');

const router = express.Router();

router.get('/', authenticate, getWorkspaces);
router.get('/mine', authenticate, getMyWorkspaces);   // must be before /:id
router.get('/archived', authenticate, managerOrAdmin, getArchivedWorkspaces);  // must be before /:id
router.get('/:id', authenticate, getWorkspace);
router.put('/:id/restore', authenticate, managerOrAdmin, restoreWorkspace);
router.post('/', authenticate, createWorkspace);
router.post('/from-template', authenticate, createFromTemplate);
router.put('/:id', authenticate, managerOrAdmin, updateWorkspace);
router.delete('/:id', authenticate, managerOrAdmin, deleteWorkspace);
router.post('/:id/boards', authenticate, managerOrAdmin, assignBoard);
router.post('/:id/members', authenticate, managerOrAdmin, assignMembers);
router.post('/:id/apply-template', authenticate, managerOrAdmin, applyTemplate);
router.delete('/:id/members/:userId', authenticate, managerOrAdmin, removeMember);

module.exports = router;
