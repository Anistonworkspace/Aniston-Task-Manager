const { Meeting, User, Task, Board, Notification } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const { emitToUser } = require('../services/socketService');
const realtime = require('../services/realtimeService');
const { logActivity } = require('../services/activityService');
const { sanitizeInput } = require('../utils/sanitize');
const { createNotification, buildIdempotencyKey } = require('../services/notificationService');
const { PILL_ATTRIBUTES: USER_PILL_ATTRIBUTES } = require('../config/userAttributes');

const MEETING_INCLUDES = [
  { model: User, as: 'organizer', attributes: [...USER_PILL_ATTRIBUTES] },
  { model: Task, as: 'task', attributes: ['id', 'title'] },
  { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
];

// Front-end and back-end must agree: only these two types are valid.
// "follow_up" is intentionally retired — it is rejected here so an old client
// (or a stale cached bundle) that still posts it gets a clear 400 instead of
// silently creating a broken record. The DB enum still *contains* follow_up so
// any legacy rows keep rendering; we simply never create new ones.
const ALLOWED_TYPES = ['meeting', 'reminder'];

const MAX_REMINDER_OCCURRENCES = 50;

// Pad a number to 2 digits.
const p2 = (n) => String(n).padStart(2, '0');
const toDateStr = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const toTimeStr = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

/**
 * Expand a reminder's schedule into concrete (date, startTime) occurrences.
 * A reminder is stored as one Meeting row per occurrence — this reuses the
 * existing meetings table/list/notification plumbing rather than introducing a
 * parallel reminder engine or a schema change.
 *
 *   schedule = 'once'   -> single occurrence at (date, startTime)
 *   schedule = 'repeat' -> repeatCount occurrences spaced repeatEvery repeatUnit apart
 */
function buildReminderOccurrences({ date, startTime, reminder }) {
  const schedule = reminder?.schedule === 'repeat' ? 'repeat' : 'once';
  if (schedule === 'once') return [{ date, startTime }];

  const every = Math.max(1, parseInt(reminder?.repeatEvery, 10) || 1);
  const unit = ['minutes', 'hours', 'days'].includes(reminder?.repeatUnit) ? reminder.repeatUnit : 'days';
  const count = Math.min(MAX_REMINDER_OCCURRENCES, Math.max(1, parseInt(reminder?.repeatCount, 10) || 1));

  const stepMs = unit === 'minutes' ? every * 60000 : unit === 'hours' ? every * 3600000 : every * 86400000;
  // Parse as local time; `${date}T${time}:00` is interpreted in the server TZ.
  let cursor = new Date(`${date}T${startTime}:00`);
  if (isNaN(cursor.getTime())) return [];

  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ date: toDateStr(cursor), startTime: toTimeStr(cursor) });
    cursor = new Date(cursor.getTime() + stepMs);
  }
  return out;
}

/**
 * POST /api/meetings
 */
