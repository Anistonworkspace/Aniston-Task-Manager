const { FileAttachment, Task, User, Board } = require('../models');
const { emitToBoard } = require('../services/socketService');
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
 * Check if user has access to a task (is assignee, creator, board member, or admin/manager)
 */
const canAccessTask = async (taskId, user) => {
  if (user.role === 'admin') return true;
  const task = await Task.findByPk(taskId, {
    include: [{ model: Board, as: 'board', attributes: ['id', 'createdBy'], include: [{ model: User, as: 'members', attributes: ['id'] }] }],
  });
  if (!task) return false;
  if (task.assignedTo === user.id || task.createdBy === user.id) return true;
  if (user.role === 'manager') return true;
  if (task.board?.members?.some(m => m.id === user.id)) return true;
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

    emitToBoard(task.boardId, 'file:uploaded', {
      file: fullAttachment,
      taskId,
    });

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

    // Remove through storage provider
    await deleteFile(attachment.filename, attachment.category);

    const taskId = attachment.taskId;
    const boardId = attachment.task.boardId;
    const fileId = attachment.id;

    await attachment.destroy();

    emitToBoard(boardId, 'file:deleted', { fileId, taskId });

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
