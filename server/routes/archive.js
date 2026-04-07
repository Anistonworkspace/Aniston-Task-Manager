const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { getArchivedDependencies, permanentDeleteDependency, restoreDependency } = require('../controllers/dependencyController');
const { getArchivedHelpRequests, permanentDeleteHelpRequest, restoreHelpRequest } = require('../controllers/helpRequestController');

const router = express.Router();
router.use(authenticate);

// Archived dependencies
router.get('/dependencies', managerOrAdmin, getArchivedDependencies);
router.put('/dependencies/:id/restore', managerOrAdmin, restoreDependency);
router.delete('/dependencies/:id', managerOrAdmin, permanentDeleteDependency);

// Archived help requests
router.get('/help-requests', managerOrAdmin, getArchivedHelpRequests);
router.put('/help-requests/:id/restore', managerOrAdmin, restoreHelpRequest);
router.delete('/help-requests/:id', managerOrAdmin, permanentDeleteHelpRequest);

module.exports = router;
