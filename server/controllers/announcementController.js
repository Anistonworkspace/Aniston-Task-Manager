const { Announcement, User, Workspace } = require('../models');
const { sanitizeInput } = require('../utils/sanitize');

// S-H6 — Workspace access check. Admin / super admin pass unconditionally;
// everyone else must be the creator OR a member (workspaceMembers junction
// or User.workspaceId). Mirrors the broader pattern in
// boardController.canUserCreateInWorkspace but kept narrow here to avoid
// hierarchy walks for a content-CRUD path.
async function canUseWorkspace(user, workspaceId) {
  if (!user || !workspaceId) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin') return true;
  try {
    const ws = await Workspace.findByPk(workspaceId, {
      include: [{ model: User, as: 'workspaceMembers', attributes: ['id'] }],
    });
    if (!ws) return false;
    if (ws.createdBy === user.id) return true;
    if (Array.isArray(ws.workspaceMembers)
        && ws.workspaceMembers.some((m) => m.id === user.id)) {
      return true;
    }
    // Last resort: User.workspaceId direct pointer (default workspace).
    if (user.workspaceId && String(user.workspaceId) === String(workspaceId)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

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

    // S-H6 — if a workspaceId is supplied, verify the actor can use it.
    // Workspace-less (global) announcements are gated upstream by the
    // route-level role check.
    if (workspaceId) {
      const allowed = await canUseWorkspace(req.user, workspaceId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to post announcements in this workspace.',
        });
      }
    }

    const announcement = await Announcement.create({
      title: sanitizeInput(title),
      content: sanitizeInput(content) || '',
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

    // S-H6 — verify the actor can manage the workspace this announcement
    // lives in. A workspace-less (global) announcement falls through to the
    // route-level role gate.
    if (announcement.workspaceId) {
      const allowed = await canUseWorkspace(req.user, announcement.workspaceId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to manage announcements in this workspace.',
        });
      }
    }

    const { title, content, type, isPinned, isActive } = req.body;
    await announcement.update({
      ...(title !== undefined && { title: sanitizeInput(title) }),
      ...(content !== undefined && { content: sanitizeInput(content) }),
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

    // Phase 7 — Tier-2 destructive guard.
    const { assertCanDelete } = require('../services/tierEnforcement');
    const { sendIfTierError } = require('../utils/tierResponseHelpers');
    if (sendIfTierError(res, () => assertCanDelete(req.user, 'announcement', { isOwnResource: false }))) return;

    await announcement.destroy();
    res.json({ success: true, message: 'Announcement deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete announcement.' });
  }
};
