const express = require('express');
const { body } = require('express-validator');
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

// Validator chain. The note controller does not currently consume
// validationResult, so these checks are defence-in-depth scaffolding.
const noteValidators = [
  body('title').optional().isString().isLength({ max: 200 }).withMessage('title must be ≤200 chars'),
  body('content').optional().isString().isLength({ max: 50000 }).withMessage('content must be ≤50000 chars'),
];

router.get('/my', authenticate, getMyNotes);
router.post('/', authenticate, noteValidators, createNote);
router.put('/:id', authenticate, noteValidators, updateNote);
router.delete('/:id', authenticate, deleteNote);

// AI transcript processing
router.get('/process/types', authenticate, getProcessTypes);
router.post('/process', authenticate, processTranscript);

// Speaker-labeled transcript segments (meeting mode)
router.get('/:id/segments', authenticate, listSegments);
router.post('/:id/segments', authenticate, bulkCreateSegments);
router.patch(
  '/:id/segments/rename-speaker',
  authenticate,
  [ body('newName').isString().trim().isLength({ min: 1, max: 100 }).withMessage('newName is required (1-100 chars)') ],
  renameSpeaker
);

module.exports = router;
