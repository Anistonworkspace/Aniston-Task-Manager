const { DirectorPlan, User } = require('../models');
const { Op } = require('sequelize');
const DirectorPlanModel = require('../models/DirectorPlan');
const { emitToUser } = require('../services/socketService');
const { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } = require('../services/teamsCalendarService');

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
        // Exclude the seed system account — it's for system management only
        email: { [Op.ne]: 'superadmin@anistonav.com' },
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

    // If plan exists but has no tasks (possibly wiped by auto-save during crash),
    // try to recover tasks from the most recent plan that has them
    if (plan && plan.categories) {
      const hasTasks = plan.categories.some(c => c.tasks?.length > 0);
      if (!hasTasks) {
        const planWithTasks = await DirectorPlan.findOne({
          where: { directorId: director.id, date: { [Op.lt]: date } },
          order: [['date', 'DESC']],
        });
        // Search deeper if needed
        let bestPlan = planWithTasks;
        if (bestPlan && !bestPlan.categories?.some(c => c.tasks?.length > 0)) {
          const older = await DirectorPlan.findAll({
            where: { directorId: director.id, date: { [Op.lt]: date } },
            order: [['date', 'DESC']],
            limit: 30,
          });
          bestPlan = older.find(p => p.categories?.some(c => c.tasks?.length > 0)) || null;
        }
        if (bestPlan && bestPlan.categories?.some(c => c.tasks?.length > 0)) {
          // Recover tasks from the older plan into today's empty plan
          const recovered = JSON.parse(JSON.stringify(bestPlan.categories));
          recovered.forEach(cat => {
            if (cat.tasks) cat.tasks.forEach(t => { t.done = false; if (t.subtasks) t.subtasks.forEach(s => { s.done = false; }); });
          });
          await plan.update({ categories: recovered });
          plan = await plan.reload();
          console.log(`[DirectorPlan] Recovered tasks from ${bestPlan.date} into ${date}`);
        }
      }
    }

    if (!plan) {
      // Carryforward: look for the most recent previous plan WITH actual tasks
      // Search up to 30 days back to find a plan that has tasks in it
      const previousPlans = await DirectorPlan.findAll({
        where: { directorId: director.id, date: { [Op.lt]: date } },
        order: [['date', 'DESC']],
        limit: 30,
      });

      // Find the first plan that has categories with tasks
      let previousPlan = null;
      for (const p of previousPlans) {
        if (p.categories?.length > 0 && p.categories.some(c => c.tasks?.length > 0)) {
          previousPlan = p;
          break;
        }
      }
      // If no plan with tasks found, use the most recent plan for category structure
      if (!previousPlan && previousPlans.length > 0) {
        previousPlan = previousPlans[0];
      }

      if (previousPlan && previousPlan.categories?.length > 0) {
        // Deep copy categories, reset all tasks and subtasks to not-done
        const carried = JSON.parse(JSON.stringify(previousPlan.categories));
        carried.forEach(cat => {
          if (cat.tasks) {
            cat.tasks.forEach(task => {
              task.done = false;
              if (task.subtasks) task.subtasks.forEach(st => { st.done = false; });
            });
          }
        });

        // Auto-create the carried-forward plan in DB
        plan = await DirectorPlan.create({
          date,
          directorId: director.id,
          categories: carried,
          notes: '',
          createdBy: previousPlan.createdBy,
        });

        return res.json({
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
            carriedForward: true,
          },
        });
      }

      // No previous plan — return empty defaults
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
      // Don't overwrite existing data with empty categories (prevents auto-save wipe)
      const hasRealTasks = Array.isArray(categories) && categories.length > 0 &&
        categories.some(c => Array.isArray(c.tasks) && c.tasks.length > 0);
      const newCats = hasRealTasks ? categories : (categories && categories.length > 0 ? categories : plan.categories);
      await plan.update({
        categories: newCats,
        notes: notes !== undefined ? notes : plan.notes,
      });
    }

    // Fire-and-forget: sync task deadlines to Teams calendar
    syncDirectorPlanCalendarEvents(plan, director, date).catch(err => {
      console.error('[DirectorPlan] Calendar sync error (non-blocking):', err.message);
    });

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

/**
 * Sync director plan task deadlines to Teams calendar.
 * Creates, updates, or deletes calendar events as deadlines change.
 * Non-blocking — errors are logged but do not affect the save operation.
 */
async function syncDirectorPlanCalendarEvents(plan, director, date) {
  const categories = plan.categories;
  if (!Array.isArray(categories)) return;

  const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

  for (const category of categories) {
    if (!Array.isArray(category.tasks)) continue;

    for (let i = 0; i < category.tasks.length; i++) {
      const task = category.tasks[i];

      // Build a deadline Date from the task's deadline field
      let deadlineDate = null;
      if (task.deadline) {
        if (task.deadline.includes('T') || task.deadline.includes('-')) {
          deadlineDate = new Date(task.deadline);
        } else if (task.deadline.includes(':')) {
          const [hours, minutes] = task.deadline.split(':').map(Number);
          deadlineDate = new Date(date);
          deadlineDate.setHours(hours, minutes, 0, 0);
        }
        if (deadlineDate && isNaN(deadlineDate.getTime())) deadlineDate = null;
      }

      const taskName = task.text || task.name || `Task ${i + 1}`;
      const existingEventId = task.teamsEventId || null;

      if (deadlineDate && !task.done) {
        // Task has a deadline and is not done — create or update event
        const startTime = new Date(deadlineDate.getTime() - 60 * 60 * 1000); // 1 hour before deadline
        const endTime = deadlineDate;
        const subject = `[Director Plan] ${taskName} — ${category.label}`;
        const body = `
          <b>Category:</b> ${category.label}<br>
          <b>Task:</b> ${taskName}<br>
          <b>Deadline:</b> ${deadlineDate.toLocaleString()}<br>
          <b>Plan Date:</b> ${date}<br>
          <br><a href="${CLIENT_URL}/director-plan">Open Director Plan</a>
        `;

        if (existingEventId) {
          // Update existing event
          await updateCalendarEvent(director.id, existingEventId, {
            subject,
            body,
            startTime,
            endTime,
          });
        } else {
          // Create new event
          const eventId = await createCalendarEvent(director.id, {
            subject,
            body,
            startTime,
            endTime,
            reminder: 30,
          });
          if (eventId) {
            // Store the eventId back on the task for future updates/deletes
            task.teamsEventId = eventId;
          }
        }
      } else if (existingEventId && (!deadlineDate || task.done)) {
        // Deadline removed or task done — delete the calendar event
        await deleteCalendarEvent(director.id, existingEventId);
        delete task.teamsEventId;
      }
    }
  }

  // Persist any teamsEventId changes back to the plan
  await plan.update({ categories: plan.categories });
}

module.exports = { getDirectors, getDailyPlan, saveDailyPlan, updateTask, updateNotes };
