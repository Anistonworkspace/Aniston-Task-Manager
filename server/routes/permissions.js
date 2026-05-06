const express = require('express');
const { authenticate, adminOnly, managerOrAdmin } = require('../middleware/auth');
const {
  getPermissions,
  grantPermission,
  bulkGrantPermissions,
  multiGrant,
  revokePermission,
  getEffective,
  getMyGrants,
  getTemplates,
  applyTemplate,
  getMetadata,
  getBasePermissionsForRole,
  getPermissionHistory,
} = require('../controllers/permissionController');

const router = express.Router();

// Static routes must be before /:id patterns
router.get('/my-grants', authenticate, getMyGrants);
router.get('/metadata', authenticate, getMetadata);
router.get('/base-permissions/:role', authenticate, getBasePermissionsForRole);
router.get('/templates', authenticate, getTemplates);

router.get('/', authenticate, managerOrAdmin, getPermissions);
router.post('/', authenticate, managerOrAdmin, grantPermission);
router.post('/bulk', authenticate, adminOnly, bulkGrantPermissions);
router.post('/multi', authenticate, managerOrAdmin, multiGrant);

// Phase 5e — closes audit P1-10. Previously this was auth-only, so any
// authenticated user could read another user's effective permissions
// (recon disclosure). Restrict to self OR management tier.
router.get('/effective/:userId', authenticate, (req, res, next) => {
  const { hasTierAtLeast } = require('../config/tiers');
  if (req.params.userId === req.user.id || hasTierAtLeast(req.user, 2)) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'You may only view your own effective permissions.',
  });
}, getEffective);
router.get('/history/:userId', authenticate, managerOrAdmin, getPermissionHistory);

router.delete('/:id', authenticate, managerOrAdmin, revokePermission);

router.post('/apply-template', authenticate, adminOnly, applyTemplate);

module.exports = router;
