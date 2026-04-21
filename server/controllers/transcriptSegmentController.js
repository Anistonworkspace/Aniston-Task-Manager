const xss = require('xss');
const { Note, TranscriptSegment } = require('../models');

async function loadOwnedNote(req, res) {
  const { id } = req.params;
  const note = await Note.findByPk(id);
  if (!note) {
    res.status(404).json({ success: false, message: 'Note not found.' });
    return null;
  }
  if (note.userId !== req.user.id) {
    res.status(403).json({ success: false, message: 'You do not have access to this note.' });
    return null;
  }
  return note;
}

async function listSegments(req, res) {
  try {
    const note = await loadOwnedNote(req, res);
    if (!note) return;
    const segments = await TranscriptSegment.findAll({
      where: { noteId: note.id },
      order: [['startMs', 'ASC'], ['createdAt', 'ASC']],
    });
    res.json({ success: true, data: segments });
  } catch (error) {
    console.error('[TranscriptSegmentController] listSegments error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transcript segments.' });
  }
}

async function bulkCreateSegments(req, res) {
  try {
    const note = await loadOwnedNote(req, res);
    if (!note) return;
    const { segments, replace } = req.body;
    if (!Array.isArray(segments)) {
      return res.status(400).json({ success: false, message: 'segments must be an array.' });
    }
    if (replace === true) {
      await TranscriptSegment.destroy({ where: { noteId: note.id } });
    }
    const rows = segments
      .filter(s => s && typeof s.text === 'string' && s.text.trim())
      .map(s => ({
        noteId: note.id,
        speakerLabel: xss(String(s.speakerLabel || 'Speaker 0').slice(0, 50)),
        startMs: Number.isFinite(s.startMs) ? Math.max(0, Math.floor(s.startMs)) : 0,
        endMs: Number.isFinite(s.endMs) ? Math.max(0, Math.floor(s.endMs)) : 0,
        text: xss(String(s.text).slice(0, 10000)),
      }));
    if (rows.length === 0) return res.json({ success: true, data: [] });
    const created = await TranscriptSegment.bulkCreate(rows);
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    console.error('[TranscriptSegmentController] bulkCreateSegments error:', error);
    res.status(500).json({ success: false, message: 'Failed to save transcript segments.' });
  }
}

async function renameSpeaker(req, res) {
  try {
    const note = await loadOwnedNote(req, res);
    if (!note) return;
    const { from, to } = req.body;
    if (!from || !to || typeof from !== 'string' || typeof to !== 'string') {
      return res.status(400).json({ success: false, message: 'Both from and to labels are required.' });
    }
    const safeTo = xss(to.trim().slice(0, 50));
    if (!safeTo) return res.status(400).json({ success: false, message: 'Target label cannot be empty.' });
    const [count] = await TranscriptSegment.update(
      { speakerLabel: safeTo },
      { where: { noteId: note.id, speakerLabel: from } },
    );
    res.json({ success: true, message: `Renamed ${count} segment(s).`, data: { updated: count, from, to: safeTo } });
  } catch (error) {
    console.error('[TranscriptSegmentController] renameSpeaker error:', error);
    res.status(500).json({ success: false, message: 'Failed to rename speaker.' });
  }
}

module.exports = { listSegments, bulkCreateSegments, renameSpeaker };
