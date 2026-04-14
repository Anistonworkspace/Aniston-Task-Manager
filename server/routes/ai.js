const express = require('express');
const router = express.Router();
const { authenticate, strictAdminOnly } = require('../middleware/auth');
const {
  getConfig, saveConfig, testConfig, deleteConfig,
  getProviders, createProvider, updateProvider, deleteProvider,
  setDefaultProvider, toggleProvider, testProvider,
  chatWithAI, checkGrammar,
} = require('../controllers/aiController');

// All routes require authentication
router.use(authenticate);

// ─── Legacy single-config endpoints (backward compat) ───────
router.get('/config', getConfig);
router.post('/config', strictAdminOnly, saveConfig);
router.post('/test', strictAdminOnly, testConfig);
router.delete('/config', strictAdminOnly, deleteConfig);

// ─── Multi-provider CRUD endpoints ──────────────────────────
router.get('/providers', getProviders);
router.post('/providers', strictAdminOnly, createProvider);
router.put('/providers/:id', strictAdminOnly, updateProvider);
router.delete('/providers/:id', strictAdminOnly, deleteProvider);
router.post('/providers/:id/set-default', strictAdminOnly, setDefaultProvider);
router.post('/providers/:id/toggle', strictAdminOnly, toggleProvider);
router.post('/providers/:id/test', strictAdminOnly, testProvider);

// ─── Chat & Grammar (all authenticated users) ──────────────
router.post('/chat', chatWithAI);
router.post('/grammar', checkGrammar);

module.exports = router;
