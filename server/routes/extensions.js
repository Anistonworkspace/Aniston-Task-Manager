const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { isHierarchyManager } = require('../middleware/taskPermissions');
const { requestExtension, getExtensions, approveExtension, rejectExtension } = require('../controllers/dueDateExtensionController');
const router = express.Router();

// Allow managers/admins OR hierarchy managers to approve/reject extensions
const managerOrAdminOrHierarchy = async (req, res, next) => {
  if (req.user && (['admin', 'manager'].includes(req.user.role) || req.user.isSuperAdmin)) {
    return next();
  }
  // Check if member is a hierarchy manager
  if (req.user && req.user.role === 'member') {
    const isHierMgr = await isHierarchyManager(req.user, req);
    if (isHierMgr) return next();
  }
  return res.status(403).json({ success: false, message: 'Access denied. Manager or admin privileges required.' });
};

router.post('/', authenticate, requestExtension);
router.get('/', authenticate, getExtensions);
router.put('/:id/approve', authenticate, managerOrAdminOrHierarchy, approveExtension);
router.put('/:id/reject', authenticate, managerOrAdminOrHierarchy, rejectExtension);

module.exports = router;
