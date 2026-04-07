const { Comment, Task, User, Board, Notification } = require('../models');
const { validationResult } = require('express-validator');
const { emitToBoard, emitToUser } = require('../services/socketService');
const teamsWebhook = require('../services/teamsWebhook');
const teamsNotif = require('../services/teamsNotificationService');
const { sanitizeInput } = require('../utils/sanitize');

/**
 * POST /api/comments
 * Body: { content, taskId, attachments? }
 */
const addComment = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { content: rawContent, taskId, attachments } = req.body;
    const content = sanitizeInput(rawContent);

    const task = await Task.findByPk(taskId, {
      include: [{ model: Board, as: 'board', attributes: ['id', 'name'] }],
    });

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const comment = await Comment.create({
      content,
      attachments: attachments || [],
      taskId,
      userId: req.user.id,
    });

    const fullComment = await Comment.findByPk(comment.id, {
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatar'] },
      ],
    });

    // Notify task assignee (if different from commenter)
    if (task.assignedTo && task.assignedTo !== req.user.id) {
      const notification = await Notification.create({
        type: 'comment_added',
        message: `${req.user.name} commented on "${task.title}"`,
        entityType: 'task',
        entityId: taskId,
        userId: task.assignedTo,
      });
      emitToUser(task.assignedTo, 'notification:new', { notification });
    }

    // Detect @mentions in comment content
    const mentionRegex = /@(\w+(?:\s\w+)?)/g;
    const mentions = [];
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1]);
    }
    if (mentions.length > 0) {
      const mentionedUsers = await User.findAll({
        where: { name: { [require('sequelize').Op.iLike]: mentions.map(m => `%${m}%`) } },
        attributes: ['id', 'name'],
      });
      for (const mu of mentionedUsers) {
        if (mu.id === req.user.id) continue; // Don't notify self
        if (mu.id === task.assignedTo) continue; // Already notified above
        const n = await Notification.create({
          type: 'mention',
          message: `${req.user.name} mentioned you in a comment on "${task.title}"`,
          entityType: 'task',
          entityId: taskId,
          userId: mu.id,
        });
        emitToUser(mu.id, 'notification:new', { notification: n });
      }
    }

    // Notify task creator (if different from commenter and assignee)
    if (task.createdBy !== req.user.id && task.createdBy !== task.assignedTo) {
      const notification = await Notification.create({
        type: 'comment_added',
        message: `${req.user.name} commented on "${task.title}"`,
        entityType: 'task',
        entityId: taskId,
        userId: task.createdBy,
      });
      emitToUser(task.createdBy, 'notification:new', { notification });
    }

    // Socket.io
    emitToBoard(task.boardId, 'comment:created', {
      comment: fullComment,
      taskId,
    });

    // Teams webhook (channel-level)
    const preview = content.length > 120 ? content.substring(0, 120) + '...' : content;
    teamsWebhook.sendCommentAdded({
      task,
      boardName: task.board.name,
      commenterName: req.user.name,
      commentPreview: preview,
    });

    // Teams personal chat notification (fire-and-forget)
    teamsNotif.notifyNewComment(taskId, req.user.id, content).catch(err =>
      console.warn('[Comment] Teams chat notification failed:', err.message)
    );

    res.status(201).json({
      success: true,
      message: 'Comment added successfully.',
      data: { comment: fullComment },
    });
  } catch (error) {
    console.error('[Comment] Add error:', error);
    res.status(500).json({ success: false, message: 'Server error adding comment.' });
  }
};

/**
 * GET /api/comments?taskId=<uuid>
 */
const getComments = async (req, res) => {
  try {
    const { taskId } = req.query;

    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId query parameter is required.' });
    }

    const task = await Task.findByPk(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const comments = await Comment.findAll({
      where: { taskId },
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatar'] },
      ],
      order: [['createdAt', 'ASC']],
    });

    res.json({ success: true, data: { comments } });
  } catch (error) {
    console.error('[Comment] GetComments error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching comments.' });
  }
};

/**
 * DELETE /api/comments/:id
 */
const deleteComment = async (req, res) => {
  try {
    const comment = await Comment.findByPk(req.params.id, {
      include: [{ model: Task, as: 'task', attributes: ['id', 'boardId'] }],
    });

    if (!comment) {
      return res.status(404).json({ success: false, message: 'Comment not found.' });
    }

    // Only the comment author or an admin may delete
    if (comment.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own comments.',
      });
    }

    const taskId = comment.taskId;
    const boardId = comment.task.boardId;
    const commentId = comment.id;

    await comment.destroy();

    emitToBoard(boardId, 'comment:deleted', { commentId, taskId });

    res.json({ success: true, message: 'Comment deleted successfully.' });
  } catch (error) {
    console.error('[Comment] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting comment.' });
  }
};

module.exports = { addComment, getComments, deleteComment };
