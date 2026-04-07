const { Activity, User, Task } = require('../models');
const { Op } = require('sequelize');

/**
 * GET /api/activities?taskId=...&boardId=...&userId=...&limit=...&offset=...
 * Manager/Admin see all. Members see only activities on their own tasks.
 */
const getActivities = async (req, res) => {
  try {
    const { taskId, boardId, userId, limit = 50, offset = 0 } = req.query;

    const where = {};

    if (taskId) where.taskId = taskId;
    if (boardId) where.boardId = boardId;
    if (userId) where.userId = userId;

    // Members can only see activities on tasks assigned to them
    if (req.user.role === 'member') {
      const myTasks = await Task.findAll({
        where: { assignedTo: req.user.id },
        attributes: ['id'],
      });
      const myTaskIds = myTasks.map(t => t.id);
      if (taskId) {
        // Verify they have access to this task
        if (!myTaskIds.includes(taskId)) {
          return res.json({ success: true, data: { activities: [], total: 0 } });
        }
      } else {
        where.taskId = { [Op.in]: myTaskIds };
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
