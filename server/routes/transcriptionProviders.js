const express = require('express');
const router = express.Router();
const { authenticate, strictAdminOnly } = require('../middleware/auth');
const {
  getProviders, createProvider, updateProvider, deleteProvider,
  setDefaultProvider, toggleProvider, testProvider, testConfig,
} = require('../controllers/transcriptionProviderController');

router.use(authenticate);

router.get('/providers', getProviders);
router.post('/providers', strictAdminOnly, createProvider);
router.put('/providers/:id', strictAdminOnly, updateProvider);
router.delete('/providers/:id', strictAdminOnly, deleteProvider);
router.post('/providers/:id/set-default', strictAdminOnly, setDefaultProvider);
router.post('/providers/:id/toggle', strictAdminOnly, toggleProvider);
router.post('/providers/:id/test', strictAdminOnly, testProvider);
router.post('/test', strictAdminOnly, testConfig);

module.exports = router;
