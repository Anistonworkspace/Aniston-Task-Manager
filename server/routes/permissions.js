const express = require('express');
const { body } = require('express-validator');
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
  getCatalog,
  getBasePermissionsForRole,
  getPermissionHistory,
} = require('../controllers/permissionController');

const router = express.Router();

// Static routes must be before /:id patterns
router.get('/my-grants', authenticate, getMyGrants);
router.get('/metadata', authenticate, getMetadata);
// Canonical permission catalog (Phase 6). Manager/admin only — used by the
// Permission Overrides UI to populate resources, actions, and grantability
// flags. Members do not need this and may not introspect the override surface.
router.get('/catalog', authenticate, managerOrAdmin, getCatalog);
router.get('/base-permissions/:role', authenticate, getBasePermissionsForRole);
router.get('/templates', authenticate, getTemplates);

router.get('/', authenticate, managerOrAdmin, getPermissions);
router.post(
  '/',
  authenticate,
  managerOrAdmin,
  // Validator chain. The permission controller does not currently consume
  // validationResult, so these checks are defence-in-depth scaffolding.
  [
    body('userId').isUUID().withMessage('userId must be a valid UUID'),
    body('resourceType').isString().notEmpty().withMessage('resourceType is required'),
    body('action').optional().isString(),
    body('effect').optional().isIn(['grant', 'deny']).withMessage('effect must be grant|deny'),
  ],
  grantPermission
);
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
// Phase 6 — Permission history is restricted to SELF or Tier 1. Previously
// any Tier-2 user could read any other Tier-2's permission-modification
// timeline (recon disclosure across peer admins). The change matches the
// org-wide privacy expectation that override history is sensitive metadata.
router.get('/history/:userId', authenticate, (req, res, next) => {
  const { hasTierAtLeast } = require('../config/tiers');
  if (req.params.userId === req.user.id || hasTierAtLeast(req.user, 1)) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Only Tier 1 (or the user themselves) may view permission history.',
  });
}, getPermissionHistory);

router.delete('/:id', authenticate, managerOrAdmin, revokePermission);

router.post('/apply-template', authenticate, adminOnly, applyTemplate);

module.exports = router;
