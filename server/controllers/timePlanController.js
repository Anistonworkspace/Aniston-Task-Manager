const { TimeBlock, Task, User } = require('../models');
const { Op } = require('sequelize');
const { randomUUID } = require('crypto');
const { fetchCalendarEvents } = require('../services/calendarService');
const plannerAccess = require('../services/plannerAccessService');
const { canUserSeeBoard } = require('../services/boardVisibilityService');
const { sanitizeRichText } = require('../utils/sanitize');

// ── Planner constraints ─────────────────────────────────────────────────
// Working-hours window the weekly grid renders (09:00–21:00). Enforced on
// every write so a block can never be saved outside the visible grid. Mirrored
// on the client; promote to a system setting later if per-org hours are needed.
const PLANNER_DAY_START = '09:00';
const PLANNER_DAY_END = '21:00';

const VALID_TYPES = ['task_work', 'meeting', 'focus', 'break', 'admin', 'review', 'approval', 'travel', 'other'];
const VALID_STATUSES = ['planned', 'in_progress', 'done', 'missed', 'rescheduled'];
const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const VALID_REMINDERS = [5, 10, 15, 30, 60];
const MAX_TITLE = 300;
const MAX_DESCRIPTION_TEXT = 3000; // counted on the plain text (not HTML markup)
const RECURRENCE_HORIZON_WEEKS = 4; // bounded — never generate beyond this
const RECURRENCE_MAX_INSTANCES = 31;

// Block colour palette (must mirror client plannerTheme COLOR_PALETTE).
const COLOR_PALETTE = ['#8b5cf6', '#0073ea', '#00c875', '#fdab3d', '#e2445c', '#a25ddc', '#0ea5e9', '#ff642e', '#7b83eb', '#00a3a3'];
function isValidColor(c) { return typeof c === 'string' && COLOR_PALETTE.includes(c); }
function pickAutoColor() { return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)]; }
/** Plain-text length of a (sanitized) HTML string, for the description limit. */
function plainLen(html) { return String(html || '').replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim().length; }

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validate the time window: format, order, and working-hours bounds. */
function windowError(startTime, endTime) {
  if (!HHMM.test(startTime) || !HHMM.test(endTime)) {
    return 'Times must be in HH:MM format.';
  }
  if (startTime >= endTime) {
    return 'Start time must be before end time.';
  }
  if (startTime < PLANNER_DAY_START || endTime > PLANNER_DAY_END) {
    return `Time blocks must be within working hours (${PLANNER_DAY_START}–${PLANNER_DAY_END}).`;
  }
  return null;
}

/** UTC day-of-week for a YYYY-MM-DD string (0=Sun … 6=Sat), TZ-stable. */
function dowOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** The planner work week is Mon–Sat; Sunday is rejected. */
function dateError(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return 'Invalid date.';
  if (dowOf(dateStr) === 0) return 'The planner work week is Monday–Saturday (Sunday is not available).';
  return null;
}

const REPEAT_VALUES = ['none', 'daily', 'weekdays', 'weekly'];
function isValidRecurrenceRule(rule) {
  if (!rule || rule === 'none') return true;
  if (REPEAT_VALUES.includes(rule)) return true;
  return /^custom:[0-6](,[0-6])*$/.test(rule);
}

/**
 * Expand a recurrence rule into a bounded list of YYYY-MM-DD dates starting at
 * `startDateStr`, never crossing the horizon and never landing on Sunday.
 * MVP: finite window only (no infinite series).
 */
