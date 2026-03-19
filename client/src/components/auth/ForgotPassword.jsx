import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, ArrowLeft, Check, AlertCircle, FolderKanban } from 'lucide-react';
import api from '../../services/api';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [resetUrl, setResetUrl] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email.trim()) { setError('Email is required.'); return; }
    setLoading(true); setError('');
    try {
      const res = await api.post('/auth/forgot-password', { email: email.trim() });
      setSent(true);
      // Dev mode: show reset URL
      if (res.data?.data?.resetUrl) setResetUrl(res.data.data.resetUrl);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to send reset link.');
    } finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-400 flex items-center justify-center mx-auto mb-3 shadow-lg">
            <FolderKanban size={24} className="text-white" />
          </div>
          <h1 className="text-lg font-bold text-text-primary">Aniston Hub</h1>
        </div>

        <div className="bg-white rounded-xl border border-border shadow-sm p-6">
          {sent ? (
            <div className="text-center py-4">
              <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-3">
                <Check size={24} className="text-success" />
              </div>
              <h2 className="text-base font-bold text-text-primary mb-1">Check your email</h2>
              <p className="text-sm text-text-secondary mb-4">If an account exists for {email}, a reset link has been sent.</p>
              {resetUrl && (
                <div className="text-left bg-surface rounded-lg p-3 mb-4">
                  <p className="text-[10px] font-medium text-text-tertiary mb-1">Dev mode — Reset link:</p>
                  <a href={resetUrl} className="text-xs text-primary break-all hover:underline">{resetUrl}</a>
                </div>
              )}
              <button onClick={() => navigate('/login')} className="text-sm text-primary hover:underline">Back to login</button>
            </div>
          ) : (
            <>
              <h2 className="text-base font-bold text-text-primary mb-1">Forgot your password?</h2>
              <p className="text-sm text-text-secondary mb-4">Enter your email and we'll send you a reset link.</p>

              {error && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-danger/10 text-danger text-sm mb-4">
                  <AlertCircle size={14} /> {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">Email Address</label>
                  <div className="relative">
                    <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                      className="w-full pl-10 pr-3 py-2.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                      placeholder="your@email.com" autoFocus />
                  </div>
                </div>
                <button type="submit" disabled={loading}
                  className="w-full py-2.5 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors">
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </button>
              </form>

              <button onClick={() => navigate('/login')} className="flex items-center gap-1 text-sm text-text-secondary hover:text-primary mt-4 mx-auto">
                <ArrowLeft size={14} /> Back to login
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
