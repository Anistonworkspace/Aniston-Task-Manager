const { FileAttachment, Task, User, DependencyRequest } = require('../models');
const { emitToBoard, emitToUsers } = require('../services/socketService');
const taskVisibility = require('../services/taskVisibilityService');
const {
  storeFile,
  deleteFile,
  resolveFile,
  fileExists,
  normalizeMetadata,
  cleanupOnError,
  sanitizeOriginalName,
} = require('../services/storageService');

/**
 * Check if a user has read access to a task's files. Delegates to the
 * centralized `taskVisibilityService.canViewTask` so the file access rule
 * is IDENTICAL to the rule used by the board list query, the task detail
 * middleware, and comment / subtask / approval controllers — one source
 * of truth.
 *
 * Why this matters: the previous inline check only matched direct linkage
 * (assignedTo / createdBy / TaskAssignee / TaskOwner / board membership)
 * and ignored the hierarchy subtree. A Tier 3 manager could see a
 * descendant's task in the board listing (visibility filter is
 * hierarchy-aware) but the modal's /files load returned 403, surfacing
 * the "You do not have access to this task" toast despite legitimate
 * visibility on the parent. Note that board-membership-only access was
 * also dropped here on purpose — per the visibility service contract,
 * board membership grants BOARD ACCESS only, never task-row visibility.
 *
 * Tier semantics are entirely encapsulated by `canViewTask`:
 *   - Tier 1 / Tier 2 (admin, super_admin) → unrestricted
 *   - Tier 3 / Tier 4 → self ∪ descendants subtree match against
 *     assignedTo / createdBy / task_assignees / task_owners
 *
 * The dependency-owner read path is preserved separately so that a user
 * assigned to a DependencyRequest on this parent still gets read access
 * to its files.
 */
const canAccessTask = async (taskId, user) => {
  if (!user || !taskId) return false;

  if (await taskVisibility.canViewTask(user, taskId)) return true;

  try {
    const depCount = await DependencyRequest.count({
      where: { parentTaskId: taskId, assignedToUserId: user.id },
    });
    if (depCount > 0) return true;
  } catch { /* dependency_requests table may not exist on very old DBs */ }

  return false;
};

/**
 * POST /api/files
 * Upload a file attached to a task.
 * Category validation is handled by middleware before this runs.
 */
const uploadFile = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const { taskId } = req.body;
    const category = req._uploadCategory || 'task_attachment';

    if (!taskId) {
      cleanupOnError(req.file);
      return res.status(400).json({ success: false, message: 'taskId is required.' });
    }

    const task = await Task.findByPk(taskId);
    if (!task) {
      cleanupOnError(req.file);
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    // Phase 5e — closes audit P0-6. Verify the uploader can actually access
    // the parent task before persisting the attachment. Previously any
    // authenticated user could attach files to any task by guessing the
    // taskId, which became a phishing/spam vector via the file:uploaded
    // socket emit and a way to inject content into private boards.
    const uploaderHasAccess = await canAccessTask(taskId, req.user);
    if (!uploaderHasAccess) {
      cleanupOnError(req.file);
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this task.',
      });
    }

    // Store through provider. Two-phase: file lands in storage, then we
    // record the metadata in DB. If the DB insert fails the file would be
    // orphaned forever (no row → admin can't see it → can't garbage-collect).
    // Cleanup-on-fail keeps storage and DB consistent without needing a
    // distributed transaction across two systems (local FS / S3 vs Postgres).
    const { url, provider } = await storeFile({
      filePath: req.file.path,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      category,
    });

    let attachment;
    try {
      attachment = await FileAttachment.create({
        filename: req.file.filename,
        originalName: sanitizeOriginalName(req.file.originalname),
        mimetype: req.file.mimetype,
        size: req.file.size,
        url,
        provider,
        category,
        taskId,
        uploadedBy: req.user.id,
      });
    } catch (dbErr) {
      // DB insert failed AFTER the file was stored. Remove the orphan from
      // storage so we don't leak. deleteFile is idempotent (no-throw on
      // missing) per the storage providers we ship today, and we wrap it in
      // try/catch anyway so a cleanup failure surfaces the original DB
      // error rather than masking it.
      try {
        await deleteFile(req.file.filename, category);
      } catch (cleanupErr) {
        console.error('[File] Failed to clean up orphaned upload after DB error:', cleanupErr && cleanupErr.message);
      }
      throw dbErr;
    }

    const fullAttachment = await FileAttachment.findByPk(attachment.id, {
      include: [
        { model: User, as: 'uploader', attributes: ['id', 'name', 'email', 'avatar'] },
      ],
    });

    // CP-3 RBAC: emit only to authorized recipients of the parent task.
    const recipients = await taskVisibility.getAuthorizedRealtimeRecipients(task);
    emitToUsers('file:uploaded', { file: fullAttachment, taskId }, recipients);

    res.status(201).json({
      success: true,
      message: 'File uploaded successfully.',
      data: { file: fullAttachment },
    });
  } catch (error) {
    console.error('[File] Upload error:', error);
    cleanupOnError(req.file);
    res.status(500).json({ success: false, message: 'Server error uploading file.' });
  }
};

