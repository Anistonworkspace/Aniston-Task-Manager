const express = require('express');
const router = express.Router();
const { authenticate, strictAdminOnly } = require('../middleware/auth');
const { generateKey, listKeys, revokeKey, toggleKey } = require('../controllers/apiKeyController');

// All routes require admin authentication
router.use(authenticate, strictAdminOnly);

// POST   /api/api-keys          — Generate new key
router.post('/', generateKey);

// GET    /api/api-keys          — List all keys
router.get('/', listKeys);

// DELETE /api/api-keys/:id      — Revoke (delete) a key
router.delete('/:id', revokeKey);

// PATCH  /api/api-keys/:id/toggle — Enable/disable a key
router.patch('/:id/toggle', toggleKey);

module.exports = router;
