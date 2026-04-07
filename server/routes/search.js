const express = require('express');
const { authenticate } = require('../middleware/auth');
const { globalSearch } = require('../controllers/searchController');

const router = express.Router();

router.use(authenticate);

router.get('/', globalSearch);

module.exports = router;