/**
 * GET /api/files?taskId=<uuid>
 */
const getFiles = async (req, res) => {
  try {
    const { taskId } = req.query;

    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId query parameter is required.' });
    }

    const hasAccess = await canAccessTask(taskId, req.user);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'You do not have access to this task.' });
    }

    const files = await FileAttachment.findAll({
      where: { taskId },
      include: [
        { model: User, as: 'uploader', attributes: ['id', 'name', 'email', 'avatar'] },
      ],
      order: [['createdAt', 'DESC']],
    });

    res.json({ success: true, data: { files } });
  } catch (error) {
    console.error('[File] GetFiles error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching files.' });
  }
};

/**
 * DELETE /api/files/:id
 */
const deleteFileHandler = async (req, res) => {
  try {
    const attachment = await FileAttachment.findByPk(req.params.id, {
      include: [{ model: Task, as: 'task', attributes: ['id', 'boardId'] }],
    });

    if (!attachment) {
      return res.status(404).json({ success: false, message: 'File not found.' });
    }

    // Only the uploader or an admin may delete
    if (attachment.uploadedBy !== req.user.id && !['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete files you uploaded.',
      });
    }

    // Phase 5d — destructive-action gate. T2 always blocked (decision #4),
    // T1 always allowed, T3/T4 allowed only when they are the uploader.
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      const isOwnResource = attachment.uploadedBy === req.user.id;
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'file', { isOwnResource }))) return;
    }

    // Remove through storage provider
    await deleteFile(attachment.filename, attachment.category);

    const taskId = attachment.taskId;
    // `attachment.task` is loaded via include above, but the row CAN be null
    // if the parent task was hard-deleted (FK on FileAttachment.taskId is
    // ON DELETE SET NULL) or if the file was uploaded with no task. Reading
    // .boardId on null threw a TypeError → 500. We only need boardId for
    // diagnostic logging anyway; emitToUsers takes the per-user list.
    const boardId = attachment.task ? attachment.task.boardId : null;
    const fileId = attachment.id;

    await attachment.destroy();

    // CP-3 RBAC: same recipient rule as upload. If the parent task is gone
    // (orphan attachment), there is no audience to notify — skip the emit
    // rather than letting getAuthorizedRealtimeRecipients(null) crash.
    if (taskId) {
      try {
        const recipients = await taskVisibility.getAuthorizedRealtimeRecipients(taskId);
        emitToUsers('file:deleted', { fileId, taskId, boardId }, recipients);
      } catch (emitErr) {
        // Realtime is best-effort. Don't fail the API just because the
        // socket fan-out couldn't compute its audience.
        console.warn('[File] Delete emit failed (non-fatal):', emitErr && emitErr.message);
      }
    }

    res.json({ success: true, message: 'File deleted successfully.' });
  } catch (error) {
    console.error('[File] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting file.' });
  }
};

/**
 * GET /api/files/:id/download
 */
const downloadFile = async (req, res) => {
  try {
    const attachment = await FileAttachment.findByPk(req.params.id);

    if (!attachment) {
      return res.status(404).json({ success: false, message: 'File not found.' });
    }

    const hasAccess = await canAccessTask(attachment.taskId, req.user);
    if (!hasAccess) {
      return res.status(403).json({ success: false, message: 'You do not have access to this file.' });
    }

    const filePath = await resolveFile(attachment.filename, attachment.category);

    if (!filePath || !(await fileExists(attachment.filename, attachment.category))) {
      return res.status(404).json({ success: false, message: 'File not found on storage.' });
    }

    res.download(filePath, sanitizeOriginalName(attachment.originalName));
  } catch (error) {
    console.error('[File] Download error:', error);
    res.status(500).json({ success: false, message: 'Server error downloading file.' });
  }
};

/**
 * POST /api/files/upload-general
 * General-purpose upload not tied to a task.
 */
const uploadGeneral = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const category = req._uploadCategory || 'general';

    const { url, provider } = await storeFile({
      filePath: req.file.path,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      category,
    });

    const meta = normalizeMetadata(req.file, category);

    res.json({
      success: true,
      data: {
        url,
        filename: req.file.filename,
        originalName: sanitizeOriginalName(req.file.originalname),
        size: req.file.size,
        mimetype: req.file.mimetype,
        provider,
        category,
      },
    });
  } catch (error) {
    console.error('[File] General upload error:', error);
    cleanupOnError(req.file);
    res.status(500).json({ success: false, message: 'Server error uploading file.' });
  }
};

module.exports = { uploadFile, uploadGeneral, getFiles, deleteFile: deleteFileHandler, downloadFile };
