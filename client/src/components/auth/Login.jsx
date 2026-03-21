import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { FolderKanban, Mail, Lock, ArrowRight, Eye, EyeOff } from 'lucide-react';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!email || !password) { setError('Please fill in all fields'); return; }
    setLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left - Form */}
      <div className="flex-1 flex items-center justify-center p-8 bg-white">
        <div className="w-full max-w-[380px]">
          <div className="flex items-center gap-2.5 mb-8">
            <img src="/icons/anistonlogo.png" alt="Monday Aniston" className="w-10 h-10 rounded-xl object-contain" />
            <div>
              <h1 className="text-xl font-bold text-text-primary leading-tight">Monday Aniston</h1>
              <p className="text-[11px] text-text-secondary">Work Management</p>
            </div>
          </div>

          <h2 className="text-2xl font-bold text-text-primary mb-1">Welcome back!</h2>
          <p className="text-sm text-text-secondary mb-8">Log in to your account to continue</p>

          {error && (
            <div className="bg-danger/10 border border-danger/20 text-danger text-sm px-4 py-2.5 rounded-lg mb-4">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Email</label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com"
                  className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1.5">Password</label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password"
                  className="w-full pl-10 pr-10 py-2.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors">
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <button type="submit" disabled={loading}
              className="w-full bg-primary hover:bg-primary-hover text-white py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60 mt-2">
              {loading ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" /> : <><span>Log in</span><ArrowRight size={16} /></>}
            </button>
          </form>

          <div className="text-center mt-4">
            <Link to="/forgot-password" className="text-xs text-text-tertiary hover:text-primary">Forgot password?</Link>
          </div>
          <p className="text-sm text-text-secondary text-center mt-4">
            Don't have an account?{' '}
            <Link to="/register" className="text-primary font-semibold hover:underline">Sign up</Link>
          </p>
        </div>
      </div>

      {/* Right - Illustration */}
      <div className="hidden lg:flex flex-1 bg-gradient-to-br from-primary via-blue-500 to-purple-600 items-center justify-center p-12">
        <div className="text-center text-white max-w-md">
          <div className="w-20 h-20 rounded-2xl bg-white/20 flex items-center justify-center mx-auto mb-6 backdrop-blur-sm">
            <img src="/icons/anistonlogo.png" alt="Monday Aniston" className="w-14 h-14 object-contain" />
          </div>
          <h2 className="text-3xl font-bold mb-3">Manage your team's work</h2>
          <p className="text-white/80 text-base leading-relaxed">Track tasks, collaborate with your team, and deliver projects on time with Monday Aniston.</p>
        </div>
      </div>
    </div>
  );
}
