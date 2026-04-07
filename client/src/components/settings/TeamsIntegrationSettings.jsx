import React, { useState, useEffect } from 'react';
import { ExternalLink, Unplug, CheckCircle2, AlertCircle, RefreshCw, Calendar } from 'lucide-react';
import api from '../../services/api';

export default function TeamsIntegrationSettings() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    loadStatus();
    // Check URL params for OAuth callback result
    const params = new URLSearchParams(window.location.search);
    if (params.get('teams') === 'success') {
      loadStatus();
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (params.get('teams') === 'error') {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  async function loadStatus() {
    try {
      const res = await api.get('/teams/status');
      setStatus(res.data?.data || res.data);
    } catch {
      setStatus({ configured: false, connected: false });
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect() {
    try {
      const res = await api.get('/teams/auth');
      const authUrl = res.data?.data?.authUrl || res.data?.authUrl;
      if (authUrl) {
        window.location.href = authUrl;
      }
    } catch (err) {
      console.error('Failed to start Teams auth:', err);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect Teams integration? Calendar sync will stop.')) return;
    setDisconnecting(true);
    try {
      await api.post('/teams/disconnect');
      setStatus(prev => ({ ...prev, connected: false, teamsUserId: null }));
    } catch (err) {
      console.error('Failed to disconnect:', err);
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="widget-card">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          <span className="text-sm text-text-tertiary">Checking Teams status...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="widget-card">
      <h3 className="text-base font-semibold text-text-primary mb-3 flex items-center gap-2">
        <Calendar size={18} className="text-primary" />
        Microsoft Teams Integration
      </h3>

      {!status?.configured ? (
        /* Not configured */
        <div className="flex items-start gap-3 p-3 rounded-lg bg-surface/50 border border-border">
          <AlertCircle size={18} className="text-warning mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-text-primary">Not Configured</p>
            <p className="text-xs text-text-tertiary mt-1">
              Teams calendar integration requires Azure AD credentials. Add <code className="bg-surface px-1 py-0.5 rounded text-[10px]">TEAMS_CLIENT_ID</code>, <code className="bg-surface px-1 py-0.5 rounded text-[10px]">TEAMS_CLIENT_SECRET</code>, and <code className="bg-surface px-1 py-0.5 rounded text-[10px]">TEAMS_TENANT_ID</code> to your server .env file.
            </p>
          </div>
        </div>
      ) : status?.connected ? (
        /* Connected */
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-success/5 border border-success/20">
            <CheckCircle2 size={18} className="text-success flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-text-primary">Connected to Microsoft Teams</p>
              <p className="text-xs text-text-tertiary mt-0.5">
                Calendar events will sync automatically when tasks are assigned or scheduled.
                {status.teamsUserId && <span className="ml-1 font-mono text-[10px]">ID: {status.teamsUserId.slice(0, 8)}...</span>}
              </p>
            </div>
          </div>

          {status.expired && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-warning/10 text-warning text-xs font-medium">
              <RefreshCw size={12} /> Token expired — reconnect to refresh
            </div>
          )}

          <div className="flex items-center gap-2">
            <button onClick={handleDisconnect} disabled={disconnecting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-danger hover:bg-danger/5 rounded-lg border border-danger/20 transition-colors">
              {disconnecting ? <div className="w-3.5 h-3.5 border-2 border-danger/20 border-t-danger rounded-full animate-spin" /> : <Unplug size={14} />}
              Disconnect
            </button>
            {status.expired && (
              <button onClick={handleConnect}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary hover:bg-primary/5 rounded-lg border border-primary/20 transition-colors">
                <RefreshCw size={14} /> Reconnect
              </button>
            )}
          </div>
        </div>
      ) : (
        /* Not connected */
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Connect your Microsoft Teams account to sync task assignments and schedules to your Teams calendar.
          </p>
          <div className="flex flex-wrap gap-2 text-xs text-text-tertiary">
            <span className="px-2 py-1 bg-surface rounded-full">Auto-create calendar events</span>
            <span className="px-2 py-1 bg-surface rounded-full">Task reminders in Teams</span>
            <span className="px-2 py-1 bg-surface rounded-full">Schedule sync</span>
          </div>
          <button onClick={handleConnect}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover transition-colors shadow-sm">
            <ExternalLink size={15} /> Connect Microsoft Teams
          </button>
        </div>
      )}
    </div>
  );
}
