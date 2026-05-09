const { Op } = require('sequelize');
const { PromotionHistory, User, Notification, HierarchyLevel, ManagerRelation } = require('../models');
const { logActivity } = require('../services/activityService');
const { emitToUser, broadcastAll } = require('../services/socketService');
const hierarchy = require('../services/hierarchyService');
const { createNotification, buildIdempotencyKey } = require('../services/notificationService');
const tiers = require('../config/tiers');

// Sensitive User columns that must NEVER appear in API responses. Centralised
// here so every endpoint that returns a user goes through the same allowlist.
const USER_RESPONSE_EXCLUDE = Object.freeze([
  'password',
  'passwordResetToken',
  'passwordResetExpires',
  'teamsAccessToken',
  'teamsRefreshToken',
  'teamsTokenExpiry',
]);

// POST /api/promotions — promote a user
//
// SECURITY: this endpoint can change a user's role/tier. Every gate matters.
//
//   1. Caller must be Tier 1 or Tier 2 (route middleware: managerOrAdmin +
//      requirePermission('org_chart','manage')).
//   2. Caller must have edit-scope on the target via canManageUser. Without
//      this, a Tier-2 manager could promote any user in any branch — the
//      original P0 escalation surface flagged by the audit.
//   3. Tier grants are validated by tiers.assertCanGrantTier — a Tier 2 actor
//      can grant Tier 3 / Tier 4 only; Tier 1 grants are reserved for Tier 1.
//   4. If the target is the only active Tier 1, demoting them is blocked.
//   5. Response NEVER includes password / token columns.
exports.promoteUser = async (req, res) => {
  try {
    const { userId, newRole, newTitle, newHierarchyLevel, notes, effectiveDate } = req.body;
    if (!userId || !newRole) {
      return res.status(400).json({ success: false, message: 'userId and newRole are required.' });
    }

    // Whitelist newRole — request-validators rely on this enum. Reject early
    // so we don't risk writing arbitrary strings into users.role.
    if (!['admin', 'manager', 'assistant_manager', 'member'].includes(newRole)) {
      return res.status(400).json({ success: false, message: 'Invalid newRole.' });
    }

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // Block promoting yourself — handled by canManageUser too (sameUser falls
    // into 'self' scope which doesn't allow role changes), but explicit early
    // return gives a clearer error.
    if (String(req.user.id) === String(userId)) {
      return res.status(403).json({ success: false, message: 'You cannot change your own tier.' });
    }

    // (2) Branch / role-scope check — refuses if actor cannot edit identity
    // fields on this target (managers outside their subtree, assistant
    // managers above their subtree, members on anyone, etc.).
    const auth = await hierarchy.canManageUser(req.user, user);
    if (!auth.allowed || auth.scope !== 'full') {
      return res.status(403).json({
        success: false,
        message: auth.reason || 'You do not have permission to change this user\'s tier.',
      });
    }

    // (3) Tier-grant authority — the canonical "can actor grant THIS tier?".
    // Convert the legacy newRole to a tier and pass through assertCanGrantTier.
    // Tier 1 promotions arrive as newRole='admin' AND a separate isSuperAdmin
    // flag, but this endpoint never accepts isSuperAdmin in its body — Tier 1
    // promotions go through Admin Settings on a different route. So a Tier 1
    // grant is impossible here, by construction.
    const proposedTier = tiers.tierFromLegacy(newRole, /* isSuperAdmin */ false);
    try {
      tiers.assertCanGrantTier(req.user, user, proposedTier);
    } catch (e) {
      return res.status(e.status || 403).json({ success: false, message: e.message });
    }

    // (4) Last-Tier-1 protection — if THIS promotion would demote the only
    // remaining Tier 1, refuse. Async — queries User model for other active
    // Tier 1 users.
    if (tiers.isTier1(user) && proposedTier !== tiers.TIER_1) {
      try {
        await tiers.assertNotLastTier1Change(user, 'demote', User);
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, message: e.message });
      }
    }

    const promo = await PromotionHistory.create({
      userId, previousRole: user.hierarchyLevel || user.role, newRole: newHierarchyLevel || newRole,
      previousTitle: user.title || user.designation,
      newTitle: newTitle || null, promotedBy: req.user.id, notes: notes || null,
      effectiveDate: effectiveDate || new Date().toISOString().split('T')[0],
    });

    // Update user — set role, title, AND hierarchyLevel
    const updates = { title: newTitle || user.title, role: newRole };
    if (newHierarchyLevel) updates.hierarchyLevel = newHierarchyLevel;
    if (newTitle) updates.designation = newTitle;
    await user.update(updates);

    // Notify promoted user — use the dedicated 'promotion' enum + standard
    // payload shape so the bell toast/push fire correctly. Idempotent on
    // the promotion record id so a retried POST cannot double-notify.
    const { sanitizeNotificationField, sanitizeNotificationMessage } = require('../utils/sanitize');
    const promoMsg = sanitizeNotificationMessage(
      `Congratulations! You've been promoted to ${sanitizeNotificationField(newTitle || newRole, 80)} ` +
      `by ${sanitizeNotificationField(req.user.name)}`
    );
    await createNotification({
      userId,
      type: 'promotion',
      message: promoMsg,
      entityType: 'user',
      entityId: userId,
      idempotencyKey: buildIdempotencyKey('promotion', promo.id),
      sanitize: false,
    });

    logActivity({ action: 'user_promoted', description: `${req.user.name} promoted ${user.name} to ${newTitle || newRole}`, entityType: 'user', entityId: userId, userId: req.user.id, meta: { previousRole: user.role, newRole, newTitle } });

    // (5) Re-fetch with explicit attribute exclusion so we never return
    // password/teamsAccessToken/etc. The original implementation called
    // findByPk() with no `attributes` filter and shipped the whole row.
    const safeUser = await User.findByPk(userId, { attributes: { exclude: USER_RESPONSE_EXCLUDE } });

    // Realtime — broadcast a tree-shape change so any open Org Chart tab
    // refetches without manual reload. Payload is intentionally minimal: the
    // affected user id + actor id. Each viewer's GET request is permission-
    // gated, so a stale event reaching a forbidden viewer is harmless.
    try {
      broadcastAll('org:hierarchy:changed', {
        type: 'promotion',
        userId,
        actorId: req.user.id,
        timestamp: new Date().toISOString(),
      });
    } catch (e) { /* socket optional */ }

    res.json({ success: true, data: { promotion: promo, user: safeUser } });
  } catch (err) {
    console.error('[Promotion] error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to promote user.' });
  }
};

