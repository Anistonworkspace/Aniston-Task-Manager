const express = require('express');
const { authenticate, strictAdminOnly } = require('../middleware/auth');
const {
  getConfig,
  saveConfig,
  deleteConfig,
  testConnection,
} = require('../controllers/integrationConfigController');

const router = express.Router();

// All routes require admin authentication
router.get('/config/:provider', authenticate, strictAdminOnly, getConfig);
router.post('/config/:provider', authenticate, strictAdminOnly, saveConfig);
router.delete('/config/:provider', authenticate, strictAdminOnly, deleteConfig);
router.get('/config/:provider/test', authenticate, strictAdminOnly, testConnection);

module.exports = router;
