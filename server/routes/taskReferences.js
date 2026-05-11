const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  listReferences, createReference, updateReference, deleteReference,
} = require('../controllers/taskReferenceController');

const router = express.Router();

// All routes require authentication. Per-task edit gating happens inside
// each controller via canEditTaskRefs() — keeping it at the controller
// layer means a request that's read-allowed but write-denied gets a clean
// 403 with a useful message, instead of bouncing here with no context.
router.get('/task/:taskId', authenticate, listReferences);
router.post('/', authenticate, createReference);
router.put('/:id', authenticate, updateReference);
router.delete('/:id', authenticate, deleteReference);

module.exports = router;
