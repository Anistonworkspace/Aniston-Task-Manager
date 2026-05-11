const express = require('express');
const { body, param } = require('express-validator');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { isHierarchyManager } = require('../middleware/taskPermissions');
const { isTier4 } = require('../config/tiers');
const { requestExtension, getExtensions, approveExtension, rejectExtension } = require('../controllers/dueDateExtensionController');
const router = express.Router();

// Allow managers/admins OR hierarchy managers to approve/reject extensions
const managerOrAdminOrHierarchy = async (req, res, next) => {
  if (req.user && (['admin', 'manager'].includes(req.user.role) || req.user.isSuperAdmin)) {
    return next();
  }
  // Check if member is a hierarchy manager
  if (req.user && isTier4(req.user)) {
    const isHierMgr = await isHierarchyManager(req.user, req);
    if (isHierMgr) return next();
  }
  return res.status(403).json({ success: false, message: 'Access denied. Manager or admin privileges required.' });
};

// Validator chains. The dueDateExtension controller does not currently
// consume validationResult, so these checks are defence-in-depth scaffolding.
router.post(
  '/',
  authenticate,
  [
    body('taskId').isUUID().withMessage('taskId must be a valid UUID'),
    body('proposedDueDate').isISO8601().withMessage('proposedDueDate must be ISO8601'),
    body('reason').isString().trim().isLength({ min: 1, max: 1000 }).withMessage('reason is required (1-1000 chars)'),
  ],
  requestExtension
);
router.get('/', authenticate, getExtensions);
router.put(
  '/:id/approve',
  authenticate,
  managerOrAdminOrHierarchy,
  [ param('id').isUUID().withMessage('id must be a valid UUID') ],
  approveExtension
);
router.put(
  '/:id/reject',
  authenticate,
  managerOrAdminOrHierarchy,
  [ param('id').isUUID().withMessage('id must be a valid UUID') ],
  rejectExtension
);

module.exports = router;
