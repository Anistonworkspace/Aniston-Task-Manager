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

router.get('/effective/:userId', authenticate, getEffective);
router.get('/history/:userId', authenticate, managerOrAdmin, getPermissionHistory);

router.delete('/:id', authenticate, managerOrAdmin, revokePermission);

router.post('/apply-template', authenticate, adminOnly, applyTemplate);

module.exports = router;
