const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  getMyNotes,
  createNote,
  updateNote,
  deleteNote,
} = require('../controllers/noteController');

const router = express.Router();

router.get('/my', authenticate, getMyNotes);
router.post('/', authenticate, createNote);
router.put('/:id', authenticate, updateNote);
router.delete('/:id', authenticate, deleteNote);

module.exports = router;
