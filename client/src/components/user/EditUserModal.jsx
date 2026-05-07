import React, { useState, useEffect } from 'react';
import Modal from '../common/Modal';
import Avatar from '../common/Avatar';
import DepartmentSelect from '../common/DepartmentSelect';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import {
  TIER_1, TIER_2, TIER_3, TIER_4,
  resolveTier, tierLabel, tiersGrantableBy,
} from '../../utils/tiers';

// Map a tier value to the legacy (role, isSuperAdmin) pair the API still
// accepts during the compatibility window. The User-model `beforeSave` hook
// keeps tier and legacy fields in lockstep on the server side.
function legacyFromTier(tier) {
  switch (tier) {
    case TIER_1: return { role: 'admin', isSuperAdmin: true };
    case TIER_2: return { role: 'admin', isSuperAdmin: false };
    case TIER_3: return { role: 'assistant_manager', isSuperAdmin: false };
    case TIER_4: return { role: 'member', isSuperAdmin: false };
    default:     return { role: 'member', isSuperAdmin: false };
  }
}

// Build the diff to PUT /users/:id. Sending only the diff keeps the audit
// log meaningful and avoids triggering hierarchy re-balancing on no-op fields.
// hierarchyLevel is intentionally excluded — managed elsewhere.
function buildDiff(form, user) {
  const diff = {};
  const trimOrNull = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

  if ((user.name || '') !== form.name) diff.name = form.name.trim();
  if ((user.email || '').toLowerCase() !== form.email.trim().toLowerCase()) {
    diff.email = form.email.trim();
  }
  // Tier change → translate to (role, isSuperAdmin) for the compat API.
  const currentTier = resolveTier(user);
  if (form.tier !== currentTier) {
    Object.assign(diff, legacyFromTier(form.tier));
  }
  if ((user.department || '') !== (form.department || '')) {
    diff.department = trimOrNull(form.department);
  }
  if ((user.designation || '') !== (form.designation || '')) {
    diff.designation = trimOrNull(form.designation);
  }
  if (Boolean(user.isActive) !== Boolean(form.isActive)) {
    diff.isActive = Boolean(form.isActive);
  }
  return diff;
}

export default function EditUserModal({ isOpen, onClose, user, onUpdated, isAdmin, onToast }) {
  const { user: actor } = useAuth();
  const [form, setForm] = useState({
    name: '', email: '', tier: TIER_4, department: '', designation: '',
    isActive: true,
  });
  const [departmentMode, setDepartmentMode] = useState('empty');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) {
      setForm({
        name: user.name || '',
        email: user.email || '',
        tier: resolveTier(user),
        department: user.department || '',
        designation: user.designation || '',
        isActive: user.isActive !== false,
      });
      setError('');
    }
  }, [user]);

  // Privileged actors (Tier 1 / Tier 2) can change the tier/status/email of
  // a target. Lower tiers see only the safe-profile slice — server enforces
  // the same.
  const canEditPrivileged = !!isAdmin;

  // Build the tier dropdown. Always include the user's CURRENT tier (so the
  // form can render their state) plus every tier the actor is allowed to
  // grant. Tier 3/4 actors get only the read-only current-tier label.
  const grantable = tiersGrantableBy(actor);
  const currentTier = resolveTier(user);
  const tierOptions = Array.from(new Set([
    currentTier,
    ...grantable.map(g => g.value),
  ]))
    .sort((a, b) => a - b)
    .map(t => ({ value: t, label: tierLabel(t) }));

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!form.email.trim()) {
      setError('Email is required.');
      return;
    }
    if (departmentMode === 'other' && !form.department.trim()) {
      setError('Please enter a custom department or pick "Other" again to clear it.');
      return;
    }

    const diff = buildDiff(form, user);
    if (Object.keys(diff).length === 0) {
      onClose();
      return;
    }

    try {
      setLoading(true);
      setError('');
      const res = await api.put(`/users/${user.id}`, diff);
      const updated = res.data?.data?.user || res.data?.user || null;
      if (typeof onUpdated === 'function') await onUpdated(updated);
      if (typeof onToast === 'function') onToast({ type: 'success', message: 'User updated.' });
      onClose();
    } catch (err) {
      const msg = err.response?.data?.message
        || err.response?.data?.errors?.[0]?.msg
        || 'Failed to update user.';
      setError(msg);
      if (typeof onToast === 'function') onToast({ type: 'error', message: msg });
    } finally {
      setLoading(false);
    }
  }

  if (!user) return null;

  const targetTier = resolveTier(user);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit User" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Header — selected user identity */}
        <div className="flex items-center gap-3 px-3 py-2 bg-gray-50 dark:bg-zinc-800/40 rounded-lg border border-gray-100 dark:border-zinc-700">
          <Avatar name={user.name} size="md" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary truncate">{user.name}</p>
            <p className="text-xs text-text-tertiary truncate">{user.email}</p>
          </div>
          <span className={`ml-auto text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full font-semibold ${
            targetTier === TIER_1 ? 'bg-red-50 text-red-700' :
            targetTier === TIER_2 ? 'bg-purple-50 text-purple-700' :
            targetTier === TIER_3 ? 'bg-cyan-50 text-cyan-700' :
                                    'bg-green-50 text-green-700'
          }`}>
            {tierLabel(targetTier)}
          </span>
        </div>

        {error && (
          <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>
        )}

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Full Name *</label>
          <input
            type="text"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Email Address *</label>
          <input
            type="email"
            value={form.email}
            onChange={e => setForm({ ...form, email: e.target.value })}
            disabled={!canEditPrivileged}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary bg-white disabled:opacity-50 disabled:cursor-not-allowed"
          />
          {!canEditPrivileged && <p className="text-xs text-text-tertiary mt-1">Only Tier 1 / Tier 2 can change emails</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Tier</label>
          <select
            value={form.tier}
            onChange={e => setForm({ ...form, tier: Number(e.target.value) })}
            disabled={!canEditPrivileged || tierOptions.length <= 1}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary bg-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {tierOptions.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          {!canEditPrivileged && <p className="text-xs text-text-tertiary mt-1">Only Tier 1 / Tier 2 can change tiers</p>}
          {canEditPrivileged && tierOptions.length <= 1 && (
            <p className="text-xs text-text-tertiary mt-1">No higher tier is grantable from your tier.</p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Department</label>
            <DepartmentSelect
              key={user.id}
              value={form.department}
              onChange={dept => setForm({ ...form, department: dept })}
              onModeChange={setDepartmentMode}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Designation</label>
            <input
              type="text"
              value={form.designation}
              onChange={e => setForm({ ...form, designation: e.target.value })}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              placeholder="Software Engineer"
            />
          </div>
        </div>

        {canEditPrivileged && (
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Status</label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setForm({ ...form, isActive: true })}
                className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors ${
                  form.isActive
                    ? 'bg-green-50 text-green-700 border-green-200'
                    : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                }`}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5 align-middle" />
                Active
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, isActive: false })}
                className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors ${
                  !form.isActive
                    ? 'bg-gray-100 text-gray-700 border-gray-300'
                    : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                }`}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400 mr-1.5 align-middle" />
                Deactivated
              </button>
              <p className="text-xs text-text-tertiary">
                Manual status changes survive the next Microsoft sync.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface rounded-lg transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={loading} className="px-5 py-2 text-sm font-medium text-white bg-primary hover:bg-primary-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {loading ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
