import React, { useState, useEffect } from 'react';
import {
  ExternalLink, Unplug, CheckCircle2, AlertCircle, RefreshCw, Calendar,
  Users, Download, Eye, EyeOff, ChevronDown, ChevronUp, Shield, Check, X,
  Settings, Save, TestTube2, Edit3, Trash2, ToggleLeft, ToggleRight,
  Lock, Key, Globe, Link2,
} from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/common/Avatar';

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

  useEffect(() => {
    loadStatus();
    if (isAdmin) loadConfig();
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
        redirectUri: data.redirectUri || `${window.location.origin}/api/teams/callback`,
        ssoRedirectUri: data.ssoRedirectUri || `${window.location.origin}/api/auth/microsoft/callback`,
        ssoEnabled: data.ssoEnabled || false,
      });
    } catch {
      setConfigData(null);
    } finally {
      setConfigLoading(false);
    }
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
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-danger/10 text-danger text-sm mb-4 animate-fade-in">
          <AlertCircle size={16} /> {error}
          <button onClick={() => setError('')} className="ml-auto"><X size={14} /></button>
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
