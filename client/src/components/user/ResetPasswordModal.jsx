import React, { useState } from 'react';
import { Eye, EyeOff, AlertTriangle } from 'lucide-react';
import Modal from '../common/Modal';

export default function ResetPasswordModal({ isOpen, onClose, user, onReset }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function handleClose() {
    setPassword('');
    setConfirm('');
    setError('');
    setShowPass(false);
    onClose();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    try {
      setLoading(true);
      setError('');
      const { default: api } = await import('../../services/api');
      await api.put(`/users/${user.id}/reset-password`, { newPassword: password });
      handleClose();
      if (onReset) onReset();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to reset password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Reset Password" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Warning */}
        <div className="flex items-start gap-2.5 bg-warning/10 text-warning px-3 py-2.5 rounded-lg">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <p className="text-sm">
            You are resetting the password for <span className="font-semibold">{user?.name}</span>. They will need to use the new password to log in.
          </p>
        </div>

        {error && (
          <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg">{error}</div>
        )}

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">New Password *</label>
          <div className="relative">
            <input
              type={showPass ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 pr-10 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              placeholder="Min 6 characters"
            />
            <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
              {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">Confirm Password *</label>
          <input
            type={showPass ? 'text' : 'password'}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            placeholder="Re-enter password"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button type="button" onClick={handleClose} className="px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface rounded-lg transition-colors">
            Cancel
          </button>
          <button type="submit" disabled={loading} className="px-5 py-2 text-sm font-medium text-white bg-danger hover:bg-red-600 rounded-lg transition-colors disabled:opacity-50">
            {loading ? 'Resetting...' : 'Reset Password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
