const { Activity, User, Task } = require('../models');
const { Op } = require('sequelize');
const { hasTierAtLeast, TIER_2 } = require('../config/tiers');
const taskVisibility = require('../services/taskVisibilityService');

/**
 * GET /api/activities?taskId=...&boardId=...&userId=...&limit=...&offset=...
 *
 * Tier-based row-level scoping (Phase 6 — replaces the prior `assignedTo`-only
 * filter):
 *   - Tier 1 / Tier 2 (super admin, admin, manager) → unrestricted.
 *   - Tier 3 / Tier 4 → activity is filtered to tasks visible to the viewer
 *     via taskVisibilityService.buildTaskVisibilityWhere. That predicate
 *     unions assignedTo + task_assignees + task_owners across the user's
 *     hierarchy subtree, fixing two prior bugs:
 *       (a) Tier 3 (assistant_manager) previously had NO scoping branch,
 *           so saw activity for every task in the system.
 *       (b) Tier 4 previously checked only Task.assignedTo and missed
 *           assignments made via the new task_assignees / task_owners
 *           junctions — a user assigned via those tables saw an empty feed.
 */
const getActivities = async (req, res) => {
  try {
    const { taskId, boardId, userId, limit = 50, offset = 0 } = req.query;

    // Phase B — granular tasks.view_activity gate. Activity feed is the
    // surface this permission controls. Umbrella → tasks.view so legacy
    // tasks.view denies still apply.
    {
      const { denyIfNoPermission } = require('../utils/permissionGate');
      if (await denyIfNoPermission(res, req.user, 'tasks', 'view_activity',
          'You do not have permission to view task activity.')) return;
    }

    const where = {};

    if (taskId) where.taskId = taskId;
    if (boardId) where.boardId = boardId;
    if (userId) where.userId = userId;

    // Tier-1/Tier-2 are unrestricted. For Tier-3/Tier-4 we resolve the set of
    // visible tasks via the canonical visibility service so the activity feed
    // matches what the user can see on the task list.
    if (!hasTierAtLeast(req.user, TIER_2)) {
      // canViewTask handles the single-task case directly (assignedTo +
      // task_assignees + task_owners + subtree). For the list path we use
      // buildTaskVisibilityWhere to constrain the WHERE.
      if (taskId) {
        const allowed = await taskVisibility.canViewTask(req.user, taskId);
        if (!allowed) {
          return res.json({ success: true, data: { activities: [], total: 0 } });
        }
      } else {
        // Fetch the IDs of every task visible to this user, then constrain
        // activity.taskId by that set. We pull only the id column so the
        // query is cheap. The fragment from buildTaskVisibilityWhere is
        // applied via Task.findAll under the same predicate as the task
        // list endpoints.
        const visibilityFragment = await taskVisibility.buildTaskVisibilityWhere(req.user);
        const taskWhere = {};
        if (visibilityFragment && visibilityFragment[Op.and]) {
          taskWhere[Op.and] = visibilityFragment[Op.and];
        }
        const visibleTasks = await Task.findAll({
          where: taskWhere,
          attributes: ['id'],
          raw: true,
        });
        const visibleIds = visibleTasks.map((t) => t.id);
        // If the viewer has zero visible tasks, force an empty result by
        // using a sentinel that cannot match any UUID (matches the pattern
        // used in dashboardController).
        where.taskId = { [Op.in]: visibleIds.length ? visibleIds : [null] };
      }
    }

    const { rows: activities, count: total } = await Activity.findAndCountAll({
      where,
      include: [
        { model: User, as: 'actor', attributes: ['id', 'name', 'email', 'avatar'] },
      ],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });

    res.json({ success: true, data: { activities, total } });
  } catch (error) {
    console.error('[Activity] GetActivities error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching activities.' });
  }
};

module.exports = { getActivities };