function expandRecurrenceDates(rule, startDateStr) {
  if (!rule || rule === 'none') return [startDateStr];
  const start = new Date(`${startDateStr}T00:00:00Z`);
  const startDow = start.getUTCDay();
  let wanted;
  if (rule === 'daily') wanted = [1, 2, 3, 4, 5, 6];
  else if (rule === 'weekdays') wanted = [1, 2, 3, 4, 5];
  else if (rule === 'weekly') wanted = [startDow];
  else wanted = rule.replace('custom:', '').split(',').map(Number);
  wanted = wanted.filter((d) => d >= 1 && d <= 6); // never Sunday

  const dates = [];
  const horizonEnd = new Date(start);
  horizonEnd.setUTCDate(horizonEnd.getUTCDate() + RECURRENCE_HORIZON_WEEKS * 7);
  const cursor = new Date(start);
  while (cursor <= horizonEnd && dates.length < RECURRENCE_MAX_INSTANCES) {
    if (wanted.includes(cursor.getUTCDay())) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  // Always include the explicit start date even if its DOW isn't in the set.
  if (!dates.includes(startDateStr)) dates.unshift(startDateStr);
  return dates;
}

/** Validate the enum / length metadata fields that were actually provided. */
function metaError({ type, status, priority, reminderMinutesBefore, title, color }) {
  if (type !== undefined && !VALID_TYPES.includes(type)) return 'Invalid block type.';
  if (status !== undefined && !VALID_STATUSES.includes(status)) return 'Invalid status.';
  if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) return 'Invalid priority.';
  if (
    reminderMinutesBefore !== undefined
    && reminderMinutesBefore !== null
    && !VALID_REMINDERS.includes(Number(reminderMinutesBefore))
  ) {
    return 'Invalid reminder option.';
  }
  if (title !== undefined && title !== null && String(title).length > MAX_TITLE) {
    return `Title must be ${MAX_TITLE} characters or fewer.`;
  }
  if (color !== undefined && color !== null && color !== '' && !isValidColor(color)) {
    return 'Invalid colour.';
  }
  return null;
}

/**
 * Resolve + authorize a linked task for the acting user. Returns
 * { ok:true, boardId } / { ok:true, boardId:null } when no task, or
 * { ok:false, status, message } on failure.
 * Enforces "user can only link tasks they are allowed to see".
 */
async function resolveLinkedTask(actor, taskId) {
  if (!taskId) return { ok: true, boardId: null, task: null };
  const task = await Task.findByPk(taskId, { attributes: ['id', 'title', 'boardId'] });
  if (!task) return { ok: false, status: 400, message: 'Linked task not found.' };
  const allowed = await canUserSeeBoard(actor, task.boardId);
  if (!allowed) {
    return { ok: false, status: 403, message: 'You are not allowed to link that task.' };
  }
  return { ok: true, boardId: task.boardId, task };
}

/** Ensure every block in a response carries a display title for the UI. */
function shapeBlock(instance) {
  const b = instance && instance.toJSON ? instance.toJSON() : instance;
  if (b && !b.title) {
    b.title = (b.task && b.task.title) || (b.description && b.description.trim()) || 'Untitled block';
  }
  return b;
}

const fullInclude = [
  { model: Task, as: 'task', attributes: ['id', 'title', 'status', 'priority', 'boardId'] },
  { model: User, as: 'user', attributes: ['id', 'name', 'avatar'] },
  { model: User, as: 'createdBy', attributes: ['id', 'name', 'avatar'] },
];

/**
 * POST /api/timeplans
 * Create a time block for the current user OR (with permission) another user.
 */
