const express = require('express');
const router = express.Router();
const { authenticate, adminOnly } = require('../middleware/auth');
const { getConfig, saveConfig, testConfig, deleteConfig, chatWithAI, checkGrammar } = require('../controllers/aiController');

// All routes require authentication
router.use(authenticate);

// GET /api/ai/config — Get active AI config (masked key)
router.get('/config', getConfig);

// POST /api/ai/config — Save AI config (admin only)
router.post('/config', adminOnly, saveConfig);

// POST /api/ai/test — Test AI connection
router.post('/test', adminOnly, testConfig);

// DELETE /api/ai/config — Remove AI config (admin only)
router.delete('/config', adminOnly, deleteConfig);

// POST /api/ai/chat — Chat with AI assistant (all authenticated users)
router.post('/chat', chatWithAI);

// POST /api/ai/grammar — Grammar correction (all authenticated users)
router.post('/grammar', checkGrammar);

module.exports = router;
