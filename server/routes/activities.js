const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getActivities } = require('../controllers/activityController');

const router = express.Router();

router.use(authenticate);

// GET /api/activities?taskId=...&boardId=...&userId=...&limit=...&offset=...
router.get('/', getActivities);

module.exports = router;
