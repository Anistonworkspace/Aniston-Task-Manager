const crypto = require('crypto');
const { ApiKey, User } = require('../models');
const { Op } = require('sequelize');

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ─── POST /api/api-keys — Generate a new API key ─────────────
const generateKey = async (req, res) => {
  try {
    const { name, expiresAt } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Key name is required.' });
    }

    // Validate expiry date if provided
    if (expiresAt) {
      const expDate = new Date(expiresAt);
      if (isNaN(expDate.getTime()) || expDate <= new Date()) {
        return res.status(400).json({ success: false, message: 'Expiry date must be a valid future date.' });
      }
    }

    // Generate a secure random key
    const rawKey = 'ak_' + crypto.randomBytes(32).toString('hex');
    const keyHashed = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 11); // "ak_" + first 8 hex chars

    const apiKey = await ApiKey.create({
      name: name.trim(),
      keyHash: keyHashed,
      keyPrefix,
      expiresAt: expiresAt || null,
      createdBy: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: 'API key created. Copy it now — it won\'t be shown again.',
      data: {
        id: apiKey.id,
        name: apiKey.name,
        key: rawKey, // Only returned once at creation
        keyPrefix: apiKey.keyPrefix,
        expiresAt: apiKey.expiresAt,
        createdAt: apiKey.createdAt,
      },
    });
  } catch (error) {
    console.error('[ApiKey] generateKey error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate API key.' });
  }
};

// ─── GET /api/api-keys — List all API keys ───────────────────
const listKeys = async (req, res) => {
  try {
    const keys = await ApiKey.findAll({
      include: [{ model: User, as: 'creator', attributes: ['id', 'name', 'email'] }],
      order: [['createdAt', 'DESC']],
    });

    const now = new Date();
    const data = keys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      expiresAt: k.expiresAt,
      isExpired: k.expiresAt ? new Date(k.expiresAt) <= now : false,
      isActive: k.isActive,
      lastUsedAt: k.lastUsedAt,
      createdBy: k.creator ? { id: k.creator.id, name: k.creator.name, email: k.creator.email } : null,
      createdAt: k.createdAt,
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('[ApiKey] listKeys error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch API keys.' });
  }
};

// ─── DELETE /api/api-keys/:id — Revoke an API key ────────────
const revokeKey = async (req, res) => {
  try {
    const { id } = req.params;
    const key = await ApiKey.findByPk(id);

    if (!key) {
      return res.status(404).json({ success: false, message: 'API key not found.' });
    }

    await key.destroy();
    res.json({ success: true, message: 'API key revoked successfully.' });
  } catch (error) {
    console.error('[ApiKey] revokeKey error:', error);
    res.status(500).json({ success: false, message: 'Failed to revoke API key.' });
  }
};

// ─── PATCH /api/api-keys/:id/toggle — Enable/disable key ────
const toggleKey = async (req, res) => {
  try {
    const { id } = req.params;
    const key = await ApiKey.findByPk(id);

    if (!key) {
      return res.status(404).json({ success: false, message: 'API key not found.' });
    }

    key.isActive = !key.isActive;
    await key.save();

    res.json({
      success: true,
      message: `API key ${key.isActive ? 'enabled' : 'disabled'}.`,
      data: { id: key.id, isActive: key.isActive },
    });
  } catch (error) {
    console.error('[ApiKey] toggleKey error:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle API key.' });
  }
};

module.exports = { generateKey, listKeys, revokeKey, toggleKey };