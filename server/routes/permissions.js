const express = require('express');
const { authenticate, adminOnly, managerOrAdmin } = require('../middleware/auth');
const {
  getPermissions,
  grantPermission,
  bulkGrantPermissions,
  revokePermission,
  getEffective,
  getTemplates,
  applyTemplate,
} = require('../controllers/permissionController');

const router = express.Router();

router.get('/', authenticate, managerOrAdmin, getPermissions);
router.post('/', authenticate, managerOrAdmin, grantPermission);
router.post('/bulk', authenticate, adminOnly, bulkGrantPermissions);
router.delete('/:id', authenticate, managerOrAdmin, revokePermission);
router.get('/effective/:userId', authenticate, getEffective);
router.get('/templates', authenticate, getTemplates);
router.post('/apply-template', authenticate, adminOnly, applyTemplate);

module.exports = router;
