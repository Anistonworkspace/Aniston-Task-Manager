const express = require('express');
const router = express.Router();
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const ctrl = require('../controllers/hierarchyController');

// Hierarchy levels are part of org_chart — guard with the same canonical
// permission resolver so explicit DENY overrides apply here too.
router.get('/', authenticate, requirePermission('org_chart', 'view'), ctrl.getAll);
router.post('/', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), ctrl.create);
router.put('/reorder', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), ctrl.reorder);
router.put('/:id', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), ctrl.update);
router.delete('/:id', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), ctrl.remove);

module.exports = router;
