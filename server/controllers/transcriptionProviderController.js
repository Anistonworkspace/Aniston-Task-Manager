const xss = require('xss');
const { TranscriptionProvider, User } = require('../models');
const { encrypt, decrypt, maskSecret } = require('../utils/encryption');
const { logActivity } = require('../services/activityService');
const { testProviderConnection } = require('../services/transcriptionService');

const VALID_TYPES = ['deepgram', 'custom'];

function publicFields(p, unmaskedKey) {
  let maskedKey = '';
  try {
    maskedKey = unmaskedKey ? maskSecret(unmaskedKey) : maskSecret(decrypt(p.apiKey));
  } catch { maskedKey = '(encrypted)'; }
  return {
    id: p.id,
    name: p.name,
    providerType: p.providerType,
    apiKey: maskedKey,
    hasKey: true,
    model: p.model,
    language: p.language,
    baseUrl: p.baseUrl,
    diarizationEnabled: p.diarizationEnabled,
    isActive: p.isActive,
    isDefault: p.isDefault,
    lastTestedAt: p.lastTestedAt,
    configuredBy: p.configuredBy,
    configurer: p.configurer,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

async function getProviders(_req, res) {
  try {
    const providers = await TranscriptionProvider.findAll({
      include: [{ model: User, as: 'configurer', attributes: ['id', 'name', 'email'] }],
      order: [['isDefault', 'DESC'], ['createdAt', 'ASC']],
    });
    res.json({ success: true, data: providers.map(p => publicFields(p)) });
  } catch (error) {
    console.error('[TranscriptionProviderController] getProviders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transcription providers.' });
  }
}

async function createProvider(req, res) {
  try {
    const {
      name, providerType, apiKey, model, language, baseUrl, diarizationEnabled,
    } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'Name is required.' });
    if (!providerType) return res.status(400).json({ success: false, message: 'Provider type is required.' });
    if (!VALID_TYPES.includes(providerType)) {
      return res.status(400).json({ success: false, message: `Invalid provider type. Use: ${VALID_TYPES.join(', ')}` });
    }
    if (!apiKey) return res.status(400).json({ success: false, message: 'API key is required.' });

    const existingCount = await TranscriptionProvider.count();
    const newProvider = await TranscriptionProvider.create({
      name: xss(name.trim()),
      providerType,
      apiKey: encrypt(apiKey),
      model: xss(model || 'nova-3'),
      language: xss(language || 'en-US'),
      baseUrl: xss(baseUrl || ''),
      diarizationEnabled: diarizationEnabled !== false,
      isActive: true,
      isDefault: existingCount === 0,
      configuredBy: req.user.id,
    });

    logActivity({
      action: 'transcription_provider_created',
      description: `Transcription provider added: ${newProvider.name} (${newProvider.providerType})`,
      entityType: 'transcription_provider',
      entityId: newProvider.id,
      userId: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: `${newProvider.name} provider added successfully.`,
      data: publicFields(newProvider, apiKey),
    });
  } catch (error) {
    console.error('[TranscriptionProviderController] createProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to create transcription provider.' });
  }
}

async function updateProvider(req, res) {
  try {
    const { id } = req.params;
    const {
      name, providerType, apiKey, model, language, baseUrl, diarizationEnabled, isActive,
    } = req.body;

    const existing = await TranscriptionProvider.findByPk(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Transcription provider not found.' });

    if (providerType !== undefined && !VALID_TYPES.includes(providerType)) {
      return res.status(400).json({ success: false, message: `Invalid provider type. Use: ${VALID_TYPES.join(', ')}` });
    }

    const updates = {};
    if (name !== undefined) updates.name = xss(name.trim());
    if (providerType !== undefined) updates.providerType = providerType;
    if (model !== undefined) updates.model = xss(model);
    if (language !== undefined) updates.language = xss(language);
    if (baseUrl !== undefined) updates.baseUrl = xss(baseUrl);
    if (diarizationEnabled !== undefined) updates.diarizationEnabled = !!diarizationEnabled;
    if (isActive !== undefined) updates.isActive = !!isActive;
    if (apiKey) updates.apiKey = encrypt(apiKey);

    await existing.update(updates);

    logActivity({
      action: 'transcription_provider_updated',
      description: `Transcription provider updated: ${existing.name}`,
      entityType: 'transcription_provider',
      entityId: existing.id,
      userId: req.user.id,
    });

    res.json({
      success: true,
      message: 'Transcription provider updated successfully.',
      data: publicFields(existing, apiKey || null),
    });
  } catch (error) {
    console.error('[TranscriptionProviderController] updateProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to update transcription provider.' });
  }
}

