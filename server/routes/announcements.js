const express = require('express');
const { body } = require('express-validator');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} = require('../controllers/announcementController');

const router = express.Router();

// Validator chain. The announcement controller does not currently consume
// validationResult, so these checks are defence-in-depth scaffolding.
const announcementValidators = [
  body('title').isString().trim().isLength({ min: 1, max: 200 }).withMessage('title is required (1-200 chars)'),
  body('content').isString().isLength({ max: 5000 }).withMessage('content must be ≤5000 chars'),
  body('type').optional().isIn(['info', 'warning', 'success', 'urgent']).withMessage('type must be info|warning|success|urgent'),
];

router.get('/', authenticate, getAnnouncements);
router.post('/', authenticate, managerOrAdmin, announcementValidators, createAnnouncement);
router.put('/:id', authenticate, managerOrAdmin, announcementValidators, updateAnnouncement);
router.delete('/:id', authenticate, managerOrAdmin, deleteAnnouncement);

module.exports = router;
