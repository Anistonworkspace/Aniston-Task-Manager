const { DirectorPlan, User } = require('../models');
const { Op } = require('sequelize');
const DirectorPlanModel = require('../models/DirectorPlan');
const { emitToUser } = require('../services/socketService');

/**
 * Find the director user. Prefers hierarchyLevel='director' first,
 * excludes isSuperAdmin test accounts, falls back to vp/ceo.
 */
async function findDirector() {
  // First try to find a real director (not super admin)
  let director = await User.findOne({
    where: { isActive: true, hierarchyLevel: 'director', isSuperAdmin: false },
    attributes: ['id', 'name', 'hierarchyLevel'],
  });
  if (director) return director;
  // Fallback: any director/vp/ceo
  return User.findOne({
    where: { isActive: true, hierarchyLevel: { [Op.in]: ['director', 'vp', 'ceo'] } },
    attributes: ['id', 'name', 'hierarchyLevel'],
    order: [['createdAt', 'ASC']],
  });
}

/**
 * Find all assistant_manager users (for broadcasting updates)
 */
async function findAssistantManagers() {
  return User.findAll({
    where: { isActive: true, role: 'assistant_manager' },
    attributes: ['id'],
  });
}

/**
 * Broadcast plan update to director + all assistant managers
 */
async function broadcastPlanUpdate(director, date, plan) {
  const payload = { date, plan: plan ? plan.toJSON() : null };
  // Notify director
  emitToUser(director.id, 'director-plan:updated', payload);
  // Notify all assistant managers
  const ams = await findAssistantManagers();
  ams.forEach(am => emitToUser(am.id, 'director-plan:updated', payload));
}

/**
 * GET /api/director-plan/:date
 */
const getDailyPlan = async (req, res) => {
  try {
    const { date } = req.params;
    const user = req.user;

    const director = await findDirector();
    if (!director) {
      return res.status(404).json({ success: false, message: 'No director found in the system.' });
    }

    const isDirectorUser = user.id === director.id;
    const isAssistantMgr = user.role === 'assistant_manager';
    const isSuperAdmin = !!user.isSuperAdmin;
    if (!isDirectorUser && !isAssistantMgr && !isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    let plan = await DirectorPlan.findOne({
      where: { date, directorId: director.id },
    });

    if (!plan) {
      return res.json({
        success: true,
        data: {
          date,
          directorId: director.id,
          directorName: director.name,
          categories: DirectorPlanModel.DEFAULT_CATEGORIES,
          notes: '',
          isNew: true,
        },
      });
    }

    res.json({
      success: true,
      data: {
        id: plan.id,
        date: plan.date,
        directorId: plan.directorId,
        directorName: director.name,
        categories: plan.categories,
        notes: plan.notes,
        createdBy: plan.createdBy,
        isNew: false,
      },
    });
  } catch (error) {
    console.error('[DirectorPlan] getDailyPlan error:', error);
    res.status(500).json({ success: false, message: 'Server error loading director plan.' });
  }
};

/**
 * PUT /api/director-plan/:date
 * Create or update the director's daily plan.
 */
const saveDailyPlan = async (req, res) => {
  try {
    const { date } = req.params;
    const { categories, notes } = req.body;
    const user = req.user;

    if (user.role !== 'assistant_manager' && !user.isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Only assistant managers can edit the director plan.' });
    }

    const director = await findDirector();
    if (!director) {
      return res.status(404).json({ success: false, message: 'No director found in the system.' });
    }

    const [plan, created] = await DirectorPlan.findOrCreate({
      where: { date, directorId: director.id },
      defaults: {
        categories: categories || DirectorPlanModel.DEFAULT_CATEGORIES,
        notes: notes || '',
        createdBy: user.id,
      },
    });

    if (!created) {
      await plan.update({
        categories: categories || plan.categories,
        notes: notes !== undefined ? notes : plan.notes,
      });
    }

    // Broadcast to director + assistant managers
    await broadcastPlanUpdate(director, date, plan);

    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('[DirectorPlan] saveDailyPlan error:', error);
    res.status(500).json({ success: false, message: 'Server error saving director plan.' });
  }
};

/**
 * PUT /api/director-plan/:date/task
 * Toggle a task done/undone or edit task text.
 */
const updateTask = async (req, res) => {
  try {
    const { date } = req.params;
    const { categoryId, taskIndex, done, text } = req.body;
    const user = req.user;

    const director = await findDirector();
    if (!director) {
      return res.status(404).json({ success: false, message: 'No director found.' });
    }

    const isDirectorUser = user.id === director.id;
    const isAssistantMgr = user.role === 'assistant_manager';
    const isSuperAdmin = !!user.isSuperAdmin;
    if (!isDirectorUser && !isAssistantMgr && !isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const plan = await DirectorPlan.findOne({
      where: { date, directorId: director.id },
    });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'No plan found for this date.' });
    }

    const categories = JSON.parse(JSON.stringify(plan.categories)); // deep clone
    const cat = categories.find(c => c.id === categoryId);
    if (!cat || !cat.tasks || taskIndex < 0 || taskIndex >= cat.tasks.length) {
      return res.status(400).json({ success: false, message: 'Invalid category or task index.' });
    }

    if (done !== undefined) cat.tasks[taskIndex].done = done;
    if (text !== undefined) cat.tasks[taskIndex].text = text;

    await plan.update({ categories });

    // Broadcast update
    await broadcastPlanUpdate(director, date, plan);

    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('[DirectorPlan] updateTask error:', error);
    res.status(500).json({ success: false, message: 'Server error updating task.' });
  }
};

/**
 * PUT /api/director-plan/:date/notes
 */
const updateNotes = async (req, res) => {
  try {
    const { date } = req.params;
    const { notes } = req.body;
    const user = req.user;

    const director = await findDirector();
    if (!director) return res.status(404).json({ success: false, message: 'No director found.' });

    const isDirectorUser = user.id === director.id;
    const isAssistantMgr = user.role === 'assistant_manager';
    const isSuperAdmin = !!user.isSuperAdmin;
    if (!isDirectorUser && !isAssistantMgr && !isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const plan = await DirectorPlan.findOne({ where: { date, directorId: director.id } });
    if (!plan) return res.status(404).json({ success: false, message: 'No plan found for this date.' });

    await plan.update({ notes: notes || '' });

    // Broadcast update
    await broadcastPlanUpdate(director, date, plan);

    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('[DirectorPlan] updateNotes error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getDailyPlan, saveDailyPlan, updateTask, updateNotes };
