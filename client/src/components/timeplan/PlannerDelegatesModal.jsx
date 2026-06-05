import React, { useEffect, useMemo, useState } from 'react';
import { X, UserCog, Plus, Trash2, ArrowRight } from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';

/**
 * Tier-1 surface to manage planner assistants — i.e. who may manage whose
 * planner. Each delegation is a per-owner `time_plan.edit_team` PermissionGrant
 * (delegate = grant.userId, owner = grant.resourceId), created/revoked through
 * the existing /api/permissions API (authority enforced server-side: only
 * Tier 1 can grant time_plan.edit_team).
 */
export default function PlannerDelegatesModal({ people, onClose, onChanged }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [delegateId, setDelegateId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const byId = useMemo(() => {
    const m = {};
    for (const p of people) m[p.id] = p;
    return m;
  }, [people]);

  function name(id) { return byId[id]?.name || 'Unknown user'; }

  async function load() {
    setLoading(true);
    try {
      const res = await api.get('/permissions?resourceType=time_plan');
      // The Axios interceptor merges the API envelope's inner `data` up onto
      // res.data, so the rows live at res.data.permissions.
      const raw = res.data.permissions || res.data.data?.permissions || [];
      const list = Array.isArray(raw) ? raw : [];
      setRows(list.filter((g) => g.action === 'edit_team' && (g.effect || 'grant') === 'grant' && g.isActive !== false && g.resourceId));
    } catch (err) {
      setError('Failed to load delegations.');
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function addDelegation(e) {
    e.preventDefault();
    setError('');
    if (!delegateId || !ownerId) return setError('Pick both an assistant and a planner owner.');
    if (delegateId === ownerId) return setError('Assistant and owner must be different people.');
    setSaving(true);
    try {
      await api.post('/permissions', {
        userId: delegateId,
        resourceType: 'time_plan',
        action: 'edit_team',
        effect: 'grant',
        resourceId: ownerId,
        reason: 'Time Planner assistant delegation',
      });
      setDelegateId('');
      setOwnerId('');
      await load();
      onChanged && onChanged();
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to add delegation.');
    } finally { setSaving(false); }
  }

  async function revoke(id) {
    if (!confirm('Revoke this planner assistant delegation?')) return;
    try {
      await api.delete(`/permissions/${id}`);
      await load();
      onChanged && onChanged();
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to revoke delegation.');
    }
  }

  return (
    <div className="fixed inset-0 z-[65] flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Manage planner assistants"
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-modal animate-slide-up sm:rounded-2xl sm:animate-scale-in"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h3 className="flex items-center gap-2 font-title text-base font-bold text-text-primary">
            <UserCog size={16} className="text-primary" /> Planner Assistants
          </h3>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-text-secondary hover:bg-surface" aria-label="Close"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <p className="mb-3 text-xs text-text-secondary">
            Grant a person permission to view and manage another user’s planner — e.g. a Tier 2 assistant managing a Tier 1’s schedule. Delegations are per-owner and revocable.
          </p>

          <form onSubmit={addDelegation} className="rounded-xl border border-border p-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr]">
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Assistant</span>
                <select value={delegateId} onChange={(e) => setDelegateId(e.target.value)} className="w-full rounded-lg border border-border bg-white px-2.5 py-2 text-sm focus:outline-none">
                  <option value="">Select person…</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <div className="hidden items-end justify-center pb-2 sm:flex"><ArrowRight size={16} className="text-text-tertiary" /></div>
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Can manage planner of</span>
                <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="w-full rounded-lg border border-border bg-white px-2.5 py-2 text-sm focus:outline-none">
                  <option value="">Select owner…</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            </div>
            {error && <p className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
            <div className="mt-3 flex justify-end">
              <button type="submit" disabled={saving} className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-600 disabled:opacity-50">
                <Plus size={13} /> {saving ? 'Adding…' : 'Add delegation'}
              </button>
            </div>
          </form>

          <div className="mt-5">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Current delegations</p>
            {loading ? (
              <p className="py-6 text-center text-xs text-text-tertiary">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-xs text-text-tertiary">No planner assistants assigned yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {rows.map((g) => (
                  <li key={g.id} className="flex items-center gap-2 px-3 py-2.5">
                    <Avatar name={name(g.userId)} src={byId[g.userId]?.avatar} size="sm" />
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
                      <span className="truncate font-medium text-text-primary">{name(g.userId)}</span>
                      <ArrowRight size={13} className="flex-shrink-0 text-text-tertiary" />
                      <span className="truncate text-text-secondary">{name(g.resourceId)}</span>
                    </span>
                    <button type="button" onClick={() => revoke(g.id)} className="rounded-md p-1 text-text-tertiary hover:text-danger" aria-label="Revoke delegation"><Trash2 size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
