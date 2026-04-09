const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
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
router.post('/config', adminOnly, saveConfig);
router.post('/test', adminOnly, testConfig);
router.delete('/config', adminOnly, deleteConfig);

// ─── Multi-provider CRUD endpoints ──────────────────────────
router.get('/providers', getProviders);
router.post('/providers', adminOnly, createProvider);
router.put('/providers/:id', adminOnly, updateProvider);
router.delete('/providers/:id', adminOnly, deleteProvider);
router.post('/providers/:id/set-default', adminOnly, setDefaultProvider);
router.post('/providers/:id/toggle', adminOnly, toggleProvider);
router.post('/providers/:id/test', adminOnly, testProvider);

// ─── Chat & Grammar (all authenticated users) ──────────────
router.post('/chat', chatWithAI);
router.post('/grammar', checkGrammar);

module.exports = router;
