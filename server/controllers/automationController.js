const { Automation, Board, User } = require('../models');
const { sanitizeInput } = require('../utils/sanitize');

// S-H6 / P0-7 — Allowlist of fields a client may write through the
// create/update endpoints. Anything outside this set (createdBy, id,
// timestamps, etc.) is silently ignored — defence against mass-assignment
// where a malicious client tries to forge ownership or back-date a row.
const ALLOWED_FIELDS = [
  'name',
  'boardId',
  'trigger',
  'triggerValue',
  'action',
  'actionConfig',
  'isActive',
];
const ALLOWED_FIELDS_UPDATE = ALLOWED_FIELDS.filter((f) => f !== 'boardId');

// S-H6 — Board-access gate. An automation lives on a board, so the actor
// must be allowed to manage that board. Mirrors boardController.updateBoard:
// admins/super admins pass unconditionally; everyone else must be the
// creator. The route-level requireRole already keeps members out, so this
// is the second line of defence (manager-on-stranger-board case).
function canManageBoard(user, board) {
  if (!user || !board) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin') return true;
  if (board.createdBy === user.id) return true;
  return false;
}

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
    // Pick only the allowlisted fields off req.body. Trust nothing else
    // — req.body.createdBy / req.body.id would otherwise leak through.
    const picked = {};
    for (const f of ALLOWED_FIELDS) {
      if (req.body[f] !== undefined) picked[f] = req.body[f];
    }
    const { name, boardId, trigger, triggerValue, action, actionConfig, isActive } = picked;

    if (!name || !boardId || !trigger || !action) {
      return res.status(400).json({ success: false, message: 'name, boardId, trigger, and action are required.' });
    }

    // boardId membership / management check.
    const board = await Board.findByPk(boardId);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }
    if (!canManageBoard(req.user, board)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to manage automations on this board.',
      });
    }

    const auto = await Automation.create({
      name: sanitizeInput(name),
      boardId,
      trigger: sanitizeInput(trigger),
      triggerValue: typeof triggerValue === 'string' ? sanitizeInput(triggerValue) : (triggerValue || null),
      action: sanitizeInput(action),
      actionConfig: actionConfig || {},
      isActive: isActive !== undefined ? !!isActive : true,
      createdBy: req.user.id,
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

    // S-H6 — verify the actor can manage the board the automation lives on.
    const board = await Board.findByPk(auto.boardId);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });
    if (!canManageBoard(req.user, board)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to manage automations on this board.',
      });
    }

    const updates = {};
    for (const f of ALLOWED_FIELDS_UPDATE) {
      if (req.body[f] !== undefined) {
        const v = req.body[f];
        if ((f === 'name' || f === 'trigger' || f === 'action' || f === 'triggerValue')
            && typeof v === 'string') {
          updates[f] = sanitizeInput(v);
        } else {
          updates[f] = v;
        }
      }
    }
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

    // Phase 5d — destructive-action gate. Automations are board-level
    // shared config; T2 cannot delete (decision #4), T1 always.
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      const isOwnResource = auto.createdBy === req.user.id;
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'automation', { isOwnResource }))) return;
    }

    await auto.destroy();
    res.json({ success: true, message: 'Automation deleted.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getAutomations, createAutomation, updateAutomation, deleteAutomation };
