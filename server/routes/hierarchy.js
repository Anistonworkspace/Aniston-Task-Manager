const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const ctrl = require('../controllers/hierarchyController');

router.get('/', authenticate, ctrl.getAll);
router.post('/', authenticate, adminOnly, ctrl.create);
router.put('/reorder', authenticate, adminOnly, ctrl.reorder);
router.put('/:id', authenticate, adminOnly, ctrl.update);
router.delete('/:id', authenticate, adminOnly, ctrl.remove);

module.exports = router;
