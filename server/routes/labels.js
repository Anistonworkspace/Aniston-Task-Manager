const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { getLabels, createLabel, updateLabel, deleteLabel, assignLabel, unassignLabel, getTaskLabels } = require('../controllers/labelController');
const router = express.Router();

// Read operations: any authenticated user
router.get('/', authenticate, getLabels);
router.get('/task/:taskId', authenticate, getTaskLabels);

// Write operations: manager+ only
router.post('/', authenticate, managerOrAdmin, createLabel);
router.put('/:id', authenticate, managerOrAdmin, updateLabel);
router.delete('/:id', authenticate, managerOrAdmin, deleteLabel);
router.post('/assign', authenticate, managerOrAdmin, assignLabel);
router.post('/unassign', authenticate, managerOrAdmin, unassignLabel);

module.exports = router;
