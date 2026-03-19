const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  getAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} = require('../controllers/announcementController');

const router = express.Router();

router.get('/', authenticate, getAnnouncements);
router.post('/', authenticate, managerOrAdmin, createAnnouncement);
router.put('/:id', authenticate, managerOrAdmin, updateAnnouncement);
router.delete('/:id', authenticate, managerOrAdmin, deleteAnnouncement);

module.exports = router;
