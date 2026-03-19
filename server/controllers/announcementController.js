const { Announcement, User, Workspace } = require('../models');

// GET /api/announcements
exports.getAnnouncements = async (req, res) => {
  try {
    const { workspaceId } = req.query;
    const where = { isActive: true };
    if (workspaceId) where.workspaceId = workspaceId;

    const announcements = await Announcement.findAll({
      where,
      include: [
        { model: User, as: 'author', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Workspace, as: 'workspace', attributes: ['id', 'name', 'color'] },
      ],
      order: [['isPinned', 'DESC'], ['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { announcements } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch announcements.' });
  }
};

// POST /api/announcements
exports.createAnnouncement = async (req, res) => {
  try {
    const { title, content, type, isPinned, workspaceId } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Title is required.' });

    const announcement = await Announcement.create({
      title,
      content: content || '',
      type: type || 'info',
      isPinned: isPinned || false,
      workspaceId: workspaceId || null,
      createdBy: req.user.id,
    });

    const full = await Announcement.findByPk(announcement.id, {
      include: [
        { model: User, as: 'author', attributes: ['id', 'name', 'email', 'avatar'] },
      ],
    });

    res.status(201).json({ success: true, data: { announcement: full } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create announcement.' });
  }
};

// PUT /api/announcements/:id
exports.updateAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findByPk(req.params.id);
    if (!announcement) return res.status(404).json({ success: false, message: 'Not found.' });

    const { title, content, type, isPinned, isActive } = req.body;
    await announcement.update({
      ...(title !== undefined && { title }),
      ...(content !== undefined && { content }),
      ...(type !== undefined && { type }),
      ...(isPinned !== undefined && { isPinned }),
      ...(isActive !== undefined && { isActive }),
    });

    res.json({ success: true, data: { announcement } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update announcement.' });
  }
};

// DELETE /api/announcements/:id
exports.deleteAnnouncement = async (req, res) => {
  try {
    const announcement = await Announcement.findByPk(req.params.id);
    if (!announcement) return res.status(404).json({ success: false, message: 'Not found.' });
    await announcement.destroy();
    res.json({ success: true, message: 'Announcement deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete announcement.' });
  }
};
