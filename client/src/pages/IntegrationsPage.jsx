import React, { useState, useEffect } from 'react';
import {
  ExternalLink, Unplug, CheckCircle2, AlertCircle, RefreshCw, Calendar,
  Users, Download, Eye, ChevronDown, ChevronUp, Shield, Check, X,
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
  const [error, setError] = useState('');

  useEffect(() => {
    loadStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get('teams') === 'success' || params.get('teams') === 'error') {
      window.history.replaceState({}, '', window.location.pathname);
      loadStatus();
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
    if (!confirm('This will create accounts for all M365 users not yet in the system. Default password: Welcome@1234. Continue?')) return;
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

  if (loading) {
    return <div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" /></div>;
  }

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
            <p className="text-xs text-text-tertiary">Calendar sync, user management, notifications</p>
          </div>
          <div className="flex items-center gap-2">
            {teamsStatus?.connected ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-success/10 text-success border border-success/20">
                <CheckCircle2 size={12} /> Connected
              </span>
            ) : teamsStatus?.configured ? (
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

        {/* Body */}
        <div className="p-5">
          {!teamsStatus?.configured ? (
            <div className="p-4 rounded-lg bg-surface/50 border border-border">
              <p className="text-sm font-medium text-text-primary mb-2">Setup Required</p>
              <p className="text-xs text-text-tertiary mb-3">
                Add your Azure AD credentials to <code className="bg-white px-1.5 py-0.5 rounded border border-border text-[10px] font-mono">server/.env</code>:
              </p>
              <div className="bg-zinc-900 text-zinc-300 rounded-lg p-3 text-xs font-mono space-y-1">
                <p>TEAMS_CLIENT_ID=your-client-id</p>
                <p>TEAMS_CLIENT_SECRET=your-secret</p>
                <p>TEAMS_TENANT_ID=your-tenant-id</p>
                <p>TEAMS_REDIRECT_URI=http://localhost:5000/api/teams/callback</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Features */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { icon: Calendar, label: 'Calendar Sync', desc: 'Auto-create events for tasks' },
                  { icon: Users, label: 'User Sync', desc: 'Import employees from M365' },
                  { icon: Shield, label: 'SSO Ready', desc: 'OAuth 2.0 authentication' },
                ].map(f => (
                  <div key={f.label} className="flex items-start gap-2.5 p-3 rounded-lg bg-surface/50 border border-border">
                    <f.icon size={16} className="text-primary mt-0.5" />
                    <div>
                      <p className="text-xs font-medium text-text-primary">{f.label}</p>
                      <p className="text-[10px] text-text-tertiary">{f.desc}</p>
                    </div>
                  </div>
                ))}
              </div>

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
          )}
        </div>

        {/* User Sync Section (Admin only) */}
        {isAdmin && teamsStatus?.configured && (
          <div className="border-t border-border p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  <Users size={15} /> User Sync from Microsoft 365
                </h3>
                <p className="text-xs text-text-tertiary mt-0.5">Import employees from your M365 tenant into Aniston Hub</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handlePreviewUsers} disabled={previewing}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface rounded-lg border border-border transition-colors">
                  {previewing ? <div className="w-3 h-3 border-2 border-primary/20 border-t-primary rounded-full animate-spin" /> : <Eye size={13} />}
                  Preview Users
                </button>
                <button onClick={handleSyncUsers} disabled={syncing}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary-hover transition-colors shadow-sm">
                  {syncing ? <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : <Download size={13} />}
                  Sync Users Now
                </button>
              </div>
            </div>

            {/* Preview Users */}
            {showPreview && previewUsers && (
              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium text-text-secondary">{previewUsers.total || previewUsers.users?.length || 0} users found in M365</p>
                  <button onClick={() => setShowPreview(false)} className="text-text-tertiary hover:text-text-secondary"><X size={14} /></button>
                </div>
                <div className="bg-surface/50 rounded-lg border border-border max-h-[200px] overflow-y-auto">
                  {(previewUsers.users || []).map((u, i) => (
                    <div key={i} className="flex items-center gap-3 px-3 py-2 border-b border-border/50 last:border-b-0">
                      <Avatar name={u.name} size="xs" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-text-primary truncate">{u.name}</p>
                        <p className="text-[10px] text-text-tertiary truncate">{u.email}</p>
                      </div>
                      {u.department && <span className="text-[10px] px-1.5 py-0.5 bg-white rounded border border-border text-text-tertiary">{u.department}</span>}
                      {u.jobTitle && <span className="text-[10px] text-text-tertiary">{u.jobTitle}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Sync Results */}
            {syncResult && (
              <div className="animate-fade-in">
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="px-3 py-2 rounded-lg bg-success/5 border border-success/20 text-center">
                    <p className="text-lg font-bold text-success">{syncResult.created?.length || 0}</p>
                    <p className="text-[10px] text-text-tertiary">New Users Created</p>
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
                    <p className="text-xs font-medium text-success mb-2">New users created (default password: Welcome@1234)</p>
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
