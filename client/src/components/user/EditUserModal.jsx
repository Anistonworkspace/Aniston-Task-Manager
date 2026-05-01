import React, { useState, useEffect } from 'react';
import Modal from '../common/Modal';
import Avatar from '../common/Avatar';
import api from '../../services/api';
import { HIERARCHY_LEVELS } from '../../utils/constants';

const ROLES = [
  { value: 'member', label: 'Member' },
  { value: 'assistant_manager', label: 'Assistant Manager' },
  { value: 'manager', label: 'Manager' },
  { value: 'admin', label: 'Admin' },
];

// Build the payload that the PUT /users/:id endpoint accepts. Sending only
// the diff keeps the audit log meaningful and avoids triggering hierarchy
// re-balancing logic on no-op fields.
function buildDiff(form, user) {
  const diff = {};
  const trimOrNull = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

  if ((user.name || '') !== form.name) diff.name = form.name.trim();
  if ((user.email || '').toLowerCase() !== form.email.trim().toLowerCase()) {
    diff.email = form.email.trim();
  }
  if ((user.role || 'member') !== form.role) diff.role = form.role;
  if ((user.hierarchyLevel || 'member') !== form.hierarchyLevel) {
    diff.hierarchyLevel = form.hierarchyLevel;
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
  const [form, setForm] = useState({
    name: '', email: '', role: 'member', department: '', designation: '',
    hierarchyLevel: 'member', isActive: true,
  });
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) {
      setForm({
        name: user.name || '',
        email: user.email || '',
        role: user.role || 'member',
        department: user.department || '',
        designation: user.designation || '',
        hierarchyLevel: user.hierarchyLevel || 'member',
        isActive: user.isActive !== false,
      });
      setError('');
    }
  }, [user]);

  // Pull the existing department list so admins pick from the same source
  // of truth as the Org Chart Department view, with a free-text fallback for
  // ad-hoc values still allowed by the backend.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    api.get('/departments')
      .then(res => {
        if (cancelled) return;
        const list = res.data?.departments || res.data?.data?.departments || res.data || [];
        setDepartments(Array.isArray(list) ? list : []);
      })
      .catch(() => { if (!cancelled) setDepartments([]); });
    return () => { cancelled = true; };
  }, [isOpen]);

  // Members of the modal can never see the role/status/hierarchy controls
  // for someone they do not have authority over — that decision is also
  // enforced server-side, but keeping the UI clean prevents misleading
  // form interactions for managers.
  const canEditPrivileged = !!isAdmin;
  const isSuperAdminTarget = !!user?.isSuperAdmin;

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
          {isSuperAdminTarget && (
            <span className="ml-auto text-[10px] uppercase tracking-wider px-2 py-0.5 bg-red-50 text-red-700 rounded-full font-semibold">
              Super Admin
            </span>
          )}
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
          {!canEditPrivileged && <p className="text-xs text-text-tertiary mt-1">Only admins can change emails</p>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Role</label>
            <select
              value={form.role}
              onChange={e => setForm({ ...form, role: e.target.value })}
              disabled={!canEditPrivileged}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary bg-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {ROLES.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
            {!canEditPrivileged && <p className="text-xs text-text-tertiary mt-1">Only admins can change roles</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Hierarchy Level</label>
            <select
              value={form.hierarchyLevel}
              onChange={e => setForm({ ...form, hierarchyLevel: e.target.value })}
              disabled={!canEditPrivileged}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary bg-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {HIERARCHY_LEVELS.map(h => (
                <option key={h.value} value={h.value}>{h.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Department</label>
            <input
              type="text"
              list="edit-user-department-list"
              value={form.department}
              onChange={e => setForm({ ...form, department: e.target.value })}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              placeholder="Engineering"
            />
            <datalist id="edit-user-department-list">
              {departments.map(d => (
                <option key={d.id || d.name} value={d.name} />
              ))}
            </datalist>
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
