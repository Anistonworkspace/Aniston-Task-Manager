import React, { useState, useEffect } from 'react';
import { X, Plus, Zap, Trash2, ToggleLeft, ToggleRight, AlertCircle, Check } from 'lucide-react';
import api from '../../services/api';

const TRIGGERS = [
  { value: 'status_changed', label: 'When status changes', hasValue: true, valueLabel: 'To status', valueOptions: ['not_started', 'working_on_it', 'stuck', 'done'] },
  { value: 'task_created', label: 'When task is created' },
  { value: 'task_assigned', label: 'When task is assigned' },
  { value: 'due_date_arrived', label: 'When due date arrives' },
];

const ACTIONS = [
  { value: 'notify_user', label: 'Notify someone', hasConfig: true },
  { value: 'change_status', label: 'Change status to', hasConfig: true },
  { value: 'change_priority', label: 'Change priority to', hasConfig: true },
  { value: 'assign_to', label: 'Assign to person', hasConfig: true },
  { value: 'send_notification', label: 'Send notification', hasConfig: true },
];

export default function AutomationsPanel({ boardId, onClose }) {
  const [automations, setAutomations] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', trigger: 'status_changed', triggerValue: '', action: 'notify_user', actionConfig: {} });
  const [users, setUsers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState(null);

  useEffect(() => { loadAutomations(); loadUsers(); }, []);

  async function loadAutomations() {
    try {
      const res = await api.get(`/automations?boardId=${boardId}`);
      setAutomations(res.data.automations || res.data.data?.automations || []);
    } catch {}
  }

  async function loadUsers() {
    try { const res = await api.get('/auth/users'); setUsers(res.data.users || res.data || []); } catch {}
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await api.post('/automations', { ...form, boardId });
      setShowAdd(false);
      setForm({ name: '', trigger: 'status_changed', triggerValue: '', action: 'notify_user', actionConfig: {} });
      loadAutomations();
      setFlash('Automation created!');
      setTimeout(() => setFlash(null), 2000);
    } catch (err) {
      setFlash(err.response?.data?.message || 'Failed');
    } finally { setSaving(false); }
  }

  async function handleToggle(id, isActive) {
    try { await api.put(`/automations/${id}`, { isActive: !isActive }); loadAutomations(); } catch {}
  }

  async function handleDelete(id) {
    try { await api.delete(`/automations/${id}`); loadAutomations(); } catch {}
  }

  const triggerCfg = TRIGGERS.find(t => t.value === form.trigger);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-modal w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <Zap size={18} className="text-warning" /> Automations
          </h2>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowAdd(!showAdd)} className="flex items-center gap-1 px-3 py-1.5 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary-hover">
              <Plus size={13} /> Add
            </button>
            <button onClick={onClose} className="p-1 rounded-md hover:bg-surface text-text-secondary"><X size={18} /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {flash && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-success/10 text-success text-sm animate-fade-in">
              <Check size={14} /> {flash}
            </div>
          )}

          {/* Add Form */}
          {showAdd && (
            <form onSubmit={handleCreate} className="p-4 rounded-lg border border-primary/20 bg-primary/5 space-y-3">
              <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Automation name (e.g., Notify on completion)" className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:border-primary" autoFocus />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-medium text-text-secondary mb-1 block">When...</label>
                  <select value={form.trigger} onChange={e => setForm(f => ({ ...f, trigger: e.target.value, triggerValue: '' }))}
                    className="w-full px-2 py-1.5 rounded border border-border text-xs bg-white">
                    {TRIGGERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-medium text-text-secondary mb-1 block">Do...</label>
                  <select value={form.action} onChange={e => setForm(f => ({ ...f, action: e.target.value, actionConfig: {} }))}
                    className="w-full px-2 py-1.5 rounded border border-border text-xs bg-white">
                    {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </select>
                </div>
              </div>
              {triggerCfg?.hasValue && (
                <select value={form.triggerValue} onChange={e => setForm(f => ({ ...f, triggerValue: e.target.value }))}
                  className="w-full px-2 py-1.5 rounded border border-border text-xs bg-white">
                  <option value="">Any status</option>
                  {(triggerCfg.valueOptions || []).map(v => <option key={v} value={v}>{v.replace('_', ' ')}</option>)}
                </select>
              )}
              {(form.action === 'change_status') && (
                <select value={form.actionConfig.targetStatus || ''} onChange={e => setForm(f => ({ ...f, actionConfig: { ...f.actionConfig, targetStatus: e.target.value } }))}
                  className="w-full px-2 py-1.5 rounded border border-border text-xs bg-white">
                  <option value="">Select target status</option>
                  {['not_started', 'working_on_it', 'stuck', 'done'].map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                </select>
              )}
              {(form.action === 'change_priority') && (
                <select value={form.actionConfig.targetPriority || ''} onChange={e => setForm(f => ({ ...f, actionConfig: { ...f.actionConfig, targetPriority: e.target.value } }))}
                  className="w-full px-2 py-1.5 rounded border border-border text-xs bg-white">
                  <option value="">Select priority</option>
                  {['low', 'medium', 'high', 'critical'].map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              )}
              {(form.action === 'notify_user' || form.action === 'assign_to' || form.action === 'send_notification') && (
                <select value={form.actionConfig.targetUserId || ''} onChange={e => setForm(f => ({ ...f, actionConfig: { ...f.actionConfig, targetUserId: e.target.value } }))}
                  className="w-full px-2 py-1.5 rounded border border-border text-xs bg-white">
                  <option value="">Select person</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              )}
              {(form.action === 'notify_user' || form.action === 'send_notification') && (
                <input type="text" value={form.actionConfig.notifyMessage || ''} onChange={e => setForm(f => ({ ...f, actionConfig: { ...f.actionConfig, notifyMessage: e.target.value } }))}
                  placeholder="Notification message" className="w-full px-2 py-1.5 rounded border border-border text-xs" />
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-xs text-text-secondary hover:bg-surface rounded">Cancel</button>
                <button type="submit" disabled={saving} className="px-3 py-1.5 text-xs bg-primary text-white rounded font-medium disabled:opacity-50">
                  {saving ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>
          )}

          {/* Automation List */}
          {automations.length === 0 && !showAdd ? (
            <div className="text-center py-10">
              <Zap size={32} className="mx-auto text-text-tertiary mb-2" />
              <p className="text-sm text-text-secondary">No automations yet</p>
              <p className="text-xs text-text-tertiary mt-1">Create rules like "When status → done, notify manager"</p>
            </div>
          ) : automations.map(auto => (
            <div key={auto.id} className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${auto.isActive ? 'border-border bg-white' : 'border-border/50 bg-surface/30 opacity-60'}`}>
              <Zap size={14} className={auto.isActive ? 'text-warning' : 'text-text-tertiary'} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{auto.name}</p>
                <p className="text-[10px] text-text-tertiary">
                  When: {auto.trigger.replace('_', ' ')}{auto.triggerValue ? ` → ${auto.triggerValue.replace('_', ' ')}` : ''} → {auto.action.replace('_', ' ')}
                </p>
              </div>
              <button onClick={() => handleToggle(auto.id, auto.isActive)} className="text-text-tertiary hover:text-primary" title={auto.isActive ? 'Disable' : 'Enable'}>
                {auto.isActive ? <ToggleRight size={20} className="text-success" /> : <ToggleLeft size={20} />}
              </button>
              <button onClick={() => handleDelete(auto.id)} className="text-text-tertiary hover:text-danger"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
