const { Automation, Board, User } = require('../models');

const getAutomations = async (req, res) => {
  try {
    const { boardId } = req.query;
    const where = {};
    if (boardId) where.boardId = boardId;
    const automations = await Automation.findAll({
      where, order: [['createdAt', 'DESC']],
      include: [{ model: User, as: 'creator', attributes: ['id', 'name'] }],
    });
    res.json({ success: true, data: { automations } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const createAutomation = async (req, res) => {
  try {
    const { name, boardId, trigger, triggerValue, action, actionConfig } = req.body;
    if (!name || !boardId || !trigger || !action) {
      return res.status(400).json({ success: false, message: 'name, boardId, trigger, and action are required.' });
    }
    const auto = await Automation.create({
      name, boardId, trigger, triggerValue: triggerValue || null,
      action, actionConfig: actionConfig || {}, createdBy: req.user.id,
    });
    res.status(201).json({ success: true, data: { automation: auto } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error creating automation.' });
  }
};

const updateAutomation = async (req, res) => {
  try {
    const auto = await Automation.findByPk(req.params.id);
    if (!auto) return res.status(404).json({ success: false, message: 'Not found.' });
    const allowed = ['name', 'trigger', 'triggerValue', 'action', 'actionConfig', 'isActive'];
    const updates = {};
    for (const f of allowed) { if (req.body[f] !== undefined) updates[f] = req.body[f]; }
    await auto.update(updates);
    res.json({ success: true, data: { automation: auto } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

const deleteAutomation = async (req, res) => {
  try {
    const auto = await Automation.findByPk(req.params.id);
    if (!auto) return res.status(404).json({ success: false, message: 'Not found.' });
    await auto.destroy();
    res.json({ success: true, message: 'Automation deleted.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getAutomations, createAutomation, updateAutomation, deleteAutomation };
