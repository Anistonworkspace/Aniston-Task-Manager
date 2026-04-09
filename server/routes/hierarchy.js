const express = require('express');
const router = express.Router();
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/hierarchyController');

router.get('/', authenticate, ctrl.getAll);
router.post('/', authenticate, managerOrAdmin, ctrl.create);
router.put('/reorder', authenticate, managerOrAdmin, ctrl.reorder);
router.put('/:id', authenticate, managerOrAdmin, ctrl.update);
router.delete('/:id', authenticate, managerOrAdmin, ctrl.remove);

module.exports = router;
