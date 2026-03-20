const { Meeting, User, Task, Board, Notification } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const { emitToUser } = require('../services/socketService');
const { logActivity } = require('../services/activityService');

const MEETING_INCLUDES = [
  { model: User, as: 'organizer', attributes: ['id', 'name', 'email', 'avatar'] },
  { model: Task, as: 'task', attributes: ['id', 'title'] },
  { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
];

/**
 * POST /api/meetings
 */
const createMeeting = async (req, res) => {
  try {
    const { title, description, date, startTime, endTime, location, type, participants, boardId, taskId } = req.body;

    if (!title || !date || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: 'Title, date, start time, and end time are required.' });
    }

    // Build participants array with names
    let participantList = [];
    if (Array.isArray(participants) && participants.length > 0) {
      const userIds = participants.map(p => typeof p === 'string' ? p : p.userId);
      const users = await User.findAll({
        where: { id: { [Op.in]: userIds } },
        attributes: ['id', 'name'],
      });
      participantList = users.map(u => ({ userId: u.id, name: u.name, status: 'pending' }));
    }

    const meeting = await Meeting.create({
      title,
      description: description || null,
      date,
      startTime,
      endTime,
      location: location || null,
      type: type || 'meeting',
      participants: participantList,
      boardId: boardId || null,
      taskId: taskId || null,
      createdBy: req.user.id,
    });

    const fullMeeting = await Meeting.findByPk(meeting.id, { include: MEETING_INCLUDES });

    // Notify participants
    for (const p of participantList) {
      if (p.userId !== req.user.id) {
        const typeLabel = type === 'reminder' ? 'reminder' : type === 'follow_up' ? 'follow-up' : 'meeting';
        const notification = await Notification.create({
          type: 'task_updated',
          message: `${req.user.name} invited you to a ${typeLabel}: "${title}" on ${date} at ${startTime}`,
          entityType: 'meeting',
          entityId: meeting.id,
          userId: p.userId,
        });
        emitToUser(p.userId, 'notification:new', { notification });
      }
    }

    logActivity({
      action: 'meeting_created',
      description: `${req.user.name} scheduled "${title}" on ${date}`,
      entityType: 'meeting',
      entityId: meeting.id,
      userId: req.user.id,
    });

    res.status(201).json({ success: true, message: 'Meeting created successfully.', data: { meeting: fullMeeting } });
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
    if (meeting.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only the organizer or admin can update this meeting.' });
    }

    const allowed = ['title', 'description', 'date', 'startTime', 'endTime', 'location', 'type', 'status', 'participants', 'boardId', 'taskId'];
    const updates = {};
    for (const f of allowed) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }

    await meeting.update(updates);
    const fullMeeting = await Meeting.findByPk(meeting.id, { include: MEETING_INCLUDES });

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

    const participants = [...(meeting.participants || [])];
    const idx = participants.findIndex(p => p.userId === req.user.id);
    if (idx === -1) return res.status(403).json({ success: false, message: 'You are not a participant of this meeting.' });

    participants[idx] = { ...participants[idx], status };
    await meeting.update({ participants });

    // Notify organizer
    if (meeting.createdBy !== req.user.id) {
      const notification = await Notification.create({
        type: 'task_updated',
        message: `${req.user.name} ${status} your meeting "${meeting.title}"`,
        entityType: 'meeting',
        entityId: meeting.id,
        userId: meeting.createdBy,
      });
      emitToUser(meeting.createdBy, 'notification:new', { notification });
    }

    const fullMeeting = await Meeting.findByPk(meeting.id, { include: MEETING_INCLUDES });
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
    if (meeting.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only the organizer or admin can delete this meeting.' });
    }

    // Notify participants of cancellation
    for (const p of meeting.participants || []) {
      if (p.userId !== req.user.id) {
        const notification = await Notification.create({
          type: 'task_updated',
          message: `${req.user.name} cancelled the meeting "${meeting.title}"`,
          entityType: 'meeting',
          entityId: meeting.id,
          userId: p.userId,
        });
        emitToUser(p.userId, 'notification:new', { notification });
      }
    }

    await meeting.destroy();
    res.json({ success: true, message: 'Meeting deleted.' });
  } catch (error) {
    console.error('[Meeting] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting meeting.' });
  }
};

module.exports = { createMeeting, getMyMeetings, getTeamMeetings, updateMeeting, respondToMeeting, deleteMeeting };
