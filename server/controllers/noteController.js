const { Note, User } = require('../models');
const { sanitizeInput } = require('../utils/sanitize');

// GET /api/notes/my — get current user's notes
exports.getMyNotes = async (req, res) => {
  try {
    const notes = await Note.findAll({
      where: { userId: req.user.id },
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { notes } });
  } catch (err) {
    console.error('[NoteController] getMyNotes error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch notes.' });
  }
};

// POST /api/notes — create note
exports.createNote = async (req, res) => {
  try {
    const { title, content, duration, type } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Title is required.' });
    }

    const note = await Note.create({
      title: sanitizeInput(title),
      content: sanitizeInput(content) || '',
      duration: duration || 0,
      type: type || 'voice_note',
      userId: req.user.id,
    });

    res.status(201).json({ success: true, data: { note } });
  } catch (err) {
    console.error('[NoteController] createNote error:', err);
    res.status(500).json({ success: false, message: 'Failed to create note.' });
  }
};

// PUT /api/notes/:id — update note (only owner)
exports.updateNote = async (req, res) => {
  try {
    const note = await Note.findByPk(req.params.id);
    if (!note) return res.status(404).json({ success: false, message: 'Note not found.' });
    if (note.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    const { title, content, duration, type } = req.body;
    if (title !== undefined) note.title = sanitizeInput(title);
    if (content !== undefined) note.content = sanitizeInput(content);
    if (duration !== undefined) note.duration = duration;
    if (type !== undefined) note.type = type;

    await note.save();
    res.json({ success: true, data: { note } });
  } catch (err) {
    console.error('[NoteController] updateNote error:', err);
    res.status(500).json({ success: false, message: 'Failed to update note.' });
  }
};

// DELETE /api/notes/:id — delete note (only owner)
exports.deleteNote = async (req, res) => {
  try {
    const note = await Note.findByPk(req.params.id);
    if (!note) return res.status(404).json({ success: false, message: 'Note not found.' });
    if (note.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    await note.destroy();
    res.json({ success: true, message: 'Note deleted.' });
  } catch (err) {
    console.error('[NoteController] deleteNote error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete note.' });
  }
};
