const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getLabels, createLabel, updateLabel, deleteLabel, assignLabel, unassignLabel, getTaskLabels } = require('../controllers/labelController');
const router = express.Router();

router.get('/', authenticate, getLabels);
router.post('/', authenticate, createLabel);
router.put('/:id', authenticate, updateLabel);
router.delete('/:id', authenticate, deleteLabel);
router.post('/assign', authenticate, assignLabel);
router.post('/unassign', authenticate, unassignLabel);
router.get('/task/:taskId', authenticate, getTaskLabels);

module.exports = router;
