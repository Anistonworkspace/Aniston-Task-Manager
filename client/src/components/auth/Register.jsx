import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../services/api';
import { FolderKanban, Mail, Lock, User, Building, ArrowRight, CheckCircle2, Clock } from 'lucide-react';

export default function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [department, setDepartment] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!name || !email || !password) { setError('Please fill in all required fields'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    setLoading(true);
    try {
      await api.post('/auth/register', { name, email, password, department });
      setSubmitted(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex flex-1 bg-gradient-to-br from-success via-emerald-500 to-teal-600 items-center justify-center p-12">
        <div className="text-center text-white max-w-md">
          <div className="w-20 h-20 rounded-2xl bg-white/20 flex items-center justify-center mx-auto mb-6 backdrop-blur-sm">
            <FolderKanban size={40} className="text-white" />
          </div>
          <h2 className="text-3xl font-bold mb-3">Start working together</h2>
          <p className="text-white/80 text-base leading-relaxed">Create your account and start managing your team's projects with powerful tools and real-time collaboration.</p>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center p-8 bg-white">
        <div className="w-full max-w-[380px]">
          <div className="flex items-center gap-2.5 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-blue-400 flex items-center justify-center shadow-md">
              <FolderKanban size={22} className="text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-text-primary leading-tight">Aniston Hub</h1>
              <p className="text-[11px] text-text-secondary">Work Management</p>
            </div>
          </div>

          {submitted ? (
            <div className="text-center py-8">
              <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 size={32} className="text-success" />
              </div>
              <h2 className="text-xl font-bold text-text-primary mb-2">Request Submitted!</h2>
              <p className="text-sm text-text-secondary mb-6 leading-relaxed">
                Your account request has been submitted successfully. An administrator will review and approve your account.
              </p>
              <div className="flex items-center gap-2 justify-center text-xs text-text-tertiary bg-warning/10 px-4 py-3 rounded-lg">
                <Clock size={14} className="text-warning" />
                <span>You'll be able to login once your account is approved.</span>
              </div>
              <Link to="/login" className="inline-block mt-6 text-primary font-semibold text-sm hover:underline">
                Back to Login
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-text-primary mb-1">Request an account</h2>
              <p className="text-sm text-text-secondary mb-6">Submit your details for admin approval</p>

              {error && <div className="bg-danger/10 border border-danger/20 text-danger text-sm px-4 py-2.5 rounded-lg mb-4">{error}</div>}

              <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">Full Name *</label>
                  <div className="relative">
                    <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="John Doe"
                      className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">Email *</label>
                  <div className="relative">
                    <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com"
                      className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">Password *</label>
                  <div className="relative">
                    <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min. 6 characters"
                      className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">Department</label>
                  <div className="relative">
                    <Building size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                    <input type="text" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Engineering"
                      className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
                  </div>
                </div>
                <button type="submit" disabled={loading}
                  className="w-full bg-primary hover:bg-primary-hover text-white py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60 mt-1">
                  {loading ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" /> : <><span>Submit Request</span><ArrowRight size={16} /></>}
                </button>
              </form>
              <p className="text-sm text-text-secondary text-center mt-6">
                Already have an account? <Link to="/login" className="text-primary font-semibold hover:underline">Log in</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