const createTimeBlock = async (req, res) => {
  try {
    const {
      date, startTime, endTime, description, taskId, forUserId,
      title, type, status, priority, reminderMinutesBefore, recurrenceRule, color,
    } = req.body;

    if (!date || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: 'date, startTime, and endTime are required.' });
    }

    const dErr = dateError(date);
    if (dErr) return res.status(400).json({ success: false, message: dErr });

    const wErr = windowError(startTime, endTime);
    if (wErr) return res.status(400).json({ success: false, message: wErr });

    const mErr = metaError({ type, status, priority, reminderMinutesBefore, title, color });
    if (mErr) return res.status(400).json({ success: false, message: mErr });

    if (!isValidRecurrenceRule(recurrenceRule)) {
      return res.status(400).json({ success: false, message: 'Invalid repeat rule.' });
    }

    // Authorize cross-user creation via hierarchy/delegation (NOT raw role).
    let targetUserId = req.user.id;
    if (forUserId && forUserId !== req.user.id) {
      const allowed = await plannerAccess.canManagePlanner(req.user, forUserId);
      if (!allowed) {
        return res.status(403).json({ success: false, message: 'You are not allowed to manage this user\'s planner.' });
      }
      const targetUser = await User.findByPk(forUserId, { attributes: ['id', 'isActive'] });
      if (!targetUser || !targetUser.isActive) {
        return res.status(404).json({ success: false, message: 'Target user not found.' });
      }
      targetUserId = forUserId;
    }

    // Resolve + authorize the linked task; derive boardId server-side.
    const linked = await resolveLinkedTask(req.user, taskId);
    if (!linked.ok) return res.status(linked.status).json({ success: false, message: linked.message });

    // Sanitize the rich-HTML note; use its plain text for the identifiable check + limit.
    const cleanDescription = sanitizeRichText(description || '') || '';
    if (plainLen(cleanDescription) > MAX_DESCRIPTION_TEXT) {
      return res.status(400).json({ success: false, message: `Description must be ${MAX_DESCRIPTION_TEXT} characters or fewer.` });
    }
    const plainDescription = cleanDescription.replace(/<[^>]*>/g, '').trim();
    const resolvedTitle = (title && title.trim())
      || (linked.task && linked.task.title)
      || plainDescription
      || null;
    if (!resolvedTitle && !taskId) {
      return res.status(400).json({ success: false, message: 'Add a title (or link a task) for this block.' });
    }

    // Bounded recurrence: expand to a finite, Sunday-free date list.
    const repeat = recurrenceRule && recurrenceRule !== 'none' ? recurrenceRule : null;
    const dates = expandRecurrenceDates(repeat, date);
    const groupId = repeat && dates.length > 1 ? randomUUID() : null;

    const baseFields = {
      startTime,
      endTime,
      description: cleanDescription,
      title: resolvedTitle,
      type: type || 'task_work',
      status: status || 'planned',
      priority: priority || 'normal',
      source: taskId ? 'task' : 'manual',
      reminderMinutesBefore: reminderMinutesBefore != null ? Number(reminderMinutesBefore) : null,
      color: isValidColor(color) ? color : pickAutoColor(),
      taskId: taskId || null,
      boardId: linked.boardId,
      userId: targetUserId,
      createdById: req.user.id,
      recurrenceRule: repeat,
      recurrenceGroupId: groupId,
    };

    let baseBlock = null;
    let skipped = 0;
    for (const d of dates) {
      // Per-day overlap guard — skip days that already have a clashing block.
      const overlap = await TimeBlock.findOne({
        where: {
          userId: targetUserId,
          date: d,
          [Op.and]: [{ startTime: { [Op.lt]: endTime } }, { endTime: { [Op.gt]: startTime } }],
        },
      });
      if (overlap) { skipped += 1; continue; }
      const created = await TimeBlock.create({ ...baseFields, date: d });
      if (d === date || !baseBlock) baseBlock = created;
    }

    if (!baseBlock) {
      return res.status(400).json({ success: false, message: 'This time block overlaps with an existing one.' });
    }

    const full = await TimeBlock.findByPk(baseBlock.id, { include: fullInclude });
    res.status(201).json({ success: true, data: shapeBlock(full), meta: { created: dates.length - skipped, skipped } });
  } catch (error) {
    console.error('[TimePlan] create error:', error);
    res.status(500).json({ success: false, message: 'Server error creating time block.' });
  }
};

/**
 * GET /api/timeplans/my?date=YYYY-MM-DD or ?from=&to=
 */
const getMyTimeBlocks = async (req, res) => {
  try {
    const { date, from, to } = req.query;
    const where = { userId: req.user.id };
    if (from && to) where.date = { [Op.between]: [from, to] };
    else if (from) where.date = { [Op.gte]: from };
    else if (date) where.date = date;

    const blocks = await TimeBlock.findAll({
      where,
      include: [{ model: Task, as: 'task', attributes: ['id', 'title', 'status', 'priority', 'boardId'] }],
      order: [['startTime', 'ASC']],
    });

    res.json({ success: true, data: blocks.map(shapeBlock) });
  } catch (error) {
    console.error('[TimePlan] getMyTimeBlocks error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching time blocks.' });
  }
};

