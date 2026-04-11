const { Op } = require('sequelize');
const { PromotionHistory, User, Notification, HierarchyLevel, ManagerRelation } = require('../models');
const { logActivity } = require('../services/activityService');
const { emitToUser } = require('../services/socketService');

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
    const placedUnderManager = new Set(); // track which users got placed via relations

    // Place employees under ALL their managers from the junction table
    Object.entries(relationsByEmployee).forEach(([employeeId, rels]) => {
      if (!userMap[employeeId]) return;
      rels.forEach(rel => {
        if (!userMap[rel.managerId]) return;
        if (rel.isPrimary) {
          // Primary: use the canonical node
          userMap[rel.managerId].children.push(userMap[employeeId]);
          placedUnderManager.add(employeeId);
        } else {
          // Secondary: create a duplicate reference node
          const refNode = {
            ...userMap[employeeId],
            children: [], // secondary refs don't show their own subtree to avoid duplication
            _isSecondaryRef: true,
            _secondaryRelationType: rel.relationType,
            _secondaryManagerId: rel.managerId,
          };
          userMap[rel.managerId].children.push(refNode);
          placedUnderManager.add(employeeId);
        }
      });
    });

    // Fallback: users with managerId but no junction table record (legacy data)
    users.forEach(u => {
      if (placedUnderManager.has(u.id)) return; // already handled
      if (u.managerId && userMap[u.managerId]) {
        userMap[u.managerId].children.push(userMap[u.id]);
      } else {
        roots.push(userMap[u.id]);
      }
    });

    // Add root nodes: users not placed under any manager
    users.forEach(u => {
      if (!placedUnderManager.has(u.id) && !(u.managerId && userMap[u.managerId])) {
        // already added in fallback above
      } else if (placedUnderManager.has(u.id)) {
        // Check if user has no primary relation (all secondary) — still needs to be a root
        const rels = relationsByEmployee[u.id] || [];
        const hasPrimary = rels.some(r => r.isPrimary);
        if (!hasPrimary && !roots.some(r => r.id === u.id)) {
          roots.push(userMap[u.id]);
        }
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

    res.json({ success: true, data: { orgChart: roots, allUsers: users, usersByLevel, hierarchyLevels } });
  } catch (err) {
    console.error('[OrgChart] error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build org chart.' });
  }
};

// PUT /api/promotions/update-manager — change reporting structure
exports.updateManager = async (req, res) => {
  try {
    const { userId, managerId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required.' });

    // Prevent self-assignment
    if (managerId && managerId === userId) {
      return res.status(400).json({ success: false, message: 'Invalid manager assignment: a user cannot be their own manager.' });
    }

    const user = await User.findByPk(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // Circular hierarchy detection — walk up from proposed manager to ensure userId is not an ancestor
    if (managerId) {
      const manager = await User.findByPk(managerId);
      if (!manager) return res.status(404).json({ success: false, message: 'Manager not found.' });

      let currentId = manager.managerId;
      const visited = new Set([userId, managerId]);
      while (currentId) {
        if (currentId === userId) {
          return res.status(400).json({ success: false, message: 'Invalid manager assignment: circular hierarchy detected.' });
        }
        if (visited.has(currentId)) break; // already checked or cycle in existing data
        visited.add(currentId);
        const ancestor = await User.findByPk(currentId, { attributes: ['id', 'managerId'] });
        if (!ancestor) break;
        currentId = ancestor.managerId;
      }
    }

    const previousManagerId = user.managerId;
    await user.update({ managerId: managerId || null });

    // Sync junction table: update or create the primary relation
    if (managerId) {
      // Clear any existing primary flag for this employee
      await ManagerRelation.update({ isPrimary: false }, { where: { employeeId: userId, isPrimary: true } });
      // Upsert the new primary relation
      const [rel] = await ManagerRelation.findOrCreate({
        where: { employeeId: userId, managerId },
        defaults: { relationType: 'primary', isPrimary: true },
      });
      if (!rel.isPrimary) await rel.update({ isPrimary: true, relationType: 'primary' });
    } else {
      // Removing primary manager — clear primary flag (keep secondary relations)
      await ManagerRelation.update({ isPrimary: false }, { where: { employeeId: userId, isPrimary: true } });
      // Remove the old primary relation record if it was a primary-only relation
      if (previousManagerId) {
        const oldRel = await ManagerRelation.findOne({ where: { employeeId: userId, managerId: previousManagerId } });
        if (oldRel && oldRel.relationType === 'primary') await oldRel.destroy();
      }
    }

    // Activity logging
    logActivity({
      action: 'manager_updated',
      description: `${req.user.name} changed ${user.name}'s manager`,
      entityType: 'user',
      entityId: userId,
      userId: req.user.id,
      meta: { previousManagerId, newManagerId: managerId || null },
    });

    res.json({ success: true, data: { user } });
  } catch (err) {
    console.error('[UpdateManager] error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update manager.' });
  }
};
