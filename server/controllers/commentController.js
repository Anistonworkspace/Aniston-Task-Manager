const { Comment, Task, User, Board, Notification } = require('../models');
const { validationResult } = require('express-validator');
const { emitToBoard, emitToUser, emitToUsers } = require('../services/socketService');
const teamsWebhook = require('../services/teamsWebhook');
const teamsNotif = require('../services/teamsNotificationService');
const { sanitizeInput, sanitizeNotificationField, sanitizeNotificationMessage } = require('../utils/sanitize');
const taskVisibility = require('../services/taskVisibilityService');
const { createNotification, buildIdempotencyKey } = require('../services/notificationService');

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

    const { content: rawContent, taskId, attachments, mentionedUserIds } = req.body;
    const content = sanitizeInput(rawContent);

    const task = await Task.findByPk(taskId, {
      include: [{ model: Board, as: 'board', attributes: ['id', 'name'] }],
    });

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    // Phase 5e — closes audit P1-5 (write side). Verify the commenter can
    // actually see this task before persisting. Previously any authenticated
    // user could attach comments to any task by guessing the taskId; the
    // realtime fan-out correctly limited recipients but the row was created
    // and the actor leaked the parent task's title via the response.
    const canSeeTask = await taskVisibility.canViewTask(req.user, task);
    if (!canSeeTask && !req.user.isSuperAdmin && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this task.',
      });
    }

    // Phase 7 — granular comments.create gate. Umbrella → tasks.comment
    // preserves backward compat with existing rows on the legacy key.
    {
      const { denyIfNoPermission } = require('../utils/permissionGate');
      if (await denyIfNoPermission(res, req.user, 'comments', 'create',
          'You do not have permission to add comments.')) return;
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

    // Pre-compute the safe text fragments used in every notification message.
    const safeActor = sanitizeNotificationField(req.user.name);
    const safeTitle = sanitizeNotificationField(task.title);
    const commentMsg = sanitizeNotificationMessage(`${safeActor} commented on "${safeTitle}"`);
    const mentionMsg = sanitizeNotificationMessage(
      `${safeActor} mentioned you in a comment on "${safeTitle}"`
    );

    // Notify task assignee (if different from commenter). Idempotency keyed
    // on the comment id so a retried POST (network blip + replay) cannot
    // produce two notification rows for the same logical comment event.
    if (task.assignedTo && task.assignedTo !== req.user.id) {
      await createNotification({
        userId: task.assignedTo,
        type: 'comment_added',
        message: commentMsg,
        entityType: 'task',
        entityId: taskId,
        boardId: task.boardId,
        idempotencyKey: buildIdempotencyKey('comment-added', comment.id, task.assignedTo),
        sanitize: false, // already sanitized above
      });
    }

    // ── Mentions (RBAC-safe) ──────────────────────────────────
    // Frontend SHOULD send a structured mentionedUserIds array. We accept it,
    // validate every id is a real, active user, AND filter every id through
    // taskVisibilityService.getAuthorizedRealtimeRecipients(task) — so a
    // commenter cannot @-mention a user who has no visibility into the task
    // and leak the title to them.
    //
    // The previous regex+iLike scan matched arbitrary substrings of names
    // across the whole users table and bypassed RBAC entirely. It is removed.
    // If a backwards-compatible client sends only @name mentions in text and
    // no mentionedUserIds array, no notification fires — this is the SAFE
    // behaviour. The frontend can be updated to send the structured field.
    const requestedMentionIds = Array.isArray(mentionedUserIds) ? mentionedUserIds.filter(Boolean) : [];
    if (requestedMentionIds.length > 0) {
      const authorizedRecipients = new Set(
        await taskVisibility.getAuthorizedRealtimeRecipients(task)
      );
      const validMentioned = await User.findAll({
        where: {
          id: { [require('sequelize').Op.in]: requestedMentionIds },
          isActive: true,
        },
        attributes: ['id', 'name'],
      });
      for (const mu of validMentioned) {
        if (mu.id === req.user.id) continue; // self-mention noop
        if (mu.id === task.assignedTo) continue; // already notified above
        if (!authorizedRecipients.has(mu.id)) continue; // RBAC: skip users who can't see the task
        await createNotification({
          userId: mu.id,
          type: 'mention',
          message: mentionMsg,
          entityType: 'task',
          entityId: taskId,
          boardId: task.boardId,
          idempotencyKey: buildIdempotencyKey('comment-mention', comment.id, mu.id),
          sanitize: false,
        });
      }
    }

    // Notify task creator (if different from commenter and assignee).
    if (task.createdBy !== req.user.id && task.createdBy !== task.assignedTo) {
      await createNotification({
        userId: task.createdBy,
        type: 'comment_added',
        message: commentMsg,
        entityType: 'task',
        entityId: taskId,
        boardId: task.boardId,
        idempotencyKey: buildIdempotencyKey('comment-added', comment.id, task.createdBy),
        sanitize: false,
      });
    }

    // CP-3 RBAC: emit comment events only to authorized recipients of the
    // parent task. The previous board-room broadcast leaked the existence
    // (and content) of comments on tasks the receiver couldn't see.
    const recipients = await taskVisibility.getAuthorizedRealtimeRecipients(task);
    emitToUsers('comment:created', { comment: fullComment, taskId }, recipients);

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

    // Phase 5e — closes audit P1-5 (read side). Hide comments for users who
    // can't see the parent task; otherwise any authenticated user could
    // enumerate cross-task discussions by query string.
    const canSeeTask = await taskVisibility.canViewTask(req.user, task);
    if (!canSeeTask && !req.user.isSuperAdmin && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this task.',
      });
    }

    // Phase B — granular comments.view gate. Umbrella → tasks.view.
    {
      const { denyIfNoPermission } = require('../utils/permissionGate');
      if (await denyIfNoPermission(res, req.user, 'comments', 'view',
          'You do not have permission to view comments.')) return;
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

    // Only the comment author or someone at Tier 2 (admin/manager) and above
    // may delete. Replacing the literal role string check with the tier
    // helper means a future role rename or the `isSuperAdmin` elevation flag
    // is honoured automatically (a super admin always satisfies Tier 2+).
    const { TIER_2, hasTierAtLeast } = require('../config/tiers');
    if (comment.userId !== req.user.id && !hasTierAtLeast(req.user, TIER_2)) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own comments.',
      });
    }

    // Phase 5d — destructive-action gate. T2 cannot delete ANY comment
    // (including their own — decision #4). T1 always allowed. T3/T4 may
    // delete own comments only (matches current member behavior).
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      const isOwnResource = comment.userId === req.user.id;
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'comment', { isOwnResource }))) return;
    }

    // Phase 7+B — granular comments.delete_own / delete_any gates. The
    // ownership check above + tier rules form the floor; these add
    // deny-override hooks per-action so an admin can revoke one without
    // the other. Umbrella → task_comments.delete preserves backward compat.
    {
      const { hasPermission: enginePermissionDel } = require('../services/permissionEngine');
      const isOwnResource = comment.userId === req.user.id;
      const actionKey = isOwnResource ? 'delete_own' : 'delete_any';
      const canDelete = await enginePermissionDel(req.user, 'comments', actionKey);
      if (!canDelete) {
        return res.status(403).json({
          success: false,
          code: 'PERMISSION_DENIED',
          permission: `comments.${actionKey}`,
          message: isOwnResource
            ? 'You do not have permission to delete your own comments.'
            : 'You do not have permission to delete other users\' comments.',
        });
      }
    }

    const taskId = comment.taskId;
    const boardId = comment.task.boardId;
    const commentId = comment.id;

    await comment.destroy();

    // CP-3 RBAC: same recipient rule as create.
    const recipients = await taskVisibility.getAuthorizedRealtimeRecipients(taskId);
    emitToUsers('comment:deleted', { commentId, taskId }, recipients);

    res.json({ success: true, message: 'Comment deleted successfully.' });
  } catch (error) {
    console.error('[Comment] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting comment.' });
  }
};

module.exports = { addComment, getComments, deleteComment };