/**
 * GET /api/timeplans/employee/:userId?date=YYYY-MM-DD
 * View another user's blocks — authorized per-target (subtree or delegation).
 */
const getEmployeeTimeBlocks = async (req, res) => {
  try {
    const { userId } = req.params;
    const { date, from, to } = req.query;

    const allowed = await plannerAccess.canViewPlanner(req.user, userId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to this user\'s planner.' });
    }

    const employee = await User.findByPk(userId, {
      attributes: ['id', 'name', 'email', 'avatar', 'designation', 'department'],
    });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const where = { userId };
    if (from && to) where.date = { [Op.between]: [from, to] };
    else if (from) where.date = { [Op.gte]: from };
    else if (date) where.date = date;

    const blocks = await TimeBlock.findAll({
      where,
      include: [{ model: Task, as: 'task', attributes: ['id', 'title', 'status', 'priority', 'boardId'] }],
      order: [['startTime', 'ASC']],
    });

    res.json({ success: true, data: { employee, blocks: blocks.map(shapeBlock) } });
  } catch (error) {
    console.error('[TimePlan] getEmployeeTimeBlocks error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching employee time blocks.' });
  }
};

/**
 * GET /api/timeplans/team?date=YYYY-MM-DD
 * Team overview — scoped to the planners the caller may view (Tier 1 = all).
 */
const getTeamTimeBlocks = async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, message: 'date query parameter is required.' });
    }

    const where = { date };
    const visibleIds = await plannerAccess.visiblePlannerUserIds(req.user);
    // null => unrestricted (Tier 1). Otherwise constrain to the allowed set.
    if (visibleIds !== null) {
      if (!visibleIds.length) return res.json({ success: true, data: [] });
      where.userId = { [Op.in]: visibleIds };
    }

    const blocks = await TimeBlock.findAll({
      where,
      include: [
        { model: Task, as: 'task', attributes: ['id', 'title', 'status'] },
        { model: User, as: 'user', attributes: ['id', 'name', 'avatar', 'designation'] },
      ],
      order: [['startTime', 'ASC']],
    });

    const byUser = {};
    blocks.forEach((b) => {
      const plain = shapeBlock(b);
      const uid = plain.userId;
      if (!byUser[uid]) byUser[uid] = { user: plain.user, blocks: [] };
      byUser[uid].blocks.push(plain);
    });

    res.json({ success: true, data: Object.values(byUser) });
  } catch (error) {
    console.error('[TimePlan] getTeamTimeBlocks error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching team time blocks.' });
  }
};

/**
 * PUT /api/timeplans/:id
 * Update a block. Cross-user edits authorized via plannerAccess (same model
 * as create/delete).
 */
