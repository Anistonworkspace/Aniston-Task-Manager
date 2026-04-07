const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getDirectors, getDailyPlan, saveDailyPlan, updateTask, updateNotes } = require('../controllers/directorPlanController');

const router = express.Router();

router.use(authenticate);

router.get('/directors', getDirectors);
router.get('/:date', getDailyPlan);
router.put('/:date', saveDailyPlan);
router.put('/:date/task', updateTask);
router.put('/:date/notes', updateNotes);

module.exports = router;
