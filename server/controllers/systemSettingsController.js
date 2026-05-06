const { SystemSetting } = require('../models');
const activityService = require('../services/activityService');

const SESSION_TIMEOUT_KEY = 'inactivity_timeout_minutes';
const DEFAULT_MINUTES = 5;
const MIN_MINUTES = 5;
const MAX_MINUTES = 1440; // 24 hours

const readMinutes = (setting) => {
  const raw = setting?.value?.minutes;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_MINUTES || n > MAX_MINUTES) return DEFAULT_MINUTES;
  return Math.round(n);
};

const getSessionTimeout = async (req, res) => {
  try {
    const setting = await SystemSetting.findOne({ where: { key: SESSION_TIMEOUT_KEY } });
    const minutes = readMinutes(setting);
    return res.status(200).json({
      success: true,
      data: {
        inactivityTimeoutMinutes: minutes,
        minMinutes: MIN_MINUTES,
        maxMinutes: MAX_MINUTES,
      },
    });
  } catch (error) {
    console.error('getSessionTimeout error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

const updateSessionTimeout = async (req, res) => {
  try {
    const raw = req.body?.inactivityTimeoutMinutes;
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
      return res.status(400).json({
        success: false,
        message: `inactivityTimeoutMinutes must be an integer between ${MIN_MINUTES} and ${MAX_MINUTES}.`,
      });
    }

    const [setting, created] = await SystemSetting.findOrCreate({
      where: { key: SESSION_TIMEOUT_KEY },
      defaults: {
        key: SESSION_TIMEOUT_KEY,
        value: { minutes },
        description: 'Auto-logout duration after user inactivity (minutes).',
        updatedBy: req.user.id,
      },
    });

    if (!created) {
      setting.value = { minutes };
      setting.updatedBy = req.user.id;
      await setting.save();
    }

    activityService.logActivity({
      action: 'updated',
      description: `Updated inactivity auto-logout timeout to ${minutes} minutes`,
      entityType: 'system_setting',
      entityId: setting.id,
      userId: req.user.id,
    });

    return res.status(200).json({
      success: true,
      data: {
        inactivityTimeoutMinutes: minutes,
        minMinutes: MIN_MINUTES,
        maxMinutes: MAX_MINUTES,
      },
    });
  } catch (error) {
    console.error('updateSessionTimeout error:', error);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

module.exports = {
  getSessionTimeout,
  updateSessionTimeout,
  SESSION_TIMEOUT_KEY,
  DEFAULT_MINUTES,
  MIN_MINUTES,
  MAX_MINUTES,
};
