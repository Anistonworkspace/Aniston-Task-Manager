import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, Eye, EyeOff, Check, AlertCircle, FolderKanban } from 'lucide-react';
import api from '../../services/api';

export default function ResetPassword() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true); setError('');
    try {
      await api.post('/auth/reset-password', { token, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to reset password.');
    } finally { setLoading(false); }
  }

  if (!token) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-4">
        <div className="text-center">
          <AlertCircle size={40} className="mx-auto text-danger mb-3" />
          <p className="text-sm text-text-secondary">Invalid reset link. No token provided.</p>
          <button onClick={() => navigate('/login')} className="text-sm text-primary hover:underline mt-3">Back to login</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-400 flex items-center justify-center mx-auto mb-3 shadow-lg">
            <FolderKanban size={24} className="text-white" />
          </div>
        </div>
        <div className="bg-white rounded-xl border border-border shadow-sm p-6">
          {done ? (
            <div className="text-center py-4">
              <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-3">
                <Check size={24} className="text-success" />
              </div>
              <h2 className="text-base font-bold text-text-primary mb-1">Password Reset!</h2>
              <p className="text-sm text-text-secondary mb-4">Your password has been updated. You can now login.</p>
              <button onClick={() => navigate('/login')} className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover">
                Go to Login
              </button>
            </div>
          ) : (
            <>
              <h2 className="text-base font-bold text-text-primary mb-1">Set new password</h2>
              <p className="text-sm text-text-secondary mb-4">Enter your new password below.</p>
              {error && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-danger/10 text-danger text-sm mb-4">
                  <AlertCircle size={14} /> {error}
                </div>
              )}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">New Password</label>
                  <div className="relative">
                    <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                    <input type={showPass ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                      className="w-full pl-10 pr-10 py-2.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder="Min 6 characters" />
                    <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary">
                      {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">Confirm Password</label>
                  <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                    className={`w-full px-3 py-2.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 ${confirm && password !== confirm ? 'border-danger' : 'border-border'}`}
                    placeholder="Re-enter password" />
                </div>
                <button type="submit" disabled={loading}
                  className="w-full py-2.5 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50">
                  {loading ? 'Resetting...' : 'Reset Password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
