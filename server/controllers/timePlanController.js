const { TimeBlock, Task, User, Board } = require('../models');
const { Op } = require('sequelize');

/**
 * POST /api/timeplans
 * Create a time block for the current user
 */
const createTimeBlock = async (req, res) => {
  try {
    const { date, startTime, endTime, description, taskId, boardId, forUserId } = req.body;

    if (!date || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: 'date, startTime, and endTime are required.' });
    }

    if (startTime >= endTime) {
      return res.status(400).json({ success: false, message: 'startTime must be before endTime.' });
    }

    // Allow managers/admins to create blocks for other users (PA workflow)
    let targetUserId = req.user.id;
    if (forUserId && forUserId !== req.user.id) {
      if (!['manager', 'admin', 'assistant_manager'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only managers/admins can create blocks for other users.' });
      }
      const targetUser = await User.findByPk(forUserId);
      if (!targetUser || !targetUser.isActive) {
        return res.status(404).json({ success: false, message: 'Target user not found.' });
      }
      targetUserId = forUserId;
    }

    // Check for overlapping blocks
    const overlap = await TimeBlock.findOne({
      where: {
        userId: targetUserId,
        date,
        [Op.or]: [
          { startTime: { [Op.lt]: endTime }, endTime: { [Op.gt]: startTime } },
        ],
      },
    });
    if (overlap) {
      return res.status(400).json({ success: false, message: 'This time block overlaps with an existing one.' });
    }

    const block = await TimeBlock.create({
      date,
      startTime,
      endTime,
      description: description || '',
      taskId: taskId || null,
      boardId: boardId || null,
      userId: targetUserId,
    });

    const full = await TimeBlock.findByPk(block.id, {
      include: [
        { model: Task, as: 'task', attributes: ['id', 'title', 'status'] },
        { model: User, as: 'user', attributes: ['id', 'name', 'avatar'] },
      ],
    });

    res.status(201).json({ success: true, data: full });
  } catch (error) {
    console.error('[TimePlan] create error:', error);
    res.status(500).json({ success: false, message: 'Server error creating time block.' });
  }
};

/**
 * GET /api/timeplans/my?date=YYYY-MM-DD or ?from=&to=
 * Get current user's time blocks for a date or date range
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
      include: [
        { model: Task, as: 'task', attributes: ['id', 'title', 'status', 'priority'] },
      ],
      order: [['startTime', 'ASC']],
    });

    res.json({ success: true, data: blocks });
  } catch (error) {
    console.error('[TimePlan] getMyTimeBlocks error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching time blocks.' });
  }
};

/**
 * GET /api/timeplans/employee/:userId?date=YYYY-MM-DD
 * Manager/Admin can view an employee's time blocks
 */
const getEmployeeTimeBlocks = async (req, res) => {
  try {
    const { userId } = req.params;
    const { date, from, to } = req.query;
    const where = { userId };
    if (from && to) where.date = { [Op.between]: [from, to] };
    else if (from) where.date = { [Op.gte]: from };
    else if (date) where.date = date;

    const employee = await User.findByPk(userId, {
      attributes: ['id', 'name', 'email', 'avatar', 'designation', 'department'],
    });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const blocks = await TimeBlock.findAll({
      where,
      include: [
        { model: Task, as: 'task', attributes: ['id', 'title', 'status', 'priority'] },
      ],
      order: [['startTime', 'ASC']],
    });

    res.json({ success: true, data: { employee, blocks } });
  } catch (error) {
    console.error('[TimePlan] getEmployeeTimeBlocks error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching employee time blocks.' });
  }
};

/**
 * GET /api/timeplans/team?date=YYYY-MM-DD
 * Manager/Admin can view all team members' time blocks for a date
 */
const getTeamTimeBlocks = async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, message: 'date query parameter is required.' });
    }

    const blocks = await TimeBlock.findAll({
      where: { date },
      include: [
        { model: Task, as: 'task', attributes: ['id', 'title', 'status'] },
        { model: User, as: 'user', attributes: ['id', 'name', 'avatar', 'designation'] },
      ],
      order: [['startTime', 'ASC']],
    });

    // Group by user
    const byUser = {};
    blocks.forEach(b => {
      const plain = b.toJSON();
      const uid = plain.userId;
      if (!byUser[uid]) {
        byUser[uid] = { user: plain.user, blocks: [] };
      }
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
 * Update a time block (owner only)
 */
const updateTimeBlock = async (req, res) => {
  try {
    const block = await TimeBlock.findByPk(req.params.id);
    if (!block) {
      return res.status(404).json({ success: false, message: 'Time block not found.' });
    }
    if (block.userId !== req.user.id && req.user.role === 'member') {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    const { date, startTime, endTime, description, taskId, boardId } = req.body;

    const newStart = startTime || block.startTime;
    const newEnd = endTime || block.endTime;
    const newDate = date || block.date;

    if (newStart >= newEnd) {
      return res.status(400).json({ success: false, message: 'startTime must be before endTime.' });
    }

    // Check overlaps (exclude self)
    const overlap = await TimeBlock.findOne({
      where: {
        userId: block.userId,
        date: newDate,
        id: { [Op.ne]: block.id },
        [Op.or]: [
          { startTime: { [Op.lt]: newEnd }, endTime: { [Op.gt]: newStart } },
        ],
      },
    });
    if (overlap) {
      return res.status(400).json({ success: false, message: 'This time block overlaps with an existing one.' });
    }

    await block.update({
      ...(date !== undefined && { date }),
      ...(startTime !== undefined && { startTime }),
      ...(endTime !== undefined && { endTime }),
      ...(description !== undefined && { description }),
      ...(taskId !== undefined && { taskId: taskId || null }),
      ...(boardId !== undefined && { boardId: boardId || null }),
    });

    const full = await TimeBlock.findByPk(block.id, {
      include: [
        { model: Task, as: 'task', attributes: ['id', 'title', 'status'] },
        { model: User, as: 'user', attributes: ['id', 'name', 'avatar'] },
      ],
    });

    res.json({ success: true, data: full });
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
    if (block.userId !== req.user.id && req.user.role === 'member') {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }
    await block.destroy();
    res.json({ success: true, message: 'Time block deleted.' });
  } catch (error) {
    console.error('[TimePlan] delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting time block.' });
  }
};

module.exports = { createTimeBlock, getMyTimeBlocks, getEmployeeTimeBlocks, getTeamTimeBlocks, updateTimeBlock, deleteTimeBlock };