async function deleteProvider(req, res) {
  try {
    const { id } = req.params;
    const existing = await TranscriptionProvider.findByPk(id);
    if (!existing) return res.status(404).json({ success: false, message: 'Transcription provider not found.' });

    const wasDefault = existing.isDefault;
    const providerName = existing.name;
    await existing.destroy();

    if (wasDefault) {
      const next = await TranscriptionProvider.findOne({ where: { isActive: true }, order: [['createdAt', 'ASC']] });
      if (next) await next.update({ isDefault: true });
    }

    logActivity({
      action: 'transcription_provider_deleted',
      description: `Transcription provider removed: ${providerName}`,
      entityType: 'transcription_provider',
      entityId: id,
      userId: req.user.id,
    });

    res.json({ success: true, message: `${providerName} provider removed.` });
  } catch (error) {
    console.error('[TranscriptionProviderController] deleteProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove transcription provider.' });
  }
}

async function setDefaultProvider(req, res) {
  try {
    const { id } = req.params;
    const provider = await TranscriptionProvider.findByPk(id);
    if (!provider) return res.status(404).json({ success: false, message: 'Transcription provider not found.' });

    await TranscriptionProvider.update({ isDefault: false }, { where: {} });
    await provider.update({ isDefault: true, isActive: true });

    res.json({ success: true, message: `${provider.name} set as default transcription provider.` });
  } catch (error) {
    console.error('[TranscriptionProviderController] setDefaultProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to set default transcription provider.' });
  }
}

async function toggleProvider(req, res) {
  try {
    const { id } = req.params;
    const provider = await TranscriptionProvider.findByPk(id);
    if (!provider) return res.status(404).json({ success: false, message: 'Transcription provider not found.' });

    await provider.update({ isActive: !provider.isActive });
    res.json({
      success: true,
      message: `${provider.name} ${provider.isActive ? 'activated' : 'deactivated'}.`,
      data: { isActive: provider.isActive },
    });
  } catch (error) {
    console.error('[TranscriptionProviderController] toggleProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle transcription provider.' });
  }
}

async function testProvider(req, res) {
  try {
    const { id } = req.params;
    const { apiKey: newApiKey } = req.body;
    const provider = await TranscriptionProvider.findByPk(id);
    if (!provider) return res.status(404).json({ success: false, message: 'Transcription provider not found.' });

    let apiKey;
    if (newApiKey) apiKey = newApiKey;
    else {
      try { apiKey = decrypt(provider.apiKey); }
      catch { return res.status(400).json({ success: false, message: 'Could not decrypt stored API key.' }); }
    }

    const result = await testProviderConnection(provider.providerType, apiKey, provider.baseUrl);
    if (result.success) await provider.update({ lastTestedAt: new Date() });

    const keySuffix = apiKey ? '...' + apiKey.slice(-4) : '(none)';
    res.json({
      ...result,
      data: {
        ...(result.data || {}),
        diagnostics: {
          providerType: provider.providerType,
          model: provider.model,
          keySuffix,
          httpStatus: result.httpStatus,
          failureType: result.failureType,
        },
      },
    });
  } catch (error) {
    console.error('[TranscriptionProviderController] testProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to test transcription provider.' });
  }
}

async function testConfig(req, res) {
  try {
    const { providerType, apiKey, baseUrl } = req.body;
    if (!providerType || !apiKey) {
      return res.status(400).json({ success: false, message: 'Provider type and API key are required to test.' });
    }
    if (!VALID_TYPES.includes(providerType)) {
      return res.status(400).json({ success: false, message: `Invalid provider type. Use: ${VALID_TYPES.join(', ')}` });
    }
    const result = await testProviderConnection(providerType, apiKey, baseUrl);
    const keySuffix = apiKey ? '...' + apiKey.slice(-4) : '(none)';
    res.json({
      ...result,
      data: {
        ...(result.data || {}),
        diagnostics: { providerType, keySuffix, httpStatus: result.httpStatus, failureType: result.failureType },
      },
    });
  } catch (error) {
    console.error('[TranscriptionProviderController] testConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to test transcription provider.' });
  }
}

module.exports = {
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  setDefaultProvider,
  toggleProvider,
  testProvider,
  testConfig,
};
