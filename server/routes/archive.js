const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getArchivedDependencies, permanentDeleteDependency, restoreDependency } = require('../controllers/dependencyController');
const { getArchivedHelpRequests, permanentDeleteHelpRequest, restoreHelpRequest } = require('../controllers/helpRequestController');

const router = express.Router();
router.use(authenticate);

// Phase A.2 follow-up (May 2026 RBAC hardening — bug report 2026-05-16).
// Pre-fix: every route below used `managerOrAdmin`, a pure tier check that
// ignored explicit `archive.*` PermissionGrant rows. An admin granting
// `archive.view` to a Tier 4 user (e.g. Sunny Mehta) saw the user reach
// the Archive page (route guard honours the grant) but the in-page fetches
// for dependencies / help-requests 403'd, producing the "Access denied.
// Manager or admin privileges required." toast the user reported.
//
// Fix: route VIEW through the engine so the grant is honoured. For
// destructive routes (restore + permanent_delete) we keep the legacy
// tier path as a fallback so admins / managers — who currently delete
// archived items as part of routine ops — don't lose that ability without
// an explicit grant. The `tierOrPermission` helper passes if EITHER the
// engine grants OR the tier middleware would have.
function tierOrPermission(tierMiddleware, resource, action) {
  const enginePermission = require('../services/permissionEngine');
  return async (req, res, next) => {
    if (req.user?.isSuperAdmin) return next();
    try {
      const allowed = await enginePermission.hasPermission(req.user, resource, action);
      if (allowed) return next();
    } catch (err) {
      console.warn('[archive] permission engine check failed, falling back to tier:', err.message);
    }
    return tierMiddleware(req, res, next);
  };
}

// Archived dependencies
router.get(   '/dependencies',             requirePermission('archive', 'view'),                                     getArchivedDependencies);
router.put(   '/dependencies/:id/restore', tierOrPermission(managerOrAdmin, 'archive', 'restore'),                   restoreDependency);
router.delete('/dependencies/:id',         tierOrPermission(managerOrAdmin, 'archive', 'permanent_delete'),          permanentDeleteDependency);

// Archived help requests
router.get(   '/help-requests',             requirePermission('archive', 'view'),                                    getArchivedHelpRequests);
router.put(   '/help-requests/:id/restore', tierOrPermission(managerOrAdmin, 'archive', 'restore'),                  restoreHelpRequest);
router.delete('/help-requests/:id',         tierOrPermission(managerOrAdmin, 'archive', 'permanent_delete'),         permanentDeleteHelpRequest);

module.exports = router;
