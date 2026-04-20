/**
 * POST /api/tasks/:id/receipt
 *
 * Body: { event: 'seen' | 'delivered' }  (default: 'seen')
 *
 * Authorization: only the caller can mark *their own* delivered/seen state,
 * and only if they are an assignee (role='assignee') of the task. Anyone else
 * gets 403. The endpoint is idempotent — repeated calls are no-ops once
 * seenAt / deliveredAt is populated.
 */

const { Task, TaskAssignee } = require('../models');
const logger = require('../utils/logger');
const receiptService = require('../services/taskReceiptService');
const { emitToBoard, emitToUser } = require('../services/socketService');

const recordReceipt = async (req, res) => {
  try {
    const taskId = req.params.id;
    const event = (req.body && req.body.event) || 'seen';
    if (!['seen', 'delivered'].includes(event)) {
      return res.status(400).json({ success: false, message: 'Invalid event type.' });
    }

    const task = await Task.findByPk(taskId, { attributes: ['id', 'boardId', 'createdBy', 'assignedTo'] });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    let result;
    if (event === 'seen') {
      result = await receiptService.markSeen(req.user.id, taskId);
    } else {
      // delivered: only mark if currently NULL, scoped to this one task.
      const transitioned = await receiptService.markDelivered(req.user.id, [taskId]);
      result = { changed: transitioned.length > 0, deliveredNow: transitioned.length > 0, seenNow: false };
    }

    if (result.notAssignee) {
      return res.status(403).json({ success: false, message: 'Only assignees can acknowledge receipt.' });
    }

    // Always return the current summary so the client can refresh UI
    // consistently, even if no write happened (idempotent calls).
    const summary = await receiptService.fetchSummary(taskId, task.createdBy);

    if (result.changed && summary) {
      // Notify the assigner (creator) in real time so the row icon updates
      // without a refetch. Board room covers most cases; user room covers
      // creators who aren't currently viewing the board. The `createdBy`
      // field is included so non-assigner clients can safely ignore.
      const payload = {
        taskId,
        boardId: task.boardId,
        createdBy: task.createdBy,
        summary,
      };
      try { emitToBoard(task.boardId, 'task:receipt', payload); } catch {}
      if (task.createdBy) {
        try { emitToUser(task.createdBy, 'task:receipt', payload); } catch {}
      }
    }

    return res.json({ success: true, data: { changed: !!result.changed, summary } });
  } catch (err) {
    logger.error('[TaskReceipt] recordReceipt error:', err);
    return res.status(500).json({ success: false, message: 'Server error recording receipt.' });
  }
};

module.exports = { recordReceipt };
