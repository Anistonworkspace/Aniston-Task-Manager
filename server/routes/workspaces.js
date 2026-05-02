const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
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
const { getForWorkspace, setOrder } = require('../controllers/boardOrderController');

const router = express.Router();

// Workspace mutation guard: manager and admin only (assistant_manager cannot manage workspaces)
const workspaceMutate = requireRole('manager', 'admin');

router.get('/', authenticate, getWorkspaces);
router.get('/mine', authenticate, getMyWorkspaces);   // must be before /:id
router.get('/archived', authenticate, workspaceMutate, getArchivedWorkspaces);  // must be before /:id
router.get('/:id', authenticate, getWorkspace);
router.put('/:id/restore', authenticate, workspaceMutate, restoreWorkspace);
router.post('/', authenticate, workspaceMutate, createWorkspace);
router.post('/from-template', authenticate, workspaceMutate, createFromTemplate);
router.put('/:id', authenticate, workspaceMutate, updateWorkspace);
router.delete('/:id', authenticate, workspaceMutate, deleteWorkspace);
router.post('/:id/boards', authenticate, workspaceMutate, assignBoard);
router.post('/:id/members', authenticate, workspaceMutate, assignMembers);
router.post('/:id/apply-template', authenticate, workspaceMutate, applyTemplate);
router.delete('/:id/members/:userId', authenticate, workspaceMutate, removeMember);

// ─── Per-user board ordering inside a workspace ─────────────────
// These deliberately live on the workspaces router so the URL convention
// matches /api/workspaces/:id/boards, /api/workspaces/:id/members, etc.
// They are gated only by `authenticate` because the controller enforces
// per-board visibility internally — a member should still be able to
// reorder their own visible boards even if they can't manage the workspace.
router.get('/:id/board-order', authenticate, getForWorkspace);
router.put('/:id/board-order', authenticate, setOrder);

module.exports = router;