// GET /api/promotions/:userId — get promotion history
exports.getPromotionHistory = async (req, res) => {
  try {
    const history = await PromotionHistory.findAll({
      where: { userId: req.params.userId },
      include: [{ model: User, as: 'promoter', attributes: ['id', 'name'] }],
      order: [['effectiveDate', 'DESC']],
    });
    res.json({ success: true, data: { promotions: history } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch promotion history.' });
  }
};

// GET /api/promotions/org-chart — organizational hierarchy
//
// Tier 1 users were previously filtered out of this response via an
// `isSuperAdmin = false` predicate. That hid them from the chart entirely
// (the screenshot's "Tier 1: 0" stat) and broke the user-expected behaviour
// that Tier 1 leadership appears as the top-level root nodes. Tier 1 users
// have no managerId by design, so they fall naturally into the `roots[]`
// branch of the tree-build pass below.
exports.getOrgChart = async (req, res) => {
  try {
    const users = await User.findAll({
      where: { isActive: true },
      attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation', 'title', 'hierarchyLevel', 'managerId', 'department', 'isSuperAdmin', 'tier'],
      order: [['name', 'ASC']],
    });

    // Fetch all manager relations (multi-manager support)
    const allRelations = await ManagerRelation.findAll({
      include: [{ model: User, as: 'manager', attributes: ['id', 'name', 'avatar', 'role', 'designation'] }],
      order: [['isPrimary', 'DESC'], ['createdAt', 'ASC']],
    });

    // Group relations by employeeId
    const relationsByEmployee = {};
    allRelations.forEach(r => {
      const eid = r.employeeId;
      if (!relationsByEmployee[eid]) relationsByEmployee[eid] = [];
      relationsByEmployee[eid].push(r.toJSON());
    });

    // Build hierarchy graph (multi-manager: employee appears under every manager)
    const userMap = {};
    users.forEach(u => {
      userMap[u.id] = {
        ...u.toJSON(),
        children: [],
        managerRelations: relationsByEmployee[u.id] || [],
        _isSecondaryRef: false,
      };
    });

    const roots = [];
    const placedUnderManager = new Set(); // track which users got placed via relations (canonical node)

    // Place employees under their managers from the junction table
    Object.entries(relationsByEmployee).forEach(([employeeId, rels]) => {
      if (!userMap[employeeId]) return;

      // Sort: primary first, then by createdAt — the first valid relation gets canonical placement
      const sorted = [...rels].sort((a, b) => {
        if (a.isPrimary && !b.isPrimary) return -1;
        if (!a.isPrimary && b.isPrimary) return 1;
        return new Date(a.createdAt) - new Date(b.createdAt);
      });

      let canonicalPlaced = false;

      sorted.forEach(rel => {
        if (!userMap[rel.managerId]) return;
        if (!canonicalPlaced) {
          // First valid relation (primary, or first secondary if no primary): canonical placement
          userMap[rel.managerId].children.push(userMap[employeeId]);
          placedUnderManager.add(employeeId);
          canonicalPlaced = true;
        } else {
          // Additional relations: create a reference node (no children to avoid duplication)
          const refNode = {
            ...userMap[employeeId],
            children: [],
            _isSecondaryRef: true,
            _secondaryRelationType: rel.relationType,
            _secondaryManagerId: rel.managerId,
          };
          userMap[rel.managerId].children.push(refNode);
        }
      });
    });

    // Fallback: users with managerId but no junction table record (legacy data)
    users.forEach(u => {
      if (placedUnderManager.has(u.id)) return; // already handled via relations
      if (u.managerId && userMap[u.managerId]) {
        userMap[u.managerId].children.push(userMap[u.id]);
        placedUnderManager.add(u.id);
      } else if (!placedUnderManager.has(u.id)) {
        roots.push(userMap[u.id]);
      }
    });

    // Also return users grouped by hierarchy level
    let hierarchyLevels = [];
    const usersByLevel = {};
    try {
      hierarchyLevels = await HierarchyLevel.findAll({
        where: { isActive: true },
        order: [['order', 'DESC']],
      });
      hierarchyLevels.forEach(level => {
        const levelUsers = users.filter(u => u.hierarchyLevel === level.name).map(u => ({
          ...u.toJSON(),
          managerRelations: relationsByEmployee[u.id] || [],
        }));
        usersByLevel[level.name] = { level: level.toJSON(), users: levelUsers };
      });
    } catch (hlErr) {
      console.error('[OrgChart] HierarchyLevel lookup error:', hlErr.message);
    }

    // Enrich allUsers with managerRelations so the frontend side panel always has relation data
    const enrichedUsers = users.map(u => ({
      ...u.toJSON(),
      managerRelations: relationsByEmployee[u.id] || [],
    }));

    res.json({ success: true, data: { orgChart: roots, allUsers: enrichedUsers, usersByLevel, hierarchyLevels } });
  } catch (err) {
    console.error('[OrgChart] error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build org chart.' });
  }
};

// PUT /api/promotions/update-manager — change or remove reporting structure
//
// Body: { userId, managerId }   (managerId === null/'' → make root)
//
// Delegates to hierarchyService.setPrimaryManager / removePrimaryManager,
// which handle:
//   - branch-scope authorization (manager only inside own subtree)
//   - cycle detection across both User.managerId and manager_relations
//   - transactional update of BOTH the User row and the junction table
//   - subtree preservation (employee's own children stay attached)
exports.updateManager = async (req, res) => {
  try {
    const { userId, managerId: rawManagerId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }
    // Treat empty-string as null (frontend sometimes posts '' to mean "remove").
    const managerId = rawManagerId === '' || rawManagerId === undefined ? null : rawManagerId;

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    let result;
    let action;
    if (managerId === null) {
      result = await hierarchy.removePrimaryManager(userId, req.user);
      action = 'manager_removed';
    } else {
      result = await hierarchy.setPrimaryManager(userId, managerId, req.user);
      action = 'manager_updated';
    }

    logActivity({
      action,
      description: managerId === null
        ? `${req.user.name} removed ${user.name}'s primary manager (made root)`
        : `${req.user.name} changed ${user.name}'s primary manager`,
      entityType: 'user',
      entityId: userId,
      userId: req.user.id,
      meta: {
        previousManagerId: result.previousManagerId,
        newManagerId: managerId,
        ...(result.removedRelationCount !== undefined && { removedRelationCount: result.removedRelationCount }),
      },
    });

    // Broadcast so other tabs / users with the Org Chart open refetch the
    // tree without manual reload. Permission-gated GET means a stale event
    // reaching a forbidden viewer is a no-op (their refetch 403s and they
    // see the AccessDenied screen, same as before).
    try {
      broadcastAll('org:hierarchy:changed', {
        type: action,
        userId,
        previousManagerId: result.previousManagerId || null,
        newManagerId: managerId || null,
        actorId: req.user.id,
        timestamp: new Date().toISOString(),
      });
    } catch (e) { /* socket optional */ }

    // Re-fetch with explicit attribute exclusion. setPrimaryManager / remove
    // returns a User row that may otherwise expose tokens. The audit flagged
    // this as part of B6 — fix uniformly across all hierarchy responses.
    const safeUser = await User.findByPk(userId, { attributes: { exclude: USER_RESPONSE_EXCLUDE } });
    res.json({ success: true, data: { user: safeUser } });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    console.error('[UpdateManager] error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update manager.' });
  }
};