const updateTimeBlock = async (req, res) => {
  try {
    const block = await TimeBlock.findByPk(req.params.id);
    if (!block) {
      return res.status(404).json({ success: false, message: 'Time block not found.' });
    }
    if (block.userId !== req.user.id) {
      const allowed = await plannerAccess.canManagePlanner(req.user, block.userId);
      if (!allowed) {
        return res.status(403).json({ success: false, message: 'You are not allowed to edit this time block.' });
      }
    }

    const {
      date, startTime, endTime, description, taskId,
      title, type, status, priority, reminderMinutesBefore, color,
    } = req.body;

    const newStart = startTime || block.startTime;
    const newEnd = endTime || block.endTime;
    const newDate = date || block.date;

    const wErr = windowError(newStart, newEnd);
    if (wErr) return res.status(400).json({ success: false, message: wErr });

    if (date !== undefined) {
      const dErr = dateError(date);
      if (dErr) return res.status(400).json({ success: false, message: dErr });
    }

    const mErr = metaError({ type, status, priority, reminderMinutesBefore, title, color });
    if (mErr) return res.status(400).json({ success: false, message: mErr });

    const cleanDescription = description !== undefined ? (sanitizeRichText(description || '') || '') : undefined;
    if (cleanDescription !== undefined && plainLen(cleanDescription) > MAX_DESCRIPTION_TEXT) {
      return res.status(400).json({ success: false, message: `Description must be ${MAX_DESCRIPTION_TEXT} characters or fewer.` });
    }

    // Re-arm the reminder when the time, day, or reminder offset changes.
    const reArmReminder = startTime !== undefined || date !== undefined || reminderMinutesBefore !== undefined;

    // Re-resolve linked task only when taskId is being changed.
    let boardId = block.boardId;
    let linkedTask = null;
    if (taskId !== undefined) {
      const linked = await resolveLinkedTask(req.user, taskId);
      if (!linked.ok) return res.status(linked.status).json({ success: false, message: linked.message });
      boardId = linked.boardId;
      linkedTask = linked.task;
    }

    // Resulting block must still be identifiable (task, title, or description).
    const resultingTaskId = taskId !== undefined ? (taskId || null) : block.taskId;
    const resultingTitle = title !== undefined ? (title && title.trim()) : block.title;
    const resultingDescription = cleanDescription !== undefined
      ? cleanDescription.replace(/<[^>]*>/g, '').trim()
      : block.description;
    if (!resultingTaskId && !resultingTitle && !resultingDescription && !(linkedTask && linkedTask.title)) {
      return res.status(400).json({ success: false, message: 'Add a title (or link a task) for this block.' });
    }

    // Overlap (exclude self).
    const overlap = await TimeBlock.findOne({
      where: {
        userId: block.userId,
        date: newDate,
        id: { [Op.ne]: block.id },
        [Op.and]: [{ startTime: { [Op.lt]: newEnd } }, { endTime: { [Op.gt]: newStart } }],
      },
    });
    if (overlap) {
      return res.status(400).json({ success: false, message: 'This time block overlaps with an existing one.' });
    }

    await block.update({
      ...(date !== undefined && { date }),
      ...(startTime !== undefined && { startTime }),
      ...(endTime !== undefined && { endTime }),
      ...(cleanDescription !== undefined && { description: cleanDescription }),
      ...(title !== undefined && { title: (title && title.trim()) || (linkedTask && linkedTask.title) || null }),
      ...(type !== undefined && { type }),
      ...(status !== undefined && { status }),
      ...(priority !== undefined && { priority }),
      ...(reminderMinutesBefore !== undefined && { reminderMinutesBefore: reminderMinutesBefore != null ? Number(reminderMinutesBefore) : null }),
      ...(color !== undefined && { color: isValidColor(color) ? color : null }),
      ...(taskId !== undefined && { taskId: taskId || null, boardId, source: taskId ? 'task' : 'manual' }),
      ...(reArmReminder && { reminderSentAt: null }),
    });

    const full = await TimeBlock.findByPk(block.id, { include: fullInclude });
    res.json({ success: true, data: shapeBlock(full) });
  } catch (error) {
    console.error('[TimePlan] update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating time block.' });
  }
};

/**
 * DELETE /api/timeplans/:id
 */
const deleteTimeBlock = async (req, res) => {
  try {
    const block = await TimeBlock.findByPk(req.params.id);
    if (!block) {
      return res.status(404).json({ success: false, message: 'Time block not found.' });
    }
    const isOwnResource = block.userId === req.user.id;
    if (!isOwnResource) {
      const allowed = await plannerAccess.canManagePlanner(req.user, block.userId);
      if (!allowed) {
        return res.status(403).json({ success: false, message: 'You are not allowed to delete this time block.' });
      }
    }
    // Destructive-action tier gate (unchanged) — orthogonal to ownership.
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'time_block', { isOwnResource }))) return;
    }

    // ?scope=series removes the whole recurrence group; default removes one.
    if (req.query.scope === 'series' && block.recurrenceGroupId) {
      const count = await TimeBlock.destroy({ where: { recurrenceGroupId: block.recurrenceGroupId, userId: block.userId } });
      return res.json({ success: true, message: `Deleted ${count} block(s) in the series.`, data: { deleted: count, scope: 'series' } });
    }

    await block.destroy();
    res.json({ success: true, message: 'Time block deleted.', data: { deleted: 1, scope: 'occurrence' } });
  } catch (error) {
    console.error('[TimePlan] delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting time block.' });
  }
};

