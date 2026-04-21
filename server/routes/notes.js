const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  getMyNotes,
  createNote,
  updateNote,
  deleteNote,
} = require('../controllers/noteController');
const {
  processTranscript,
  getProcessTypes,
} = require('../controllers/noteProcessController');
const {
  listSegments,
  bulkCreateSegments,
  renameSpeaker,
} = require('../controllers/transcriptSegmentController');

const router = express.Router();

router.get('/my', authenticate, getMyNotes);
router.post('/', authenticate, createNote);
router.put('/:id', authenticate, updateNote);
router.delete('/:id', authenticate, deleteNote);

// AI transcript processing
router.get('/process/types', authenticate, getProcessTypes);
router.post('/process', authenticate, processTranscript);

// Speaker-labeled transcript segments (meeting mode)
router.get('/:id/segments', authenticate, listSegments);
router.post('/:id/segments', authenticate, bulkCreateSegments);
router.patch('/:id/segments/rename-speaker', authenticate, renameSpeaker);

module.exports = router;
