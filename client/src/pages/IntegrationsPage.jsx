import React, { useState, useEffect } from 'react';
import {
  ExternalLink, Unplug, CheckCircle2, AlertCircle, RefreshCw, Calendar,
  Users, Download, Eye, EyeOff, ChevronDown, ChevronUp, Shield, Check, X,
  Settings, Save, TestTube2, Edit3, Trash2, ToggleLeft, ToggleRight,
  Lock, Key, Globe, Link2, Bot, Sparkles, Cpu, Zap, Copy, Plus, Clock,
  Database, Power, Clipboard, Bell,
} from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/common/Avatar';
import TranscriptionProviderSection from '../components/integrations/TranscriptionProviderSection';

function TeamsNotificationStats() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/teams/notification-stats')
      .then(res => setStats(res.data?.data || res.data))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden mb-6 p-5">
        <div className="flex items-center justify-center py-4">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary/20 border-t-primary" />
        </div>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden mb-6">
      <div className="flex items-center gap-4 p-5 border-b border-border">
        <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Bell size={20} className="text-primary" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-text-primary">Teams Chat Notifications</h3>
          <p className="text-xs text-text-tertiary">Personal chat notifications sent to users via Microsoft Graph API</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full border ${stats.authenticated ? 'bg-success/10 text-success border-success/20' : 'bg-warning/10 text-warning border-warning/20'}`}>
          {stats.authenticated ? <><CheckCircle2 size={12} /> Active</> : <><AlertCircle size={12} /> Not Authenticated</>}
        </span>
      </div>
      <div className="p-5">
        <div className="grid grid-cols-3 gap-3">
          <div className="px-4 py-3 rounded-lg bg-success/5 border border-success/20 text-center">
            <p className="text-2xl font-bold text-success">{stats.sentToday || 0}</p>
            <p className="text-[10px] text-text-tertiary mt-1">Sent Today</p>
          </div>
          <div className="px-4 py-3 rounded-lg bg-danger/5 border border-danger/20 text-center">
            <p className="text-2xl font-bold text-danger">{stats.failedToday || 0}</p>
            <p className="text-[10px] text-text-tertiary mt-1">Failed Today</p>
          </div>
          <div className="px-4 py-3 rounded-lg bg-warning/5 border border-warning/20 text-center">
            <p className="text-2xl font-bold text-warning">{stats.pending || 0}</p>
            <p className="text-[10px] text-text-tertiary mt-1">Pending</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function IntegrationsPage() {
  const { isAdmin } = useAuth();
  const [teamsStatus, setTeamsStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [previewUsers, setPreviewUsers] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncingStatus, setSyncingStatus] = useState(false);
  const [statusSyncResult, setStatusSyncResult] = useState(null);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Config form state
  const [configData, setConfigData] = useState(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [formData, setFormData] = useState({
    clientId: '',
    clientSecret: '',
    tenantId: '',
    redirectUri: '',
    ssoRedirectUri: '',
    ssoEnabled: false,
  });

  // AI Multi-Provider state
  const [aiProviders, setAiProviders] = useState([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState(null);
  const [testingProviderId, setTestingProviderId] = useState(null);
  const [showKeyForProvider, setShowKeyForProvider] = useState({});
  const [aiForm, setAiForm] = useState({
    provider: 'deepseek',
    apiKey: '',
    model: '',
    baseUrl: '',
  });

  // External API Key state
  const [apiKeys, setApiKeys] = useState([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [showNewKeyForm, setShowNewKeyForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyExpiry, setNewKeyExpiry] = useState('');
  const [newlyCreatedKey, setNewlyCreatedKey] = useState(null);
  const [copiedKey, setCopiedKey] = useState(false);

  useEffect(() => {
    loadStatus();
    if (isAdmin) loadConfig();
    if (isAdmin) loadAiProviders();
    if (isAdmin) loadApiKeys();
    const params = new URLSearchParams(window.location.search);
    if (params.get('teams') === 'success') {
      setSuccessMsg('Microsoft Teams connected successfully! Users are being synced from M365.');
      setTimeout(() => { setSuccessMsg(''); loadStatus(); }, 5000);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('teams') === 'error') {
      setError(`Teams connection failed: ${decodeURIComponent(params.get('msg') || 'Unknown error')}`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  async function loadStatus() {
    try {
      const res = await api.get('/teams/status');
      setTeamsStatus(res.data?.data || res.data);
    } catch {
      setTeamsStatus({ configured: false, connected: false });
    } finally {
      setLoading(false);
    }
  }

  async function loadConfig() {
    setConfigLoading(true);
    try {
      const res = await api.get('/integrations/config/microsoft');
      const data = res.data?.data || res.data;
      setConfigData(data);
      setFormData({
        clientId: data.clientId || '',
        clientSecret: data.clientSecret || '',
        tenantId: data.tenantId || '',
        redirectUri: data.redirectUri || `${window.location.origin.replace(/:3000$/, ':5000')}/api/teams/callback`,
        ssoRedirectUri: data.ssoRedirectUri || `${window.location.origin.replace(/:3000$/, ':5000')}/api/auth/microsoft/callback`,
        ssoEnabled: data.ssoEnabled || false,
      });
    } catch {
      setConfigData(null);
    } finally {
      setConfigLoading(false);
    }
  }

  // ─── External API Key Handlers ─────────────────────────────
  async function loadApiKeys() {
    setApiKeysLoading(true);
    try {
      const res = await api.get('/api-keys');
      setApiKeys(res.data?.data || []);
    } catch {
      setApiKeys([]);
    } finally {
      setApiKeysLoading(false);
    }
  }

  async function handleGenerateKey() {
    if (!newKeyName.trim()) {
      setError('Please enter a name for the API key.');
      return;
    }
    setGeneratingKey(true);
    setError('');
    try {
      const res = await api.post('/api-keys', {
        name: newKeyName.trim(),
        expiresAt: newKeyExpiry || null,
      });
      const data = res.data?.data || res.data;
      setNewlyCreatedKey(data.key);
      setNewKeyName('');
      setNewKeyExpiry('');
      setShowNewKeyForm(false);
      loadApiKeys();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to generate API key.');
    } finally {
      setGeneratingKey(false);
    }
  }

  async function handleRevokeKey(id, name) {
    if (!confirm(`Revoke API key "${name}"? Any application using this key will lose access immediately.`)) return;
    try {
      await api.delete(`/api-keys/${id}`);
      setApiKeys(prev => prev.filter(k => k.id !== id));
      setSuccessMsg('API key revoked.');
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to revoke API key.');
    }
  }

  async function handleToggleKey(id) {
    try {
      const res = await api.patch(`/api-keys/${id}/toggle`);
      const updated = res.data?.data;
      setApiKeys(prev => prev.map(k => k.id === id ? { ...k, isActive: updated.isActive } : k));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to toggle API key.');
    }
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  }

  async function handleSaveConfig() {
    if (!formData.clientId || !formData.tenantId) {
      setError('Client ID and Tenant ID are required.');
      return;
    }
    if (!configData?.hasSecret && !formData.clientSecret) {
      setError('Client Secret is required for initial setup.');
      return;
    }

    setSaving(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await api.post('/integrations/config/microsoft', formData);
      const rawRes = res.data || res;
      const data = rawRes.data || rawRes;
      const autoSynced = rawRes.autoSyncTriggered;
      setConfigData(data);
      setFormData(prev => ({
        ...prev,
        clientSecret: data.clientSecret || prev.clientSecret,
      }));
      setEditing(false);
      setSuccessMsg(autoSynced
        ? 'Configuration saved. M365 user sync triggered automatically — users will appear shortly.'
        : 'Configuration saved successfully.');
      loadStatus(); // Refresh status
      setTimeout(() => setSuccessMsg(''), 6000);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save configuration.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await api.get('/integrations/config/microsoft/test');
      setSuccessMsg(res.data?.message || 'Connection successful!');
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setError(err.response?.data?.message || 'Connection test failed.');
    } finally {
      setTesting(false);
    }
  }

  async function handleDeleteConfig() {
    if (!confirm('Remove Microsoft integration configuration? This will disable Teams sync and SSO.')) return;
    try {
      await api.delete('/integrations/config/microsoft');
      setConfigData(null);
      setFormData({ clientId: '', clientSecret: '', tenantId: '', redirectUri: '', ssoRedirectUri: '', ssoEnabled: false });
      setEditing(false);
      loadStatus();
      setSuccessMsg('Configuration removed.');
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to remove configuration.');
    }
  }

  async function handleConnect() {
    try {
      const res = await api.get('/teams/auth');
      const authUrl = res.data?.data?.authUrl || res.data?.authUrl;
      if (authUrl) window.location.href = authUrl;
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to start Teams auth.');
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect Teams? Calendar sync will stop.')) return;
    setDisconnecting(true);
    try {
      await api.post('/teams/disconnect');
      setTeamsStatus(prev => ({ ...prev, connected: false, teamsUserId: null }));
    } catch {} finally { setDisconnecting(false); }
  }

  async function handlePreviewUsers() {
    setPreviewing(true);
    setError('');
    try {
      const res = await api.get('/teams/preview-users');
      setPreviewUsers(res.data?.data || res.data);
      setShowPreview(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to fetch M365 users.');
    } finally { setPreviewing(false); }
  }

  async function handleSyncUsers() {
    if (!confirm('This will create accounts for all M365 users not yet in the system. Users will authenticate with their Microsoft 365 credentials (SSO). Continue?')) return;
    setSyncing(true);
    setError('');
    setSyncResult(null);
    try {
      const res = await api.post('/teams/sync-users');
      setSyncResult(res.data?.data || res.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Sync failed.');
    } finally { setSyncing(false); }
  }

  async function handleSyncActiveStatus() {
    setSyncingStatus(true);
    setError('');
    setStatusSyncResult(null);
    try {
      const res = await api.post('/teams/sync-status');
      setStatusSyncResult(res.data?.data || res.data);
      setSuccessMsg(res.data?.message || res.message || 'Active status synced.');
      setTimeout(() => setSuccessMsg(''), 5000);
    } catch (err) {
      setError(err.response?.data?.message || 'Status sync failed.');
    } finally { setSyncingStatus(false); }
  }

  // ─── AI Multi-Provider Handlers ────────────────────────────
  const AI_PROVIDERS = [
    { value: 'deepseek', label: 'DeepSeek', color: '#4F46E5', defaultModel: 'deepseek-chat', icon: 'D' },
    { value: 'openai', label: 'OpenAI', color: '#10A37F', defaultModel: 'gpt-3.5-turbo', icon: 'O' },
    { value: 'anthropic', label: 'Anthropic', color: '#D97706', defaultModel: 'claude-3-haiku-20240307', icon: 'A' },
    { value: 'gemini', label: 'Gemini', color: '#4285F4', defaultModel: 'gemini-pro', icon: 'G' },
    { value: 'custom', label: 'Custom', color: '#6B7280', defaultModel: '', icon: 'C' },
  ];

  async function loadAiProviders() {
    setAiLoading(true);
    try {
      const res = await api.get('/ai/providers');
      setAiProviders(res.data?.data || []);
    } catch {
      setAiProviders([]);
    } finally {
      setAiLoading(false);
    }
  }

  async function handleAddProvider() {
    if (!aiForm.provider) { setError('Provider type is required.'); return; }
    if (!aiForm.apiKey) { setError('API key is required.'); return; }
    setAiSaving(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await api.post('/ai/providers', {
        provider: aiForm.provider,
        apiKey: aiForm.apiKey,
        model: aiForm.model || '',
        baseUrl: aiForm.baseUrl || '',
      });
      setSuccessMsg(res.data?.message || 'Provider added successfully.');
      setShowAddProvider(false);
      setAiForm({ provider: 'deepseek', apiKey: '', model: '', baseUrl: '' });
      loadAiProviders();
      setTimeout(() => setSuccessMsg(''), 5000);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to add provider.');
    } finally {
      setAiSaving(false);
    }
  }

  async function handleUpdateProvider(id) {
    if (!aiForm.provider) { setError('Provider type is required.'); return; }
    setAiSaving(true);
    setError('');
    setSuccessMsg('');
    try {
      const payload = {
        provider: aiForm.provider,
        model: aiForm.model || '',
        baseUrl: aiForm.baseUrl || '',
      };
      if (aiForm.apiKey) payload.apiKey = aiForm.apiKey;
      await api.put(`/ai/providers/${id}`, payload);
      setSuccessMsg('Provider updated successfully.');
      setEditingProviderId(null);
      setAiForm({ provider: 'deepseek', apiKey: '', model: '', baseUrl: '' });
      loadAiProviders();
      setTimeout(() => setSuccessMsg(''), 5000);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update provider.');
    } finally {
      setAiSaving(false);
    }
  }

  async function handleDeleteProvider(id, name) {
    if (!confirm(`Remove ${name} provider? This cannot be undone.`)) return;
    try {
      await api.delete(`/ai/providers/${id}`);
      setSuccessMsg(`${name} provider removed.`);
      loadAiProviders();
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to remove provider.');
    }
  }

  async function handleTestProvider(id) {
    setTestingProviderId(id);
    setError('');
    setSuccessMsg('');
    try {
      const res = await api.post(`/ai/providers/${id}/test`);
      const diag = res.data?.data?.diagnostics;
      if (res.data?.success) {
        setSuccessMsg(res.data?.message || 'Connection successful!');
        loadAiProviders();
      } else {
        const mainMsg = res.data?.message || 'Connection test failed.';
        const diagLine = diag
          ? `\n[Diagnostics] Provider: ${diag.providerType || '?'} | Model: ${diag.model || '?'} | Key: ${diag.keySuffix || '?'} | HTTP: ${diag.httpStatus || 'N/A'} | Type: ${diag.failureType || '?'}`
          : '';
        setError(mainMsg + diagLine);
      }
      setTimeout(() => setSuccessMsg(''), 5000);
    } catch (err) {
      const errData = err.response?.data;
      const diag = errData?.data?.diagnostics;
      const mainMsg = errData?.message || 'Connection test failed.';
      const diagLine = diag
        ? `\n[Diagnostics] Provider: ${diag.providerType || '?'} | Model: ${diag.model || '?'} | Key: ${diag.keySuffix || '?'} | HTTP: ${diag.httpStatus || 'N/A'} | Type: ${diag.failureType || '?'}`
        : '';
      setError(mainMsg + diagLine);
    } finally {
      setTestingProviderId(null);
    }
  }

  async function handleSetDefault(id) {
    try {
      await api.post(`/ai/providers/${id}/set-default`);
      setSuccessMsg('Default provider updated.');
      loadAiProviders();
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to set default.');
    }
  }

  async function handleToggleProvider(id) {
    try {
      await api.post(`/ai/providers/${id}/toggle`);
      loadAiProviders();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to toggle provider.');
    }
  }

  function startEditProvider(p) {
    setEditingProviderId(p.id);
    setAiForm({
      provider: p.provider,
      apiKey: '',
      model: p.model || '',
      baseUrl: p.baseUrl || '',
    });
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" /></div>;
  }

  const isConfigured = configData?.isConfigured || teamsStatus?.configured;

  return (
    <div className="p-6 max-w-[1000px] mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-text-primary">Integrations</h1>
        <p className="text-sm text-text-secondary mt-0.5">Connect your tools and sync your team</p>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-danger/10 text-danger text-sm mb-4 animate-fade-in">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1 whitespace-pre-line">{error}</div>
          <button onClick={() => setError('')} className="ml-auto shrink-0"><X size={14} /></button>
        </div>
      )}

      {successMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-success/10 text-success text-sm mb-4 animate-fade-in">
          <CheckCircle2 size={16} /> {successMsg}
          <button onClick={() => setSuccessMsg('')} className="ml-auto"><X size={14} /></button>
        </div>
      )}

      {/* Microsoft Teams Card */}
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden mb-6">
        {/* Header */}
        <div className="flex items-center gap-4 p-5 border-b border-border">
          <div className="w-12 h-12 rounded-xl bg-[#464EB8] flex items-center justify-center shadow-lg">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
              <path d="M19.5 3h-7c-.83 0-1.5.67-1.5 1.5v7c0 .83.67 1.5 1.5 1.5h7c.83 0 1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5zM16 6.5a1.25 1.25 0 110 2.5 1.25 1.25 0 010-2.5zM19 11h-6V9.5h6V11zM20.5 14h-5c-.28 0-.5.22-.5.5v5c0 .28.22.5.5.5h5c.28 0 .5-.22.5-.5v-5c0-.28-.22-.5-.5-.5zM9 5H4.5C3.67 5 3 5.67 3 6.5v11c0 .83.67 1.5 1.5 1.5H9c.83 0 1.5-.67 1.5-1.5v-11C10.5 5.67 9.83 5 9 5z"/>
            </svg>
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-text-primary">Microsoft Teams</h2>
            <p className="text-xs text-text-tertiary">Calendar sync, user management, SSO authentication</p>
          </div>
          <div className="flex items-center gap-2">
            {teamsStatus?.configValid ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-success/10 text-success border border-success/20">
                <CheckCircle2 size={12} /> Connected
              </span>
            ) : isConfigured ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-warning/10 text-warning border border-warning/20">
                Not Connected
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
                Not Configured
              </span>
            )}
          </div>
        </div>

        {/* Admin Configuration Section */}
        {isAdmin && (
          <div className="border-b border-border">
            <div className="p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  <Settings size={15} /> Azure AD Configuration
                </h3>
                <div className="flex items-center gap-2">
                  {configData?.isConfigured && !editing && (
                    <>
                      <button onClick={handleTestConnection} disabled={testing}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/5 rounded-lg border border-primary/20 transition-colors">
                        {testing ? <div className="w-3 h-3 border-2 border-primary/20 border-t-primary rounded-full animate-spin" /> : <TestTube2 size={13} />}
                        Test Connection
                      </button>
                      <button onClick={() => { setEditing(true); setFormData(p => ({ ...p, clientSecret: '' })); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface rounded-lg border border-border transition-colors">
                        <Edit3 size={13} /> Edit
                      </button>
                      <button onClick={handleDeleteConfig}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/5 rounded-lg border border-danger/20 transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {configLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary/20 border-t-primary" />
                </div>
              ) : !configData?.isConfigured || editing ? (
                /* Configuration Form */
                <div className="space-y-4" autoComplete="off">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1.5">
                        <span className="flex items-center gap-1"><Key size={12} /> Application (Client) ID</span>
                      </label>
                      <input type="text" value={formData.clientId} onChange={e => setFormData(p => ({ ...p, clientId: e.target.value }))}
                        placeholder="e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890"
                        autoComplete="off" data-lpignore="true" data-1p-ignore
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1.5">
                        <span className="flex items-center gap-1"><Lock size={12} /> Client Secret</span>
                      </label>
                      <div className="relative">
                        <input type={showSecret ? 'text' : 'password'} value={formData.clientSecret}
                          onChange={e => setFormData(p => ({ ...p, clientSecret: e.target.value }))}
                          placeholder={editing && configData?.hasSecret ? 'Leave blank to keep current secret' : 'Enter client secret'}
                          autoComplete="new-password" data-lpignore="true" data-1p-ignore
                          className="w-full px-3 py-2 pr-10 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" />
                        <button type="button" onClick={() => setShowSecret(s => !s)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors">
                          {showSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                      {editing && configData?.hasSecret && (
                        <p className="text-[10px] text-text-tertiary mt-1">Current: {configData.clientSecret}</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1.5">
                        <span className="flex items-center gap-1"><Globe size={12} /> Tenant ID</span>
                      </label>
                      <input type="text" value={formData.tenantId} onChange={e => setFormData(p => ({ ...p, tenantId: e.target.value }))}
                        placeholder="e.g. your-tenant-id or common"
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1.5">
                        <span className="flex items-center gap-1"><Link2 size={12} /> Redirect URI (Calendar)</span>
                      </label>
                      <input type="text" value={formData.redirectUri} onChange={e => setFormData(p => ({ ...p, redirectUri: e.target.value }))}
                        placeholder="http://localhost:5000/api/teams/callback"
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1.5">
                        <span className="flex items-center gap-1"><Link2 size={12} /> SSO Redirect URI</span>
                      </label>
                      <input type="text" value={formData.ssoRedirectUri} onChange={e => setFormData(p => ({ ...p, ssoRedirectUri: e.target.value }))}
                        placeholder="http://localhost:5000/api/auth/microsoft/callback"
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" />
                    </div>
                    <div className="flex items-center gap-3 pt-5">
                      <button onClick={() => setFormData(p => ({ ...p, ssoEnabled: !p.ssoEnabled }))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${formData.ssoEnabled ? 'bg-primary' : 'bg-gray-300'}`}>
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${formData.ssoEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                      <span className="text-sm text-text-primary font-medium">Enable SSO Login</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-2">
                    <button onClick={handleSaveConfig} disabled={saving}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-hover transition-colors shadow-sm">
                      {saving ? <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Save size={14} />}
                      {configData?.isConfigured ? 'Save Changes' : 'Save Configuration'}
                    </button>
                    {editing && (
                      <button onClick={() => { setEditing(false); loadConfig(); }}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface rounded-lg border border-border transition-colors">
                        Cancel
                      </button>
                    )}
                  </div>

                  {!configData?.isConfigured && (
                    <div className="mt-3 p-3 rounded-lg bg-blue-50 border border-blue-200">
                      <p className="text-xs text-blue-700 font-medium mb-1">Azure AD Setup Guide</p>
                      <ol className="text-[11px] text-blue-600 space-y-1 list-decimal list-inside">
                        <li>Go to Azure Portal &rarr; Azure Active Directory &rarr; App registrations</li>
                        <li>Create a new registration or use an existing one</li>
                        <li>Copy the Application (Client) ID and Directory (Tenant) ID</li>
                        <li>Under Certificates & secrets, create a new client secret</li>
                        <li>Under Authentication, add both Redirect URIs shown above</li>
                        <li>Under API permissions, add: openid, profile, email, User.Read, Calendars.ReadWrite</li>
                      </ol>
                    </div>
                  )}
                </div>
              ) : (
                /* Configured View (read-only) */
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="p-3 rounded-lg bg-surface/50 border border-border">
                    <p className="text-[10px] text-text-tertiary mb-1">Client ID</p>
                    <p className="text-xs font-mono text-text-primary truncate">{configData.clientId}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-surface/50 border border-border">
                    <p className="text-[10px] text-text-tertiary mb-1">Client Secret</p>
                    <p className="text-xs font-mono text-text-primary">{configData.clientSecret}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-surface/50 border border-border">
                    <p className="text-[10px] text-text-tertiary mb-1">Tenant ID</p>
                    <p className="text-xs font-mono text-text-primary truncate">{configData.tenantId}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-surface/50 border border-border col-span-2 md:col-span-1">
                    <p className="text-[10px] text-text-tertiary mb-1">SSO Login</p>
                    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${configData.ssoEnabled ? 'bg-success/10 text-success' : 'bg-gray-100 text-gray-500'}`}>
                      {configData.ssoEnabled ? <><CheckCircle2 size={10} /> Enabled</> : 'Disabled'}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Body — Features & Connection */}
        {isConfigured && (
          <div className="p-5">
            <div className="space-y-4">
              {/* Features */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  {
                    icon: Calendar, label: 'Calendar Sync',
                    desc: teamsStatus?.connected ? 'Active — events auto-created' : 'Connect to enable',
                    active: teamsStatus?.connected,
                  },
                  {
                    icon: Users, label: 'User Sync',
                    desc: teamsStatus?.usersSynced > 0 ? `${teamsStatus.usersSynced} users synced` : 'No users synced yet',
                    active: teamsStatus?.usersSynced > 0,
                  },
                  {
                    icon: Shield, label: 'SSO Login',
                    desc: configData?.ssoEnabled || teamsStatus?.ssoEnabled ? 'Microsoft sign-in active' : 'Enable in config above',
                    active: configData?.ssoEnabled || teamsStatus?.ssoEnabled,
                  },
                ].map(f => (
                  <div key={f.label} className={`flex items-start gap-2.5 p-3 rounded-lg border ${f.active ? 'bg-success/5 border-success/20' : 'bg-surface/50 border-border'}`}>
                    <f.icon size={16} className={`mt-0.5 ${f.active ? 'text-success' : 'text-primary'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-medium text-text-primary">{f.label}</p>
                        {f.active && <CheckCircle2 size={11} className="text-success" />}
                      </div>
                      <p className="text-[10px] text-text-tertiary">{f.desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Re-sync button for admins */}
              {isAdmin && teamsStatus?.usersSynced > 0 && (
                <div className="flex items-center gap-2">
                  <button onClick={handleSyncUsers} disabled={syncing}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface rounded-lg border border-border transition-colors">
                    {syncing ? <div className="w-3 h-3 border-2 border-primary/20 border-t-primary rounded-full animate-spin" /> : <RefreshCw size={12} />}
                    Re-sync Users
                  </button>
                  <button onClick={handleSyncActiveStatus} disabled={syncingStatus}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface rounded-lg border border-border transition-colors">
                    {syncingStatus ? <div className="w-3 h-3 border-2 border-primary/20 border-t-primary rounded-full animate-spin" /> : <RefreshCw size={12} />}
                    Sync Active Status
                  </button>
                </div>
              )}

              {/* Connection Actions */}
              <div className="flex items-center gap-2 pt-2">
                {teamsStatus?.connected ? (
                  <>
                    <button onClick={handleDisconnect} disabled={disconnecting}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm text-danger hover:bg-danger/5 rounded-lg border border-danger/20 transition-colors">
                      {disconnecting ? <div className="w-3.5 h-3.5 border-2 border-danger/20 border-t-danger rounded-full animate-spin" /> : <Unplug size={14} />}
                      Disconnect
                    </button>
                    {teamsStatus?.expired && (
                      <button onClick={handleConnect}
                        className="flex items-center gap-1.5 px-3 py-2 text-sm text-primary hover:bg-primary/5 rounded-lg border border-primary/20 transition-colors">
                        <RefreshCw size={14} /> Reconnect
                      </button>
                    )}
                  </>
                ) : (
                  <button onClick={handleConnect}
                    className="flex items-center gap-2 px-5 py-2.5 bg-[#464EB8] text-white text-sm font-medium rounded-lg hover:bg-[#3b42a0] transition-colors shadow-sm">
                    <ExternalLink size={15} /> Connect Microsoft Teams
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Sync Results (shown after Re-sync or auto-sync) */}
        {(syncResult || statusSyncResult) && (
          <div className="border-t border-border p-5">
            {syncResult && (
              <div className="animate-fade-in mb-3">
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="px-3 py-2 rounded-lg bg-success/5 border border-success/20 text-center">
                    <p className="text-lg font-bold text-success">{syncResult.created?.length || 0}</p>
                    <p className="text-[10px] text-text-tertiary">New Users</p>
                  </div>
                  <div className="px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-center">
                    <p className="text-lg font-bold text-primary">{syncResult.existing?.length || 0}</p>
                    <p className="text-[10px] text-text-tertiary">Already Exist</p>
                  </div>
                  <div className="px-3 py-2 rounded-lg bg-danger/5 border border-danger/20 text-center">
                    <p className="text-lg font-bold text-danger">{syncResult.failed?.length || 0}</p>
                    <p className="text-[10px] text-text-tertiary">Failed</p>
                  </div>
                </div>
                {syncResult.created?.length > 0 && (
                  <div className="bg-success/5 rounded-lg border border-success/20 p-3">
                    <p className="text-xs font-medium text-success mb-2">New users created (sign in with Microsoft SSO)</p>
                    <div className="space-y-1">
                      {syncResult.created.map((u, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-text-primary">
                          <Check size={12} className="text-success" />
                          <span className="font-medium">{u.name}</span>
                          <span className="text-text-tertiary">({u.email})</span>
                          {u.department && <span className="text-[10px] px-1.5 py-0.5 bg-white rounded border border-border">{u.department}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {statusSyncResult && (
              <div className="animate-fade-in">
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="px-3 py-2 rounded-lg bg-success/5 border border-success/20 text-center">
                    <p className="text-lg font-bold text-success">{statusSyncResult.activated?.length || 0}</p>
                    <p className="text-[10px] text-text-tertiary">Activated</p>
                  </div>
                  <div className="px-3 py-2 rounded-lg bg-danger/5 border border-danger/20 text-center">
                    <p className="text-lg font-bold text-danger">{statusSyncResult.deactivated?.length || 0}</p>
                    <p className="text-[10px] text-text-tertiary">Deactivated</p>
                  </div>
                  <div className="px-3 py-2 rounded-lg bg-surface border border-border text-center">
                    <p className="text-lg font-bold text-text-secondary">{statusSyncResult.unchanged || 0}</p>
                    <p className="text-[10px] text-text-tertiary">Unchanged</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Teams Notification Stats (admin only) */}
      {isAdmin && teamsStatus?.configValid && <TeamsNotificationStats />}

      {/* AI Provider Cards */}
      {isAdmin && (
        <div className="mb-6">
          {/* Section Header */}
          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden mb-4">
            <div className="flex items-center gap-4 p-5">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center shadow-lg">
                <Bot size={24} className="text-white" />
              </div>
              <div className="flex-1">
                <h2 className="text-base font-semibold text-text-primary">AI Provider</h2>
                <p className="text-xs text-text-tertiary">Configure which AI model powers resume scoring, interview questions, and the AI assistant.</p>
              </div>
              <div className="flex items-center gap-2">
                {aiProviders.filter(p => p.isActive).length > 0 ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-success/10 text-success border border-success/20">
                    <CheckCircle2 size={12} /> {aiProviders.filter(p => p.isActive).length} Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
                    Not Configured
                  </span>
                )}
                <button onClick={() => { setShowAddProvider(true); setAiForm({ provider: 'deepseek', apiKey: '', model: '', baseUrl: '' }); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700 transition-colors shadow-sm">
                  <Plus size={13} /> Add Provider
                </button>
              </div>
            </div>
          </div>

          {aiLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary/20 border-t-primary" />
            </div>
          ) : (
            <>
              {/* Provider Cards */}
              <div className="space-y-4">
                {aiProviders.map(p => {
                  const provMeta = AI_PROVIDERS.find(ap => ap.value === p.provider) || AI_PROVIDERS[AI_PROVIDERS.length - 1];
                  const isEditing = editingProviderId === p.id;
                  const isTesting = testingProviderId === p.id;

                  return (
                    <div key={p.id} className={`bg-white rounded-xl border shadow-sm overflow-hidden transition-all ${p.isDefault ? 'border-violet-300 ring-1 ring-violet-200' : 'border-border'}`}>
                      {isEditing ? (
                        /* Edit Form */
                        <div className="p-5">
                          <div className="flex items-center justify-between mb-4">
                            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                              <Edit3 size={14} /> Edit {provMeta.label} Provider
                            </h3>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs font-medium text-text-secondary mb-1.5">Provider</label>
                              <select value={aiForm.provider}
                                onChange={e => {
                                  const prov = AI_PROVIDERS.find(ap => ap.value === e.target.value);
                                  setAiForm(prev => ({ ...prev, provider: e.target.value, model: prov?.defaultModel || prev.model }));
                                }}
                                className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all bg-white">
                                {AI_PROVIDERS.map(ap => <option key={ap.value} value={ap.value}>{ap.label}</option>)}
                              </select>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                                <span className="flex items-center gap-1"><Key size={12} /> API Key</span>
                              </label>
                              <div className="relative">
                                <input type={showKeyForProvider[p.id] ? 'text' : 'password'} value={aiForm.apiKey}
                                  onChange={e => setAiForm(prev => ({ ...prev, apiKey: e.target.value }))}
                                  placeholder="Enter new API key (leave blank to keep current)"
                                  autoComplete="new-password" data-lpignore="true" data-1p-ignore
                                  className="w-full px-3 py-2 pr-10 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all" />
                                <button type="button" onClick={() => setShowKeyForProvider(prev => ({ ...prev, [p.id]: !prev[p.id] }))}
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors">
                                  {showKeyForProvider[p.id] ? <EyeOff size={15} /> : <Eye size={15} />}
                                </button>
                              </div>
                              <p className="text-[10px] text-text-tertiary mt-1">Current: {p.apiKey}</p>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-text-secondary mb-1.5">Model Name</label>
                              <input type="text" value={aiForm.model}
                                onChange={e => setAiForm(prev => ({ ...prev, model: e.target.value }))}
                                placeholder={provMeta.defaultModel || 'Model identifier'}
                                className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all" />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-text-secondary mb-1.5">Base URL (optional)</label>
                              <input type="text" value={aiForm.baseUrl}
                                onChange={e => setAiForm(prev => ({ ...prev, baseUrl: e.target.value }))}
                                placeholder="Leave empty for default endpoint"
                                className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all" />
                            </div>
                          </div>
                          <div className="flex items-center gap-2 mt-4">
                            <button onClick={() => handleUpdateProvider(p.id)} disabled={aiSaving}
                              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700 transition-colors shadow-sm">
                              {aiSaving ? <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Save size={14} />}
                              Save Changes
                            </button>
                            <button onClick={() => { setEditingProviderId(null); setAiForm({ provider: 'deepseek', apiKey: '', model: '', baseUrl: '' }); }}
                              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface rounded-lg border border-border transition-colors">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* Read-Only Card */
                        <div className="p-5">
                          <div className="flex items-center gap-4">
                            {/* Provider Icon */}
                            <div className="w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold text-base shadow-md"
                              style={{ backgroundColor: provMeta.color }}>
                              {provMeta.icon}
                            </div>

                            {/* Provider Info */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <h3 className="text-sm font-semibold text-text-primary capitalize">{provMeta.label}</h3>
                                {p.isDefault && (
                                  <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 border border-violet-200">
                                    Default
                                  </span>
                                )}
                                {p.isActive ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                                    <CheckCircle2 size={10} /> Active
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
                                    Inactive
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-text-tertiary mt-0.5">
                                Model: <span className="font-mono">{p.model || '(default)'}</span>
                                {p.baseUrl && <> &middot; URL: <span className="font-mono">{p.baseUrl}</span></>}
                              </p>
                            </div>

                            {/* Provider Details */}
                            <div className="hidden md:flex items-center gap-4">
                              <div className="text-right">
                                <p className="text-[10px] text-text-tertiary">API Key</p>
                                <p className="text-xs font-mono text-text-primary">{p.apiKey}</p>
                              </div>
                              {p.lastTestedAt && (
                                <div className="text-right">
                                  <p className="text-[10px] text-text-tertiary">Last Tested</p>
                                  <p className="text-[10px] text-text-primary">{new Date(p.lastTestedAt).toLocaleString()}</p>
                                </div>
                              )}
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1">
                              <button onClick={() => handleTestProvider(p.id)} disabled={isTesting} title="Test Connection"
                                className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-violet-600 hover:bg-violet-50 rounded-lg border border-violet-200 transition-colors">
                                {isTesting ? <div className="w-3 h-3 border-2 border-violet-400/20 border-t-violet-400 rounded-full animate-spin" /> : <TestTube2 size={13} />}
                                Test
                              </button>
                              {!p.isDefault && p.isActive && (
                                <button onClick={() => handleSetDefault(p.id)} title="Set as default"
                                  className="p-1.5 rounded-lg text-violet-500 hover:bg-violet-50 transition-colors border border-transparent hover:border-violet-200">
                                  <Sparkles size={14} />
                                </button>
                              )}
                              <button onClick={() => handleToggleProvider(p.id)} title={p.isActive ? 'Deactivate' : 'Activate'}
                                className={`p-1.5 rounded-lg transition-colors ${p.isActive ? 'text-success hover:bg-success/10' : 'text-gray-400 hover:bg-gray-100'}`}>
                                <Power size={14} />
                              </button>
                              <button onClick={() => startEditProvider(p)} title="Edit"
                                className="p-1.5 rounded-lg text-text-tertiary hover:bg-surface hover:text-text-secondary transition-colors">
                                <Edit3 size={14} />
                              </button>
                              <button onClick={() => handleDeleteProvider(p.id, provMeta.label)} title="Delete"
                                className="p-1.5 rounded-lg text-danger hover:bg-danger/10 transition-colors">
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Empty State */}
                {aiProviders.length === 0 && !showAddProvider && (
                  <div className="bg-white rounded-xl border border-border shadow-sm p-8 text-center">
                    <Bot size={32} className="mx-auto mb-3 text-violet-300" />
                    <p className="text-sm font-medium text-text-primary mb-1">No AI providers configured</p>
                    <p className="text-xs text-text-tertiary mb-4">Add your first AI provider to enable the AI Assistant for all users.</p>
                    <button onClick={() => { setShowAddProvider(true); setAiForm({ provider: 'deepseek', apiKey: '', model: '', baseUrl: '' }); }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700 transition-colors shadow-sm">
                      <Plus size={14} /> Add Your First Provider
                    </button>
                  </div>
                )}
              </div>

              {/* Add Provider Form */}
              {showAddProvider && (
                <div className="bg-white rounded-xl border border-violet-200 shadow-sm overflow-hidden mt-4 animate-fade-in">
                  <div className="p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                        <Plus size={15} /> Add New AI Provider
                      </h3>
                    </div>

                    {/* Provider Selector Buttons */}
                    <div className="mb-4">
                      <label className="block text-xs font-medium text-text-secondary mb-2">Provider</label>
                      <div className="flex flex-wrap gap-2">
                        {AI_PROVIDERS.map(ap => (
                          <button key={ap.value} onClick={() => setAiForm(prev => ({ ...prev, provider: ap.value, model: ap.defaultModel }))}
                            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl border-2 transition-all ${
                              aiForm.provider === ap.value
                                ? 'border-violet-500 bg-violet-50 text-violet-700 shadow-sm'
                                : 'border-border bg-white text-text-secondary hover:border-violet-200 hover:bg-violet-50/50'
                            }`}>
                            <span className="w-6 h-6 rounded-lg flex items-center justify-center text-white text-xs font-bold" style={{ backgroundColor: ap.color }}>
                              {ap.icon}
                            </span>
                            {ap.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">
                          <span className="flex items-center gap-1"><Key size={12} /> API Key</span>
                        </label>
                        <div className="relative">
                          <input type={showKeyForProvider['new'] ? 'text' : 'password'} value={aiForm.apiKey}
                            onChange={e => setAiForm(prev => ({ ...prev, apiKey: e.target.value }))}
                            placeholder="Enter your API key"
                            autoComplete="new-password" data-lpignore="true" data-1p-ignore
                            className="w-full px-3 py-2 pr-10 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all" />
                          <button type="button" onClick={() => setShowKeyForProvider(prev => ({ ...prev, new: !prev.new }))}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors">
                            {showKeyForProvider['new'] ? <EyeOff size={15} /> : <Eye size={15} />}
                          </button>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">Base URL</label>
                        <input type="text" value={aiForm.baseUrl}
                          onChange={e => setAiForm(prev => ({ ...prev, baseUrl: e.target.value }))}
                          placeholder={aiForm.provider === 'custom' ? 'https://your-api-endpoint.com' : 'Leave empty for default endpoint'}
                          className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all" />
                        <p className="text-[10px] text-text-tertiary mt-1">Must be OpenAI-compatible. The endpoint /v1/chat/completions will be called.</p>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-text-secondary mb-1.5">Model Name</label>
                        <input type="text" value={aiForm.model}
                          onChange={e => setAiForm(prev => ({ ...prev, model: e.target.value }))}
                          placeholder={AI_PROVIDERS.find(ap => ap.value === aiForm.provider)?.defaultModel || 'Model identifier'}
                          className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 transition-all" />
                      </div>
                    </div>

                    <div className="flex items-center gap-2 mt-4">
                      <button onClick={handleAddProvider} disabled={aiSaving}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700 transition-colors shadow-sm">
                        {aiSaving ? <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Save size={14} />}
                        Save Configuration
                      </button>
                      <button onClick={async () => {
                        if (!aiForm.apiKey || !aiForm.provider) { setError('Provider and API key are required to test.'); return; }
                        setTestingProviderId('new');
                        setError('');
                        setSuccessMsg('');
                        try {
                          const res = await api.post('/ai/test', { provider: aiForm.provider, apiKey: aiForm.apiKey, model: aiForm.model, baseUrl: aiForm.baseUrl });
                          const diag = res.data?.data?.diagnostics;
                          if (res.data?.success) { setSuccessMsg(res.data?.message || 'Connection successful!'); }
                          else {
                            const mainMsg = res.data?.message || 'Connection test failed.';
                            const diagLine = diag ? `\n[Diagnostics] Provider: ${diag.providerType || '?'} | Model: ${diag.model || '?'} | Key: ${diag.keySuffix || '?'} | HTTP: ${diag.httpStatus || 'N/A'} | Type: ${diag.failureType || '?'}` : '';
                            setError(mainMsg + diagLine);
                          }
                          setTimeout(() => setSuccessMsg(''), 5000);
                        } catch (err) {
                          const errData = err.response?.data;
                          const diag = errData?.data?.diagnostics;
                          const mainMsg = errData?.message || 'Connection test failed.';
                          const diagLine = diag ? `\n[Diagnostics] Provider: ${diag.providerType || '?'} | Model: ${diag.model || '?'} | Key: ${diag.keySuffix || '?'} | HTTP: ${diag.httpStatus || 'N/A'} | Type: ${diag.failureType || '?'}` : '';
                          setError(mainMsg + diagLine);
                        }
                        finally { setTestingProviderId(null); }
                      }} disabled={testingProviderId === 'new'}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-violet-600 hover:bg-violet-50 rounded-lg border border-violet-200 transition-colors">
                        {testingProviderId === 'new' ? <div className="w-3.5 h-3.5 border-2 border-violet-400/20 border-t-violet-400 rounded-full animate-spin" /> : <TestTube2 size={14} />}
                        Test Connection
                      </button>
                      <button onClick={() => { setShowAddProvider(false); setAiForm({ provider: 'deepseek', apiKey: '', model: '', baseUrl: '' }); }}
                        className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface rounded-lg border border-border transition-colors">
                        Cancel
                      </button>
                    </div>

                    {aiProviders.length === 0 && (
                      <div className="mt-3 p-3 rounded-lg bg-violet-50 border border-violet-200">
                        <p className="text-xs text-violet-700 font-medium mb-1">Setup Guide</p>
                        <ol className="text-[11px] text-violet-600 space-y-1 list-decimal list-inside">
                          <li>Choose your preferred AI provider (DeepSeek is recommended for cost-effectiveness)</li>
                          <li>Get an API key from the provider's website</li>
                          <li>Paste the key above and optionally specify a model</li>
                          <li>Click Save, then Test Connection to verify</li>
                          <li>The AI Assistant chat widget will appear for all users</li>
                        </ol>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Transcription Provider (admin only) */}
      {isAdmin && (
        <TranscriptionProviderSection
          onError={(msg) => { setError(msg); setTimeout(() => setError(''), 6000); }}
          onSuccess={(msg) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(''), 5000); }}
        />
      )}

      {/* External API Access Card */}
      {isAdmin && (
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden mb-6">
          {/* Header */}
          <div className="flex items-center gap-4 p-5 border-b border-border">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-600 to-teal-600 flex items-center justify-center shadow-lg">
              <Database size={24} className="text-white" />
            </div>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-text-primary">External API</h2>
              <p className="text-xs text-text-tertiary">Access employee task data from external applications via API key</p>
            </div>
            <div className="flex items-center gap-2">
              {apiKeys.filter(k => k.isActive && !k.isExpired).length > 0 ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-success/10 text-success border border-success/20">
                  <CheckCircle2 size={12} /> {apiKeys.filter(k => k.isActive && !k.isExpired).length} Active Key{apiKeys.filter(k => k.isActive && !k.isExpired).length !== 1 ? 's' : ''}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
                  No Active Keys
                </span>
              )}
            </div>
          </div>

          {/* Body */}
          <div className="p-5">
            {/* API Endpoint Info */}
            <div className="mb-5">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-3">
                <Globe size={15} /> API Endpoints
              </h3>
              <div className="space-y-2">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-surface/50 border border-border">
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-200">GET</span>
                  <code className="text-xs font-mono text-text-primary flex-1 truncate">https://monday.anistonav.com/api/external/employees</code>
                  <button onClick={() => copyToClipboard('https://monday.anistonav.com/api/external/employees')}
                    className="text-text-tertiary hover:text-text-secondary transition-colors p-1">
                    <Clipboard size={13} />
                  </button>
                </div>
                <div className="flex items-center gap-2 p-3 rounded-lg bg-surface/50 border border-border">
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-200">GET</span>
                  <code className="text-xs font-mono text-text-primary flex-1 truncate">https://monday.anistonav.com/api/external/employees/:id</code>
                  <button onClick={() => copyToClipboard('https://monday.anistonav.com/api/external/employees/:id')}
                    className="text-text-tertiary hover:text-text-secondary transition-colors p-1">
                    <Clipboard size={13} />
                  </button>
                </div>
              </div>
              <p className="text-[10px] text-text-tertiary mt-2">
                Returns employee profiles, task stats (pending/in-progress/done/overdue), active tasks with subtasks, weekly review, and completion trends.
                Pass header <code className="bg-surface px-1 py-0.5 rounded text-[10px]">X-API-Key: your_key</code> for authentication.
              </p>
            </div>

            {/* Newly created key banner */}
            {newlyCreatedKey && (
              <div className="mb-4 p-4 rounded-lg bg-emerald-50 border border-emerald-200 animate-fade-in">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 size={16} className="text-emerald-600" />
                  <p className="text-sm font-semibold text-emerald-800">API Key Generated</p>
                </div>
                <p className="text-xs text-emerald-700 mb-2">Copy this key now. It will not be shown again.</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 text-xs font-mono bg-white rounded-lg border border-emerald-300 text-text-primary select-all break-all">
                    {newlyCreatedKey}
                  </code>
                  <button onClick={() => copyToClipboard(newlyCreatedKey)}
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${copiedKey ? 'bg-emerald-600 text-white border-emerald-600' : 'text-emerald-700 border-emerald-300 hover:bg-emerald-100'}`}>
                    {copiedKey ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                  </button>
                </div>
                <button onClick={() => setNewlyCreatedKey(null)} className="mt-2 text-[10px] text-emerald-600 hover:underline">Dismiss</button>
              </div>
            )}

            {/* API Keys Management */}
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <Key size={15} /> API Keys
              </h3>
              <button onClick={() => { setShowNewKeyForm(true); setNewlyCreatedKey(null); }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors shadow-sm">
                <Plus size={13} /> Generate New Key
              </button>
            </div>

            {/* New Key Form */}
            {showNewKeyForm && (
              <div className="mb-4 p-4 rounded-lg border border-emerald-200 bg-emerald-50/50 animate-fade-in">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-1">
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">Key Name *</label>
                    <input
                      type="text"
                      value={newKeyName}
                      onChange={e => setNewKeyName(e.target.value)}
                      placeholder="e.g. HRMS Production"
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    />
                  </div>
                  <div className="md:col-span-1">
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">
                      <span className="flex items-center gap-1"><Clock size={12} /> Expires On (optional)</span>
                    </label>
                    <input
                      type="date"
                      value={newKeyExpiry}
                      onChange={e => setNewKeyExpiry(e.target.value)}
                      min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                    />
                    <p className="text-[10px] text-text-tertiary mt-1">Leave empty for no expiration</p>
                  </div>
                  <div className="flex items-end gap-2">
                    <button onClick={handleGenerateKey} disabled={generatingKey}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors shadow-sm">
                      {generatingKey ? <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Key size={14} />}
                      Generate
                    </button>
                    <button onClick={() => { setShowNewKeyForm(false); setNewKeyName(''); setNewKeyExpiry(''); }}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface rounded-lg border border-border transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Keys Table */}
            {apiKeysLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-emerald-500/20 border-t-emerald-500" />
              </div>
            ) : apiKeys.length === 0 ? (
              <div className="text-center py-8 text-text-tertiary">
                <Key size={28} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm">No API keys yet</p>
                <p className="text-xs mt-1">Generate a key to start using the External API</p>
              </div>
            ) : (
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-surface/50 border-b border-border">
                      <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Name</th>
                      <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Key</th>
                      <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Status</th>
                      <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Expires</th>
                      <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Last Used</th>
                      <th className="text-left px-4 py-2.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Created</th>
                      <th className="text-right px-4 py-2.5 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiKeys.map(k => (
                      <tr key={k.id} className="border-b border-border last:border-0 hover:bg-surface/30 transition-colors">
                        <td className="px-4 py-3">
                          <p className="text-xs font-medium text-text-primary">{k.name}</p>
                          {k.createdBy && <p className="text-[10px] text-text-tertiary">by {k.createdBy.name}</p>}
                        </td>
                        <td className="px-4 py-3">
                          <code className="text-xs font-mono text-text-secondary">{k.keyPrefix}••••••••</code>
                        </td>
                        <td className="px-4 py-3">
                          {k.isExpired ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-danger/10 text-danger border border-danger/20">
                              <AlertCircle size={10} /> Expired
                            </span>
                          ) : k.isActive ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                              <CheckCircle2 size={10} /> Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200">
                              Disabled
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-text-secondary">
                          {k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : <span className="text-text-tertiary">Never</span>}
                        </td>
                        <td className="px-4 py-3 text-xs text-text-secondary">
                          {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : <span className="text-text-tertiary">Never</span>}
                        </td>
                        <td className="px-4 py-3 text-xs text-text-secondary">
                          {new Date(k.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => handleToggleKey(k.id)} title={k.isActive ? 'Disable' : 'Enable'}
                              className={`p-1.5 rounded-lg transition-colors ${k.isActive ? 'text-success hover:bg-success/10' : 'text-gray-400 hover:bg-gray-100'}`}>
                              <Power size={13} />
                            </button>
                            <button onClick={() => handleRevokeKey(k.id, k.name)} title="Revoke"
                              className="p-1.5 rounded-lg text-danger hover:bg-danger/10 transition-colors">
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Usage Example */}
            <div className="mt-4 p-3 rounded-lg bg-zinc-50 border border-zinc-200">
              <p className="text-xs text-zinc-700 font-medium mb-2">Usage Example</p>
              <div className="bg-zinc-900 rounded-lg p-3 overflow-x-auto">
                <pre className="text-[11px] text-emerald-400 font-mono whitespace-pre">
{`# Get all employees with task data
curl -H "X-API-Key: your_api_key" \\
  https://monday.anistonav.com/api/external/employees

# Get a specific employee
curl -H "X-API-Key: your_api_key" \\
  https://monday.anistonav.com/api/external/employees/<user_id>`}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Future Integrations */}
      <h2 className="text-sm font-semibold text-text-secondary mb-3">More Integrations</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          { name: 'Slack', desc: 'Send task notifications to Slack channels', color: '#4A154B', icon: '#' },
          { name: 'Google Workspace', desc: 'Sync with Google Calendar and Drive', color: '#4285F4', icon: 'G' },
          { name: 'Jira', desc: 'Two-way sync with Jira issues', color: '#0052CC', icon: 'J' },
        ].map(int => (
          <div key={int.name} className="bg-white rounded-xl border border-border p-4 opacity-60">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-sm" style={{ backgroundColor: int.color }}>
                {int.icon}
              </div>
              <div>
                <p className="text-sm font-medium text-text-primary">{int.name}</p>
                <p className="text-[10px] text-text-tertiary">{int.desc}</p>
              </div>
            </div>
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-surface text-text-tertiary border border-border">Coming Soon</span>
          </div>
        ))}
      </div>
    </div>
  );
}
