import React, { useState, useEffect } from 'react';
import { LayoutGrid, Check, Plus, X, Search, Users, Zap } from 'lucide-react';
import Modal from '../common/Modal';
import api from '../../services/api';
import WorkspaceSetupModal from './WorkspaceSetupModal';

const COLORS = ['#0073ea', '#00c875', '#fdab3d', '#e2445c', '#a25ddc', '#037f4c', '#579bfc', '#ff642e'];

export default function WorkspaceAssignModal({ user, onClose, onUpdated }) {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newWs, setNewWs] = useState({ name: '', description: '', color: '#0073ea' });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [setupWorkspace, setSetupWorkspace] = useState(null);

  useEffect(() => { loadWorkspaces(); }, []);

  async function loadWorkspaces() {
    try {
      const res = await api.get('/workspaces');
      setWorkspaces(res.data.workspaces || res.data.data?.workspaces || []);
    } catch { }
    setLoading(false);
  }

  async function assignWorkspace(workspaceId) {
    setSaving(workspaceId);
    try {
      await api.post(`/workspaces/${workspaceId}/members`, { userIds: [user.id] });
      await loadWorkspaces();
      onUpdated?.();
      // Auto-open setup modal to choose template & add tasks
      const ws = workspaces.find(w => w.id === workspaceId);
      if (ws) setSetupWorkspace(ws);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to assign workspace.');
    }
    setSaving(null);
  }

  async function removeFromWorkspace(workspaceId) {
    setSaving(workspaceId);
    try {
      await api.delete(`/workspaces/${workspaceId}/members/${user.id}`);
      await loadWorkspaces();
      onUpdated?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to remove from workspace.');
    }
    setSaving(null);
  }

  async function createAndAssign() {
    if (!newWs.name.trim()) { setError('Workspace name is required.'); return; }
    setCreating(true);
    setError('');
    try {
      const res = await api.post('/workspaces', newWs);
      const created = res.data.workspace || res.data.data?.workspace;
      if (created) {
        await api.post(`/workspaces/${created.id}/members`, { userIds: [user.id] });
      }
      setNewWs({ name: '', description: '', color: '#0073ea' });
      setShowCreate(false);
      await loadWorkspaces();
      onUpdated?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create workspace.');
    }
    setCreating(false);
  }

  const filtered = workspaces.filter(w =>
    w.name.toLowerCase().includes(search.toLowerCase())
  );

  function isAssigned(ws) {
    return ws.workspaceMembers?.some(m => m.id === user.id);
  }

  return (
    <>
    <Modal isOpen onClose={setupWorkspace ? () => {} : onClose} title={`Assign Workspace — ${user.name}`} size="md">
      <div className="space-y-4">
        {error && (
          <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg flex items-center gap-2">
            <X size={14} /> {error}
          </div>
        )}

        {/* Search */}
        <div className="flex items-center gap-2 bg-surface border border-border rounded-lg px-3 py-2">
          <Search size={14} className="text-text-tertiary" />
          <input
            type="text"
            placeholder="Search workspaces..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-transparent border-none outline-none text-sm w-full"
          />
        </div>

        {/* Workspace list */}
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-text-tertiary text-sm">
            <LayoutGrid size={32} className="mx-auto mb-2 opacity-30" />
            No workspaces found
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
            {filtered.map(ws => {
              const assigned = isAssigned(ws);
              return (
                <div key={ws.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${assigned ? 'border-primary/30 bg-primary/5' : 'border-border hover:border-border-hover bg-white'}`}>
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-white text-sm font-bold"
                    style={{ backgroundColor: ws.color || '#0073ea' }}>
                    {ws.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{ws.name}</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      <Users size={11} className="text-text-tertiary" />
                      <span className="text-xs text-text-tertiary">{ws.workspaceMembers?.length || 0} members</span>
                      {ws.boards?.length > 0 && (
                        <span className="text-xs text-text-tertiary ml-1">· {ws.boards.length} boards</span>
                      )}
                    </div>
                  </div>
                  {assigned ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-primary font-medium flex items-center gap-1">
                        <Check size={12} /> Assigned
                      </span>
                      <button
                        onClick={() => removeFromWorkspace(ws.id)}
                        disabled={saving === ws.id}
                        className="text-xs text-text-tertiary hover:text-danger ml-2 transition-colors"
                      >
                        {saving === ws.id ? '...' : 'Remove'}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => assignWorkspace(ws.id)}
                      disabled={saving === ws.id}
                      className="px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-md hover:bg-primary-600 disabled:opacity-50 transition-colors"
                    >
                      {saving === ws.id ? '...' : 'Assign'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Create new workspace section */}
        {showCreate ? (
          <div className="border border-border rounded-lg p-4 space-y-3 bg-surface/50">
            <p className="text-sm font-medium text-text-primary">Create New Workspace</p>
            <input
              type="text"
              placeholder="Workspace name *"
              value={newWs.name}
              onChange={e => setNewWs(w => ({ ...w, name: e.target.value }))}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={newWs.description}
              onChange={e => setNewWs(w => ({ ...w, description: e.target.value }))}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
            <div>
              <p className="text-xs text-text-secondary mb-1.5">Color</p>
              <div className="flex gap-2">
                {COLORS.map(c => (
                  <button key={c} onClick={() => setNewWs(w => ({ ...w, color: c }))}
                    className={`w-6 h-6 rounded-full transition-all ${newWs.color === c ? 'ring-2 ring-offset-1 ring-text-primary scale-110' : ''}`}
                    style={{ backgroundColor: c }} />
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowCreate(false)} className="flex-1 px-3 py-2 text-sm border border-border rounded-lg hover:bg-surface transition-colors">
                Cancel
              </button>
              <button onClick={createAndAssign} disabled={creating}
                className="flex-1 px-3 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors">
                {creating ? 'Creating...' : 'Create & Assign'}
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 w-full px-3 py-2.5 border border-dashed border-border rounded-lg text-sm text-text-secondary hover:text-primary hover:border-primary transition-all">
            <Plus size={15} /> Create new workspace & assign
          </button>
        )}
      </div>
    </Modal>

    {/* Setup modal opens automatically after assigning workspace */}
    {setupWorkspace && (
      <WorkspaceSetupModal
        workspace={setupWorkspace}
        onClose={() => { setSetupWorkspace(null); onClose(); }}
        onDone={() => { setSetupWorkspace(null); onUpdated?.(); onClose(); }}
      />
    )}
  </>
  );
}
