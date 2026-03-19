const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  getTaskDependencies,
  createDependency,
  removeDependency,
  delegateTask,
  assignDependency,
} = require('../controllers/dependencyController');

const router = express.Router();

router.use(authenticate);

// Dependencies
router.get('/tasks/:taskId/dependencies', getTaskDependencies);
router.post('/tasks/:taskId/dependencies', createDependency);
router.post('/tasks/:taskId/dependencies/assign', assignDependency);
router.delete('/tasks/:taskId/dependencies/:dependencyId', managerOrAdmin, removeDependency);

// Delegation
router.post('/tasks/:taskId/delegate', delegateTask);

module.exports = router;