const createMeeting = async (req, res) => {
  try {
    // All tiers (1-4) may create meetings and reminders. No tier gate here —
    // ownership/destructive gates still apply on update/delete.
    const { title, description, date, startTime, endTime, location, type, participants, boardId, taskId, reminder } = req.body;

    const meetingType = type || 'meeting';
    if (!ALLOWED_TYPES.includes(meetingType)) {
      return res.status(400).json({ success: false, message: 'Invalid type. Must be "meeting" or "reminder".' });
    }

    if (!title || !date || !startTime) {
      return res.status(400).json({ success: false, message: 'Title, date, and time are required.' });
    }

    const isReminder = meetingType === 'reminder';

    // Meeting-only validation: end time required and after start.
    if (!isReminder) {
      if (!endTime) {
        return res.status(400).json({ success: false, message: 'End time is required for meetings.' });
      }
      if (startTime >= endTime) {
        return res.status(400).json({ success: false, message: 'End time must be after start time.' });
      }
    }

    // Participants apply to meetings only — reminders are personal.
    let participantList = [];
    if (!isReminder && Array.isArray(participants) && participants.length > 0) {
      const userIds = participants.map(p => typeof p === 'string' ? p : p.userId);
      const users = await User.findAll({
        where: { id: { [Op.in]: userIds } },
        attributes: ['id', 'name'],
      });
      participantList = users.map(u => ({ userId: u.id, name: u.name, status: 'pending' }));
    }

    // Occurrences: meetings are always a single row. Reminders expand their
    // schedule (once / repeat-every-X) into one row each — endTime mirrors
    // startTime so the NOT NULL column is satisfied without a meeting-style range.
    let occurrences;
    if (isReminder) {
      occurrences = buildReminderOccurrences({ date, startTime, reminder });
      if (!occurrences.length) {
        return res.status(400).json({ success: false, message: 'Reminder schedule is invalid. Check the date, time and repeat settings.' });
      }
    } else {
      occurrences = [{ date, startTime, endTime }];
    }

    const baseFields = {
      title: sanitizeInput(title),
      description: sanitizeInput(description) || null,
      location: isReminder ? null : (location || null),
      type: meetingType,
      participants: participantList,
      boardId: isReminder ? null : (boardId || null),
      taskId: isReminder ? null : (taskId || null),
      createdBy: req.user.id,
    };

    const created = await sequelize.transaction(async (t) => Meeting.bulkCreate(
      occurrences.map(o => ({ ...baseFields, date: o.date, startTime: o.startTime, endTime: o.endTime || o.startTime })),
      { transaction: t, returning: true, validate: true },
    ));

    const primary = created[0];
    const fullMeeting = await Meeting.findByPk(primary.id, { include: MEETING_INCLUDES });

    // Notify participants (meetings only). Idempotent on (meeting, participant)
    // so a retried create does not double-notify.
    for (const pp of (participantList || []).filter(Boolean)) {
      if (pp.userId && pp.userId !== req.user.id) {
        await createNotification({
          userId: pp.userId,
          type: 'task_updated',
          message: `${req.user.name} invited you to a meeting: "${title}" on ${date} at ${startTime}`,
          entityType: 'meeting',
          entityId: primary.id,
          idempotencyKey: buildIdempotencyKey('meeting-invited', primary.id, pp.userId),
        });
      }
    }

    logActivity({
      action: isReminder ? 'reminder_created' : 'meeting_created',
      description: `${req.user.name} ${isReminder ? 'set a reminder' : 'scheduled'} "${title}" on ${date}`,
      entityType: 'meeting',
      entityId: primary.id,
      userId: req.user.id,
    });

    // Phase 4 — semantic meeting:created event so MeetingsPage refreshes
    // for every participant without piggybacking on the bell flow.
    realtime.emitMeetingChanged('created', fullMeeting, { actorId: req.user.id });

    res.status(201).json({
      success: true,
      message: isReminder ? 'Reminder created successfully.' : 'Meeting created successfully.',
      data: { meeting: fullMeeting, count: created.length },
    });
  } catch (error) {
    console.error('[Meeting] Create error:', error);
    res.status(500).json({ success: false, message: 'Server error creating meeting.' });
  }
};

/**
 * GET /api/meetings/my
 */
const getMyMeetings = async (req, res) => {
  try {
    const { date, from, to, status } = req.query;
    const where = {
      [Op.or]: [
        { createdBy: req.user.id },
        sequelize.where(
          sequelize.cast(sequelize.col('participants'), 'text'),
          { [Op.like]: `%${req.user.id}%` }
        ),
      ],
    };

    if (date) where.date = date;
    if (from && to) where.date = { [Op.between]: [from, to] };
    else if (from) where.date = { [Op.gte]: from };
    else if (to) where.date = { [Op.lte]: to };
    if (status) where.status = status;

    const meetings = await Meeting.findAll({
      where,
      include: MEETING_INCLUDES,
      order: [['date', 'ASC'], ['startTime', 'ASC']],
    });

    res.json({ success: true, data: { meetings } });
  } catch (error) {
    console.error('[Meeting] GetMy error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching meetings.' });
  }
};

/**
 * GET /api/meetings/team
 */
const getTeamMeetings = async (req, res) => {
  try {
    const { date, from, to } = req.query;
    const where = {};

    if (date) where.date = date;
    if (from && to) where.date = { [Op.between]: [from, to] };
    else if (from) where.date = { [Op.gte]: from };

    const meetings = await Meeting.findAll({
      where,
      include: MEETING_INCLUDES,
      order: [['date', 'ASC'], ['startTime', 'ASC']],
    });

    res.json({ success: true, data: { meetings } });
  } catch (error) {
    console.error('[Meeting] GetTeam error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching team meetings.' });
  }
};

/**
 * PUT /api/meetings/:id
 */
const updateMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.findByPk(req.params.id);
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found.' });
    if (meeting.createdBy !== req.user.id && !['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the organizer or admin can update this meeting.' });
    }

    const allowed = ['title', 'description', 'date', 'startTime', 'endTime', 'location', 'type', 'status', 'participants', 'boardId', 'taskId'];
    const updates = {};
    for (const f of allowed) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (updates.type !== undefined && !ALLOWED_TYPES.includes(updates.type)) {
      return res.status(400).json({ success: false, message: 'Invalid type. Must be "meeting" or "reminder".' });
    }
    // A reminder has no distinct end — mirror startTime so the NOT NULL column
    // stays valid even if the client omits endTime on a reminder edit.
    const effectiveType = updates.type || meeting.type;
    if (effectiveType === 'reminder' && updates.startTime !== undefined && updates.endTime === undefined) {
      updates.endTime = updates.startTime;
    }
    if (updates.title !== undefined) updates.title = sanitizeInput(updates.title);
    if (updates.description !== undefined) updates.description = sanitizeInput(updates.description);

    await meeting.update(updates);
    const fullMeeting = await Meeting.findByPk(meeting.id, { include: MEETING_INCLUDES });

    realtime.emitMeetingChanged('updated', fullMeeting, { actorId: req.user.id });

    res.json({ success: true, message: 'Meeting updated.', data: { meeting: fullMeeting } });
  } catch (error) {
    console.error('[Meeting] Update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating meeting.' });
  }
};

/**
 * PUT /api/meetings/:id/respond
 */
const respondToMeeting = async (req, res) => {
  try {
    const { status } = req.body;
    if (!['accepted', 'declined'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be "accepted" or "declined".' });
    }

    const meeting = await Meeting.findByPk(req.params.id);
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found.' });

    const participants = [...(meeting.participants || [])].filter(Boolean);
    const idx = participants.findIndex(p => p.userId === req.user.id);
    if (idx === -1) return res.status(403).json({ success: false, message: 'You are not a participant of this meeting.' });

    participants[idx] = { ...participants[idx], status };
    await meeting.update({ participants });

    // Notify organizer. Idempotency key includes the status so accept-then-
    // decline-then-accept produces three rows; same status applied twice
    // (e.g. duplicate click) produces one.
    if (meeting.createdBy !== req.user.id) {
      await createNotification({
        userId: meeting.createdBy,
        type: 'task_updated',
        message: `${req.user.name} ${status} your meeting "${meeting.title}"`,
        entityType: 'meeting',
        entityId: meeting.id,
        idempotencyKey: buildIdempotencyKey('meeting-respond', meeting.id, req.user.id, status),
      });
    }

    const fullMeeting = await Meeting.findByPk(meeting.id, { include: MEETING_INCLUDES });
    // Send status-specific event so the organizer's MeetingsPage updates.
    realtime.emitMeetingChanged(status, fullMeeting, { actorId: req.user.id });
    res.json({ success: true, message: `Meeting ${status}.`, data: { meeting: fullMeeting } });
  } catch (error) {
    console.error('[Meeting] Respond error:', error);
    res.status(500).json({ success: false, message: 'Server error responding to meeting.' });
  }
};

/**
 * DELETE /api/meetings/:id
 */
const deleteMeeting = async (req, res) => {
  try {
    const meeting = await Meeting.findByPk(req.params.id);
    if (!meeting) return res.status(404).json({ success: false, message: 'Meeting not found.' });
    if (meeting.createdBy !== req.user.id && !['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the organizer or admin can delete this meeting.' });
    }

    // Phase 5d — destructive-action gate.
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      const isOwnResource = meeting.createdBy === req.user.id;
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'meeting', { isOwnResource }))) return;
    }

    // Notify participants of cancellation. Idempotent — replayed DELETE
    // cannot double-notify.
    for (const p of (meeting.participants || []).filter(Boolean)) {
      if (p.userId && p.userId !== req.user.id) {
        await createNotification({
          userId: p.userId,
          type: 'task_updated',
          message: `${req.user.name} cancelled the meeting "${meeting.title}"`,
          entityType: 'meeting',
          entityId: meeting.id,
          idempotencyKey: buildIdempotencyKey('meeting-cancelled', meeting.id, p.userId),
        });
      }
    }

    // Snapshot meeting BEFORE destroy so we can fan out to participants —
    // realtimeService can't read the row after it's gone.
    const meetingSnapshot = meeting.toJSON();
    await meeting.destroy();
    realtime.emitMeetingChanged('deleted', meetingSnapshot, { actorId: req.user.id });
    res.json({ success: true, message: 'Meeting deleted.' });
  } catch (error) {
    console.error('[Meeting] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting meeting.' });
  }
};

module.exports = {
  createMeeting, getMyMeetings, getTeamMeetings, updateMeeting, respondToMeeting, deleteMeeting,
  // Exported for unit testing of the reminder schedule expansion.
  buildReminderOccurrences, ALLOWED_TYPES,
};
