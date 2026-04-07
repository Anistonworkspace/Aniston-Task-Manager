const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getWeeklyReview, downloadPDF, downloadCSV } = require('../controllers/reviewController');

const router = express.Router();

router.use(authenticate);

router.get('/weekly', getWeeklyReview);
router.get('/weekly/pdf', downloadPDF);
router.get('/weekly/csv', downloadCSV);

module.exports = router;
