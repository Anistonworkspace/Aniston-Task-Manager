const express = require('express');
const { authenticate, adminOnly } = require('../middleware/auth');
const {
  getConfig,
  saveConfig,
  deleteConfig,
  testConnection,
} = require('../controllers/integrationConfigController');

const router = express.Router();

// All routes require admin authentication
router.get('/config/:provider', authenticate, adminOnly, getConfig);
router.post('/config/:provider', authenticate, adminOnly, saveConfig);
router.delete('/config/:provider', authenticate, adminOnly, deleteConfig);
router.get('/config/:provider/test', authenticate, adminOnly, testConnection);

module.exports = router;
