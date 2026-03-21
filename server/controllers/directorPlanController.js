const { DirectorPlan, User } = require('../models');
const { Op } = require('sequelize');
const DirectorPlanModel = require('../models/DirectorPlan');
const { emitToUser } = require('../services/socketService');

/**
 * Find a specific director by ID, or fallback to first available.
 */
async function findDirector(directorId) {
  if (directorId) {
    const director = await User.findOne({
      where: { id: directorId, isActive: true },
      attributes: ['id', 'name', 'hierarchyLevel', 'isSuperAdmin'],
    });
    if (director) return director;
  }
  // Fallback: first director/vp/ceo (non-superadmin preferred)
  let director = await User.findOne({
    where: { isActive: true, hierarchyLevel: 'director', isSuperAdmin: false },
    attributes: ['id', 'name', 'hierarchyLevel', 'isSuperAdmin'],
  });
  if (director) return director;
  return User.findOne({
    where: { isActive: true, [Op.or]: [{ hierarchyLevel: { [Op.in]: ['director', 'vp', 'ceo'] } }, { isSuperAdmin: true }] },
    attributes: ['id', 'name', 'hierarchyLevel', 'isSuperAdmin'],
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
 * Broadcast plan update to director + all assistant managers + superadmins
 */
async function broadcastPlanUpdate(director, date, plan) {
  const payload = { date, directorId: director.id, plan: plan ? plan.toJSON() : null };
  emitToUser(director.id, 'director-plan:updated', payload);
  const ams = await findAssistantManagers();
  ams.forEach(am => emitToUser(am.id, 'director-plan:updated', payload));
  // Notify all superadmins
  const superadmins = await User.findAll({ where: { isActive: true, isSuperAdmin: true }, attributes: ['id'] });
  superadmins.forEach(sa => {
    if (sa.id !== director.id) emitToUser(sa.id, 'director-plan:updated', payload);
  });
}

/**
 * GET /api/director-plan/directors
 * Returns list of selectable directors (superadmins + director/vp/ceo hierarchy users)
 */
const getDirectors = async (req, res) => {
  try {
    const directors = await User.findAll({
      where: {
        isActive: true,
        [Op.or]: [
          { isSuperAdmin: true },
          { hierarchyLevel: { [Op.in]: ['director', 'vp', 'ceo'] } },
        ],
      },
      attributes: ['id', 'name', 'email', 'hierarchyLevel', 'designation', 'avatar', 'isSuperAdmin'],
      order: [['isSuperAdmin', 'DESC'], ['name', 'ASC']],
    });
    res.json({ success: true, data: directors });
  } catch (error) {
    console.error('[DirectorPlan] getDirectors error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/director-plan/:date
 */
const getDailyPlan = async (req, res) => {
  try {
    const { date } = req.params;
    const { directorId: queryDirectorId } = req.query;
    const user = req.user;

    const director = await findDirector(queryDirectorId);
    if (!director) {
      return res.status(404).json({ success: false, message: 'No director found in the system.' });
    }

    const isAssistantMgr = user.role === 'assistant_manager';
    const isSuperAdmin = !!user.isSuperAdmin;
    const isTargetDirector = user.id === director.id;
    if (!isTargetDirector && !isAssistantMgr && !isSuperAdmin) {
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
 */
const saveDailyPlan = async (req, res) => {
  try {
    const { date } = req.params;
    const { categories, notes, directorId: bodyDirectorId } = req.body;
    const user = req.user;

    if (user.role !== 'assistant_manager' && !user.isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Only assistant managers can edit the director plan.' });
    }

    const director = await findDirector(bodyDirectorId);
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

    await broadcastPlanUpdate(director, date, plan);
    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('[DirectorPlan] saveDailyPlan error:', error);
    res.status(500).json({ success: false, message: 'Server error saving director plan.' });
  }
};

/**
 * PUT /api/director-plan/:date/task
 */
const updateTask = async (req, res) => {
  try {
    const { date } = req.params;
    const { categoryId, taskIndex, done, text, directorId: bodyDirectorId } = req.body;
    const user = req.user;

    const director = await findDirector(bodyDirectorId);
    if (!director) {
      return res.status(404).json({ success: false, message: 'No director found.' });
    }

    const isTargetDirector = user.id === director.id;
    const isAssistantMgr = user.role === 'assistant_manager';
    const isSuperAdmin = !!user.isSuperAdmin;
    if (!isTargetDirector && !isAssistantMgr && !isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const plan = await DirectorPlan.findOne({
      where: { date, directorId: director.id },
    });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'No plan found for this date.' });
    }

    const categories = JSON.parse(JSON.stringify(plan.categories));
    const cat = categories.find(c => c.id === categoryId);
    if (!cat || !cat.tasks || taskIndex < 0 || taskIndex >= cat.tasks.length) {
      return res.status(400).json({ success: false, message: 'Invalid category or task index.' });
    }

    if (done !== undefined) cat.tasks[taskIndex].done = done;
    if (text !== undefined) cat.tasks[taskIndex].text = text;

    await plan.update({ categories });
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
    const { notes, directorId: bodyDirectorId } = req.body;
    const user = req.user;

    const director = await findDirector(bodyDirectorId);
    if (!director) return res.status(404).json({ success: false, message: 'No director found.' });

    const isTargetDirector = user.id === director.id;
    const isAssistantMgr = user.role === 'assistant_manager';
    const isSuperAdmin = !!user.isSuperAdmin;
    if (!isTargetDirector && !isAssistantMgr && !isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const plan = await DirectorPlan.findOne({ where: { date, directorId: director.id } });
    if (!plan) return res.status(404).json({ success: false, message: 'No plan found for this date.' });

    await plan.update({ notes: notes || '' });
    await broadcastPlanUpdate(director, date, plan);
    res.json({ success: true, data: plan });
  } catch (error) {
    console.error('[DirectorPlan] updateNotes error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getDirectors, getDailyPlan, saveDailyPlan, updateTask, updateNotes };
