const { Op } = require('sequelize');
const { PromotionHistory, User, Notification, HierarchyLevel, ManagerRelation } = require('../models');
const { logActivity } = require('../services/activityService');
const { emitToUser } = require('../services/socketService');
const hierarchy = require('../services/hierarchyService');

// POST /api/promotions — promote a user
exports.promoteUser = async (req, res) => {
  try {
    const { userId, newRole, newTitle, newHierarchyLevel, notes, effectiveDate } = req.body;
    if (!userId || !newRole) {
      return res.status(400).json({ success: false, message: 'userId and newRole are required.' });
    }

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const promo = await PromotionHistory.create({
      userId, previousRole: user.hierarchyLevel || user.role, newRole: newHierarchyLevel || newRole,
      previousTitle: user.title || user.designation,
      newTitle: newTitle || null, promotedBy: req.user.id, notes: notes || null,
      effectiveDate: effectiveDate || new Date().toISOString().split('T')[0],
    });

    // Update user — set role, title, AND hierarchyLevel
    const updates = { title: newTitle || user.title };
    if (['admin', 'manager', 'assistant_manager', 'member'].includes(newRole)) {
      updates.role = newRole;
    }
    if (newHierarchyLevel) updates.hierarchyLevel = newHierarchyLevel;
    if (newTitle) updates.designation = newTitle;
    await user.update(updates);

    // Notify promoted user
    await Notification.create({
      type: 'task_updated', message: `Congratulations! You've been promoted to ${newTitle || newRole} by ${req.user.name}`,
      entityType: 'user', entityId: userId, userId,
    });
    emitToUser(userId, 'notification:new', { message: `You've been promoted to ${newTitle || newRole}!` });

    logActivity({ action: 'user_promoted', description: `${req.user.name} promoted ${user.name} to ${newTitle || newRole}`, entityType: 'user', entityId: userId, userId: req.user.id, meta: { previousRole: user.role, newRole, newTitle } });

    res.json({ success: true, data: { promotion: promo, user: await User.findByPk(userId) } });
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
exports.getOrgChart = async (req, res) => {
  try {
    const users = await User.findAll({
      where: { isActive: true, [Op.or]: [{ isSuperAdmin: false }, { isSuperAdmin: null }] },
      attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation', 'title', 'hierarchyLevel', 'managerId', 'department'],
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

    res.json({ success: true, data: { user: result.employee } });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, message: err.message });
    }
    console.error('[UpdateManager] error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update manager.' });
  }
};
