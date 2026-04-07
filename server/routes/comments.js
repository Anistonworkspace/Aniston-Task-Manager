const express = require('express');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const {
  addComment,
  getComments,
  deleteComment,
} = require('../controllers/commentController');

const router = express.Router();

// All comment routes require authentication
router.use(authenticate);

// ─── POST /api/comments ──────────────────────────────────────
router.post(
  '/',
  [
    body('content')
      .trim()
      .notEmpty().withMessage('Comment content is required'),
    body('taskId')
      .notEmpty().withMessage('taskId is required')
      .isUUID().withMessage('taskId must be a valid UUID'),
  ],
  addComment
);

// ─── GET /api/comments?taskId=<uuid> ─────────────────────────
router.get('/', getComments);

// ─── DELETE /api/comments/:id ────────────────────────────────
router.delete('/:id', deleteComment);

module.exports = router;
