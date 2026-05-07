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

    // Store through provider
    const { url, provider } = await storeFile({
      filePath: req.file.path,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      category,
    });

    const attachment = await FileAttachment.create({
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
    const boardId = attachment.task.boardId;
    const fileId = attachment.id;

    await attachment.destroy();

    // CP-3 RBAC: same recipient rule as upload.
    const recipients = await taskVisibility.getAuthorizedRealtimeRecipients(taskId);
    emitToUsers('file:deleted', { fileId, taskId }, recipients);

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
