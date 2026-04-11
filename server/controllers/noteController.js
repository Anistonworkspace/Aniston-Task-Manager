const { Note, User } = require('../models');
const { sanitizeInput } = require('../utils/sanitize');

// GET /api/notes/my — get current user's notes
exports.getMyNotes = async (req, res) => {
  // Try with all columns first; if lang column doesn't exist, fall back to core columns
  const coreAttrs = ['id', 'title', 'content', 'duration', 'type', 'userId', 'createdAt', 'updatedAt'];

  try {
    const notes = await Note.findAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { notes } });
  } catch (err) {
    console.error('[NoteController] getMyNotes error:', err.message);
    // Retry with explicit core attributes (excludes lang which may not exist)
    try {
      const notes = await Note.findAll({
        where: { userId: req.user.id },
        attributes: coreAttrs,
        order: [['createdAt', 'DESC']],
      });
      return res.json({ success: true, data: { notes } });
    } catch (retryErr) {
      console.error('[NoteController] getMyNotes retry also failed:', retryErr.message);
    }
    res.status(500).json({ success: false, message: 'Failed to fetch notes.' });
  }
};

// POST /api/notes — create note
exports.createNote = async (req, res) => {
  try {
    let { title, content, duration, type, lang } = req.body;

    // Auto-generate title from content if not provided
    if (!title || !title.trim()) {
      if (content && content.trim()) {
        title = content.trim().length > 60
          ? content.trim().substring(0, 60) + '...'
          : content.trim();
      } else {
        return res.status(400).json({ success: false, message: 'Title or content is required.' });
      }
    }

    const noteData = {
      title: sanitizeInput(title.trim()),
      content: sanitizeInput(content) || '',
      duration: duration || 0,
      type: type || 'voice_note',
      userId: req.user.id,
    };

    // Include lang if provided
    if (lang) noteData.lang = lang;

    // Use explicit fields list so Sequelize doesn't auto-include lang
    // if the column doesn't exist in the DB yet
    const createFields = ['id', 'title', 'content', 'duration', 'type', 'userId'];
    if (lang) createFields.push('lang');

    const note = await Note.create(noteData, { fields: createFields });

    res.status(201).json({ success: true, data: { note } });
  } catch (err) {
    console.error('[NoteController] createNote error:', err.message);
    // If the error is about the lang column not existing, try without it
    if (err.message && err.message.includes('lang')) {
      try {
        let { title, content, duration, type } = req.body;
        if (!title || !title.trim()) {
          title = (content || '').trim().substring(0, 60) || 'Untitled Note';
        }
        const note = await Note.create({
          title: sanitizeInput(title.trim()),
          content: sanitizeInput(content) || '',
          duration: duration || 0,
          type: type || 'voice_note',
          userId: req.user.id,
        }, {
          fields: ['id', 'title', 'content', 'duration', 'type', 'userId'],
        });
        return res.status(201).json({ success: true, data: { note } });
      } catch (retryErr) {
        console.error('[NoteController] createNote retry error:', retryErr.message);
      }
    }
    res.status(500).json({ success: false, message: 'Failed to create note: ' + (err.message || 'Unknown error') });
  }
};

// PUT /api/notes/:id — update note (only owner)
exports.updateNote = async (req, res) => {
  const coreAttrs = ['id', 'title', 'content', 'duration', 'type', 'userId', 'createdAt', 'updatedAt'];

  try {
    // Try full fetch first, fall back to core attrs if lang column missing
    let note;
    try {
      note = await Note.findByPk(req.params.id);
    } catch (fetchErr) {
      note = await Note.findByPk(req.params.id, { attributes: coreAttrs });
    }
    if (!note) return res.status(404).json({ success: false, message: 'Note not found.' });
    if (note.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    const { title, content, duration, type, lang } = req.body;
    if (title !== undefined) note.title = sanitizeInput(title);
    if (content !== undefined) note.content = sanitizeInput(content);
    if (duration !== undefined) note.duration = duration;
    if (type !== undefined) note.type = type;
    if (lang !== undefined) note.lang = lang;

    await note.save();
    res.json({ success: true, data: { note } });
  } catch (err) {
    console.error('[NoteController] updateNote error:', err.message);
    // Retry without lang if that's the problematic column
    if (err.message && err.message.includes('lang')) {
      try {
        const { title, content, duration, type } = req.body;
        const updateFields = {};
        if (title !== undefined) updateFields.title = sanitizeInput(title);
        if (content !== undefined) updateFields.content = sanitizeInput(content);
        if (duration !== undefined) updateFields.duration = duration;
        if (type !== undefined) updateFields.type = type;
        await Note.update(updateFields, { where: { id: req.params.id } });
        const updated = await Note.findByPk(req.params.id, { attributes: coreAttrs });
        return res.json({ success: true, data: { note: updated } });
      } catch (retryErr) {
        console.error('[NoteController] updateNote retry error:', retryErr.message);
      }
    }
    res.status(500).json({ success: false, message: 'Failed to update note.' });
  }
};

// DELETE /api/notes/:id — delete note (only owner)
exports.deleteNote = async (req, res) => {
  const coreAttrs = ['id', 'title', 'userId'];
  try {
    let note;
    try {
      note = await Note.findByPk(req.params.id);
    } catch (_) {
      note = await Note.findByPk(req.params.id, { attributes: coreAttrs });
    }
    if (!note) return res.status(404).json({ success: false, message: 'Note not found.' });
    if (note.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    await note.destroy();
    res.json({ success: true, message: 'Note deleted.' });
  } catch (err) {
    console.error('[NoteController] deleteNote error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete note.' });
  }
};
