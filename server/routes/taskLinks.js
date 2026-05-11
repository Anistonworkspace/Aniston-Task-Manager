const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  listLinks, createLink, updateLink, deleteLink,
} = require('../controllers/taskLinkController');

const router = express.Router();

router.get('/task/:taskId', authenticate, listLinks);
router.post('/', authenticate, createLink);
router.put('/:id', authenticate, updateLink);
router.delete('/:id', authenticate, deleteLink);

module.exports = router;
