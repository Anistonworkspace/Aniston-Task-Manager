const { DirectorPlan, User } = require('../models');
const { Op } = require('sequelize');
const DirectorPlanModel = require('../models/DirectorPlan');
const { emitToUser } = require('../services/socketService');
const { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } = require('../services/teamsCalendarService');

/**
 * Find a specific director by ID, or fallback to first available management-level user.
 */
async function findDirector(directorId) {
  if (directorId) {
    const director = await User.findOne({
      where: { id: directorId, isActive: true },
      attributes: ['id', 'name', 'hierarchyLevel', 'isSuperAdmin', 'role'],
    });
    if (director) return director;
  }
  // Fallback: first superadmin, then admin/manager/assistant_manager, then director/vp/ceo
  return User.findOne({
    where: {
      isActive: true,
      [Op.or]: [
        { isSuperAdmin: true },
        { role: { [Op.in]: ['admin', 'manager', 'assistant_manager'] } },
        { hierarchyLevel: { [Op.in]: ['director', 'vp', 'ceo'] } },
      ],
    },
    attributes: ['id', 'name', 'hierarchyLevel', 'isSuperAdmin', 'role'],
    order: [['isSuperAdmin', 'DESC'], ['createdAt', 'ASC']],
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
 * Returns list of users whose Director Plan can be managed.
 * Includes superadmins, admins, managers, assistant_managers, and users with
 * director/vp/ceo hierarchy levels — i.e. all management-level users.
 */
const getDirectors = async (req, res) => {
  try {
    const directors = await User.findAll({
      where: {
        isActive: true,
        [Op.or]: [
          { isSuperAdmin: true },
          { role: { [Op.in]: ['admin', 'manager', 'assistant_manager'] } },
          { hierarchyLevel: { [Op.in]: ['director', 'vp', 'ceo'] } },
        ],
      },
      attributes: ['id', 'name', 'email', 'role', 'hierarchyLevel', 'designation', 'avatar', 'isSuperAdmin'],
      order: [['isSuperAdmin', 'DESC'], ['name', 'ASC']],
    });
    res.json({ success: true, data: directors });
  } catch (error) {
    console.error('[DirectorPlan] getDirectors error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * Build a cumulative view by merging categories/tasks from ALL plans.
 * Processes plans oldest→newest so latest task versions win.
 * Returns merged categories array with _originDate on each category and task.
 *
 * Key rules:
 *  - Every task from every plan is included (tasks without IDs get a generated key)
 *  - Tasks with the same ID: latest plan's version wins
 *  - Deleted task/category IDs (tracked via _deletedTaskIds/_deletedCategoryIds) are excluded
 *  - _originDate = the earliest plan date where the item first appeared
 */
function buildCumulativeView(allPlans) {
  const sorted = [...allPlans].sort((a, b) => new Date(a.date) - new Date(b.date));

  const catMap = new Map();        // catId → merged category object
  const taskOrigins = new Map();   // mergeKey → earliest plan date
  const catOrigins = new Map();    // catId  → earliest plan date
  const allDeletedTaskIds = new Set();
  const allDeletedCatIds = new Set();

  for (const plan of sorted) {
    const planDate = String(plan.date);
    const categories = plan.categories || [];

    for (const cat of categories) {
      if (!cat.id) continue;

      // ── Collect soft-delete tracking arrays ──
      if (Array.isArray(cat._deletedTaskIds)) {
        cat._deletedTaskIds.forEach(id => allDeletedTaskIds.add(id));
      }
      if (Array.isArray(cat._deletedCategoryIds)) {
        cat._deletedCategoryIds.forEach(id => allDeletedCatIds.add(id));
      }

      // ── Track category origin (first plan it appeared in at all) ──
      if (!catOrigins.has(cat.id)) {
        catOrigins.set(cat.id, planDate);
      }

      // ── Create category in map if first time seen ──
      if (!catMap.has(cat.id)) {
        catMap.set(cat.id, {
          id: cat.id,
          label: cat.label,
          icon: cat.icon,
          color: cat.color,
          startTime: cat.startTime,
          endTime: cat.endTime,
          _taskMap: new Map(),
          _deletedTaskIds: [],
          _deletedCategoryIds: [],
        });
      }

      const merged = catMap.get(cat.id);

      // ── Update category metadata from latest plan (newest wins) ──
      if (cat.label) merged.label = cat.label;
      if (cat.icon) merged.icon = cat.icon;
      if (cat.color) merged.color = cat.color;
      if (cat.startTime !== undefined) merged.startTime = cat.startTime;
      if (cat.endTime !== undefined) merged.endTime = cat.endTime;
      if (Array.isArray(cat._deletedTaskIds)) {
        cat._deletedTaskIds.forEach(id => {
          if (!merged._deletedTaskIds.includes(id)) merged._deletedTaskIds.push(id);
        });
      }
      if (Array.isArray(cat._deletedCategoryIds)) {
        cat._deletedCategoryIds.forEach(id => {
          if (!merged._deletedCategoryIds.includes(id)) merged._deletedCategoryIds.push(id);
        });
      }

      // ── Merge tasks from this plan's category ──
      const tasks = cat.tasks || [];
      for (let ti = 0; ti < tasks.length; ti++) {
        const task = tasks[ti];

        // Generate a stable merge key: prefer real ID, fall back to cat+text composite
        const mergeKey = task.id
          || `_noId_${cat.id}_${(task.text || task.title || '').trim().toLowerCase().slice(0, 50)}_${ti}`;

        if (!taskOrigins.has(mergeKey)) {
          taskOrigins.set(mergeKey, planDate);
        }

        // Deep-copy the task and ensure it has an id for frontend deduplication
        const taskCopy = JSON.parse(JSON.stringify(task));
        if (!taskCopy.id) {
          taskCopy.id = mergeKey;
        }
        // Normalize old single `link` field to `links` array
        if (!Array.isArray(taskCopy.links)) {
          taskCopy.links = taskCopy.link ? [taskCopy.link] : [];
        }
        delete taskCopy.link;

        // Latest plan version wins (oldest→newest processing)
        merged._taskMap.set(mergeKey, taskCopy);
      }
    }
  }

  // ── Build final categories array, excluding deleted items ──
  const result = [];
  for (const [catId, cat] of catMap) {
    if (allDeletedCatIds.has(catId)) continue;

    const tasks = [];
    for (const [mergeKey, task] of cat._taskMap) {
      // Skip if the task's actual id OR its merge key is in the deleted set
      if (allDeletedTaskIds.has(mergeKey) || (task.id && allDeletedTaskIds.has(task.id))) continue;
      task._originDate = taskOrigins.get(mergeKey) || null;
      tasks.push(task);
    }

    result.push({
      id: cat.id,
      label: cat.label,
      icon: cat.icon,
      color: cat.color,
      startTime: cat.startTime,
      endTime: cat.endTime,
      tasks,
      _originDate: catOrigins.get(catId) || null,
      _deletedTaskIds: cat._deletedTaskIds,
      _deletedCategoryIds: cat._deletedCategoryIds,
    });
  }

  console.log(`[DirectorPlan] Cumulative merge: ${sorted.length} plans → ${result.length} categories, ${result.reduce((s, c) => s + c.tasks.length, 0)} total tasks`);
  return result;
}

/**
 * GET /api/director-plan/:date
 *
 * Past dates → snapshot (only that date's saved data)
 * Today / future → cumulative (merge ALL plans up to this date)
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

    const isAdminOrManager = ['admin', 'manager'].includes(user.role);
    const isSuperAdmin = !!user.isSuperAdmin;
    const isTargetDirector = user.id === director.id;
    if (!isTargetDirector && !isAdminOrManager && !isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    // Determine if this is a past date or today/future
    // Use string comparison on YYYY-MM-DD to avoid timezone bugs
    // (new Date('2026-04-07') parses as UTC midnight which can shift days in local timezone)
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const isPastDate = date < todayStr;
    console.log(`[DirectorPlan] GET ${date} | today=${todayStr} | isPast=${isPastDate} | director=${director.id}`);

    if (isPastDate) {
      // ── SNAPSHOT VIEW: past dates show only their saved data ──
      const plan = await DirectorPlan.findOne({
        where: { date, directorId: director.id },
      });

      if (plan) {
        // Normalize old link → links on snapshot responses
        const normalizedCategories = (plan.categories || []).map(cat => ({
          ...cat,
          tasks: (cat.tasks || []).map(task => {
            if (!Array.isArray(task.links)) {
              task.links = task.link ? [task.link] : [];
              delete task.link;
            }
            return task;
          }),
        }));
        return res.json({
          success: true,
          data: {
            id: plan.id,
            date: plan.date,
            directorId: plan.directorId,
            directorName: director.name,
            categories: normalizedCategories,
            notes: plan.notes,
            createdBy: plan.createdBy,
            isNew: false,
            viewMode: 'snapshot',
          },
        });
      }

      // Past date with no plan — empty defaults
      return res.json({
        success: true,
        data: {
          date,
          directorId: director.id,
          directorName: director.name,
          categories: DirectorPlanModel.DEFAULT_CATEGORIES,
          notes: '',
          isNew: true,
          viewMode: 'snapshot',
        },
      });
    }

    // ── CUMULATIVE VIEW: today/future merges ALL plans up to this date ──
    const allPlans = await DirectorPlan.findAll({
      where: { directorId: director.id, date: { [Op.lte]: date } },
      order: [['date', 'ASC']],
    });

    if (allPlans.length === 0) {
      console.log(`[DirectorPlan] Cumulative: no plans found for director ${director.id} up to ${date}`);
      return res.json({
        success: true,
        data: {
          date,
          directorId: director.id,
          directorName: director.name,
          categories: DirectorPlanModel.DEFAULT_CATEGORIES,
          notes: '',
          isNew: true,
          viewMode: 'cumulative',
        },
      });
    }

    console.log(`[DirectorPlan] Cumulative: found ${allPlans.length} plans for director ${director.id} up to ${date}: [${allPlans.map(p => p.date).join(', ')}]`);
    for (const p of allPlans) {
      const cats = p.categories || [];
      const taskCount = cats.reduce((s, c) => s + (c.tasks || []).length, 0);
      console.log(`  Plan ${p.date}: ${cats.length} categories, ${taskCount} tasks`);
    }

    const mergedCategories = buildCumulativeView(allPlans);
    const todaysPlan = allPlans.find(p => String(p.date) === date);

    res.json({
      success: true,
      data: {
        id: todaysPlan?.id || null,
        date,
        directorId: director.id,
        directorName: director.name,
        categories: mergedCategories,
        notes: todaysPlan?.notes || '',
        createdBy: todaysPlan?.createdBy || null,
        isNew: !todaysPlan,
        viewMode: 'cumulative',
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

    if (!['admin', 'manager'].includes(user.role) && !user.isSuperAdmin) {
      return res.status(403).json({ success: false, message: 'Only admins, managers, or super admins can edit the director plan.' });
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
      // Save whatever the client sends — the client is the source of truth
      // Only skip if categories is literally null/undefined (not sent)
      await plan.update({
        categories: Array.isArray(categories) ? categories : plan.categories,
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
    const isAdminOrManager = ['admin', 'manager'].includes(user.role);
    const isSuperAdmin = !!user.isSuperAdmin;
    if (!isTargetDirector && !isAdminOrManager && !isSuperAdmin) {
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
    const isAdminOrManager = ['admin', 'manager'].includes(user.role);
    const isSuperAdmin = !!user.isSuperAdmin;
    if (!isTargetDirector && !isAdminOrManager && !isSuperAdmin) {
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