/**
 * GET /api/timeplans/people
 * Roster of users whose planners the caller may VIEW, each tagged with
 * `canManage`. Planner-scoped (NOT the broad task-assignment roster): only
 * Tier 1 sees everyone; others get self + subtree + delegated owners.
 */
const getPlannerPeople = async (req, res) => {
  try {
    const viewIds = await plannerAccess.visiblePlannerUserIds(req.user);   // null = all
    const manageIds = await plannerAccess.manageablePlannerUserIds(req.user); // null = all

    const where = { isActive: true };
    if (viewIds !== null) {
      if (!viewIds.length) return res.json({ success: true, data: [] });
      where.id = { [Op.in]: viewIds };
    }

    const users = await User.findAll({
      where,
      attributes: ['id', 'name', 'email', 'avatar', 'designation', 'department', 'role', 'tier'],
      order: [['name', 'ASC']],
    });

    const manageAll = manageIds === null;
    const manageSet = manageAll ? null : new Set(manageIds.map(String));
    const data = users.map((u) => {
      const p = u.toJSON();
      p.canManage = manageAll || manageSet.has(String(p.id));
      p.isSelf = String(p.id) === String(req.user.id);
      return p;
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('[TimePlan] getPlannerPeople error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching planner people.' });
  }
};

// ── Calendar (Microsoft 365) ────────────────────────────────────────────
// Tri-state status so the client can tell apart:
//   'not_connected' — user has no linked mailbox (the real "not synced")
//   'fetch_failed'  — Graph/transient error (retryable; NOT "not synced")
//   'ok'            — fetch succeeded (events may legitimately be empty)
function calendarResponse(result) {
  if (result === null) {
    return { events: [], allDayEvents: [], synced: false, status: 'not_connected' };
  }
  if (result.error) {
    return { events: [], allDayEvents: [], synced: false, status: 'fetch_failed' };
  }
  return { events: result.timedEvents, allDayEvents: result.allDayEvents, synced: true, status: 'ok' };
}

/**
 * GET /api/timeplans/calendar-events?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
const getMyCalendarEvents = async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ success: false, message: 'from and to query parameters are required.' });
    }
    const userRecord = await User.findByPk(req.user.id, { attributes: ['id', 'teamsUserId'] });
    if (!userRecord || !userRecord.teamsUserId) {
      return res.json({ success: true, data: calendarResponse(null) });
    }
    const result = await fetchCalendarEvents(userRecord.teamsUserId, from, to);
    res.json({ success: true, data: calendarResponse(result) });
  } catch (error) {
    console.error('[TimePlan] getMyCalendarEvents error:', error);
    res.json({ success: true, data: { events: [], allDayEvents: [], synced: false, status: 'fetch_failed' } });
  }
};

/**
 * GET /api/timeplans/calendar-events/:userId?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Calendar data is sensitive — authorized per-target like the blocks views.
 */
const getEmployeeCalendarEvents = async (req, res) => {
  try {
    const { userId } = req.params;
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ success: false, message: 'from and to query parameters are required.' });
    }

    const allowed = await plannerAccess.canViewPlanner(req.user, userId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to this user\'s calendar.' });
    }

    const employee = await User.findByPk(userId, { attributes: ['id', 'teamsUserId', 'name'] });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (!employee.teamsUserId) {
      return res.json({ success: true, data: calendarResponse(null) });
    }
    const result = await fetchCalendarEvents(employee.teamsUserId, from, to);
    res.json({ success: true, data: calendarResponse(result) });
  } catch (error) {
    console.error('[TimePlan] getEmployeeCalendarEvents error:', error);
    res.json({ success: true, data: { events: [], allDayEvents: [], synced: false, status: 'fetch_failed' } });
  }
};

module.exports = {
  createTimeBlock,
  getMyTimeBlocks,
  getEmployeeTimeBlocks,
  getTeamTimeBlocks,
  getPlannerPeople,
  updateTimeBlock,
  deleteTimeBlock,
  getMyCalendarEvents,
  getEmployeeCalendarEvents,
  // exported for tests / reuse
  PLANNER_DAY_START,
  PLANNER_DAY_END,
};
