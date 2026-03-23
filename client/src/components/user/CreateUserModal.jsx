import React, { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import Modal from '../common/Modal';
import api from '../../services/api';

const ROLES = [
  { value: 'member', label: 'Member', desc: 'Can view & update assigned tasks' },
  { value: 'assistant_manager', label: 'Assistant Manager', desc: 'Manager + director plan management & PA duties' },
  { value: 'manager', label: 'Manager', desc: 'Can manage boards, tasks & members' },
  { value: 'admin', label: 'Admin', desc: 'Full access to everything' },
];

export default function CreateUserModal({ isOpen, onClose, onCreated, creatorRole }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'member', department: '', designation: '', departmentId: '', workspaceId: '' });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [departments, setDepartments] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);

  useEffect(() => {
    if (isOpen) {
      api.get('/departments').then(res => {
        setDepartments(res.data.departments || res.data.data?.departments || []);
      }).catch(() => {});
      api.get('/workspaces').then(res => {
        setWorkspaces(res.data.workspaces || res.data.data?.workspaces || []);
      }).catch(() => {});
    }
  }, [isOpen]);

  const availableRoles = creatorRole === 'admin' ? ROLES : ROLES.filter(r => r.value === 'member');

  function resetForm() {
    setForm({ name: '', email: '', password: '', role: 'member', department: '', designation: '', departmentId: '', workspaceId: '' });
    setError('');
    setShowPass(false);
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || !form.password.trim()) {
      setError('Name, email, and password are required.');
      return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(form.email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    const pwdErrors = [];
    if (form.password.length < 8) pwdErrors.push('at least 8 characters');
    if (!/[A-Z]/.test(form.password)) pwdErrors.push('an uppercase letter');
    if (!/[a-z]/.test(form.password)) pwdErrors.push('a lowercase letter');
    if (!/[0-9]/.test(form.password)) pwdErrors.push('a number');
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(form.password)) pwdErrors.push('a special character');
    if (pwdErrors.length > 0) {
      setError(`Password must contain: ${pwdErrors.join(', ')}.`);
      return;
    }

    try {
      setLoading(true);
      setError('');
      const { default: api } = await import('../../services/api');
      const res = await api.post('/users', {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        department: form.department.trim() || undefined,
        designation: form.designation.trim() || undefined,
      });
      // Assign to workspace if selected
      if (form.workspaceId) {
        const newUserId = res.data?.data?.user?.id || res.data?.user?.id;
        if (newUserId) {
          await api.post(`/workspaces/${form.workspaceId}/members`, { userIds: [newUserId] }).catch(() => {});
        }
      }
      resetForm();
      onCreated();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create user.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create New User" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>
        )}

        {/* Name */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Full Name *</label>
          <input
            type="text"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            placeholder="John Doe"
          />
        </div>

        {/* Email */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Email Address *</label>
          <input
            type="email"
            value={form.email}
            onChange={e => setForm({ ...form, email: e.target.value })}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            placeholder="john@aniston.com"
          />
        </div>

        {/* Password */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Password *</label>
          <div className="relative">
            <input
              type={showPass ? 'text' : 'password'}
              value={form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              className="w-full px-3 py-2 pr-10 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              placeholder="Min 6 characters"
            />
            <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
              {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        {/* Role & Department row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Role</label>
            <select
              value={form.role}
              onChange={e => setForm({ ...form, role: e.target.value })}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary bg-white"
            >
              {availableRoles.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Department</label>
            {departments.length > 0 ? (
              <select
                value={form.departmentId || ''}
                onChange={e => {
                  const dept = departments.find(d => d.id === e.target.value);
                  setForm({ ...form, departmentId: e.target.value, department: dept?.name || '' });
                }}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary bg-white"
              >
                <option value="">Select department</option>
                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            ) : (
              <input type="text" value={form.department} onChange={e => setForm({ ...form, department: e.target.value })}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" placeholder="Engineering" />
            )}
          </div>
        </div>

        {/* Designation */}
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

        {/* Workspace */}
        {workspaces.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Assign to Workspace</label>
            <select
              value={form.workspaceId}
              onChange={e => setForm({ ...form, workspaceId: e.target.value })}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary bg-white"
            >
              <option value="">No workspace (assign later)</option>
              {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
        )}

        {/* Role description */}
        <div className="bg-surface/50 rounded-lg px-3 py-2">
          <p className="text-xs text-text-tertiary">
            <span className="font-medium text-text-secondary">{availableRoles.find(r => r.value === form.role)?.label}:</span>{' '}
            {availableRoles.find(r => r.value === form.role)?.desc}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={handleClose} className="px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface rounded-lg transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={loading} className="px-5 py-2 text-sm font-medium text-white bg-primary hover:bg-primary-600 rounded-lg transition-colors disabled:opacity-50">
            {loading ? 'Creating...' : 'Create User'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
