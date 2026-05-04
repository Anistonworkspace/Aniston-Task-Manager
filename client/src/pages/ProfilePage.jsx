import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Save, Lock, Eye, EyeOff, Shield, Mail, Building2, Briefcase, User as UserIcon,
  Check, AlertCircle, Bell, Type, RotateCcw, Sparkles, Calendar, Clock, KeyRound,
  BookOpen, Plug, Settings as SettingsIcon, ShieldCheck, ChevronRight, Activity,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useFontSize, DEFAULT_FONT_SIZE } from '../context/FontSizeContext';
import api from '../services/api';
import TeamsIntegrationSettings from '../components/settings/TeamsIntegrationSettings';
import SOPViewer from '../components/common/SOPViewer';

const ROLE_STYLES = {
  admin:             { bg: 'bg-danger/10',   text: 'text-danger',   border: 'border-danger/20',   label: 'Administrator' },
  manager:           { bg: 'bg-warning/10',  text: 'text-warning',  border: 'border-warning/20',  label: 'Manager' },
  assistant_manager: { bg: 'bg-purple/10',   text: 'text-purple',   border: 'border-purple/20',   label: 'Assistant Manager' },
  member:            { bg: 'bg-primary/10',  text: 'text-primary',  border: 'border-primary/20',  label: 'Member' },
};

const SECTIONS = [
  { id: 'profile',       label: 'Profile',       icon: UserIcon },
  { id: 'security',      label: 'Security',      icon: ShieldCheck },
  { id: 'preferences',   label: 'Preferences',   icon: SettingsIcon },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'integrations',  label: 'Integrations',  icon: Plug },
  { id: 'guide',         label: 'Guide',         icon: BookOpen },
];

// ─────────── Reusable card wrapper with entrance animation ───────────
function SettingsCard({ id, icon: Icon, iconColor = 'text-primary', title, action, children, className = '' }) {
  return (
    <motion.section
      id={id}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      className={`scroll-mt-24 group relative rounded-2xl border border-border bg-[var(--bg-elevated)] p-5 sm:p-6 shadow-[0_1px_3px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.02)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.03)] transition-all duration-300 ${className}`}
    >
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 mb-5">
          <div className="flex items-center gap-2.5 min-w-0">
            {Icon && (
              <div className="shrink-0 w-8 h-8 rounded-lg bg-surface-50 flex items-center justify-center border border-border-light">
                <Icon size={16} className={iconColor} />
              </div>
            )}
            <h3 className="text-base font-semibold text-text-primary truncate">{title}</h3>
          </div>
          {action}
        </header>
      )}
      {children}
    </motion.section>
  );
}

export default function ProfilePage() {
  const { user, updateProfile } = useAuth();
  const { fontSize, setFontSize, reset: resetFontSize, options: fontSizeOptions } = useFontSize();
  const [savingFontSize, setSavingFontSize] = useState(false);
  const sopRef = useRef(null);
  const location = useLocation();

  const [form, setForm] = useState({
    name: user?.name || '',
    department: user?.department || '',
    designation: user?.designation || '',
  });
  const [passwords, setPasswords] = useState({ current: '', newPass: '', confirm: '' });
  const [createPass, setCreatePass] = useState({ password: '', confirm: '' });
  const [showPasswords, setShowPasswords] = useState({ current: false, newPass: false, confirm: false, create: false, createConfirm: false });
  const [saving, setSaving] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [creatingPassword, setCreatingPassword] = useState(false);
  const [flash, setFlash] = useState(null);
  const [passwordFlash, setPasswordFlash] = useState(null);
  const [teamsNotifEnabled, setTeamsNotifEnabled] = useState(user?.teamsNotificationsEnabled !== false);
  const [togglingTeamsNotif, setTogglingTeamsNotif] = useState(false);
  const [activeSection, setActiveSection] = useState('profile');

  function showFlash(msg, type = 'success') {
    setFlash({ msg, type });
    setTimeout(() => setFlash(null), 3000);
  }

  function showPasswordFlash(msg, type = 'success') {
    setPasswordFlash({ msg, type });
    setTimeout(() => setPasswordFlash(null), 3000);
  }

  async function handleFontSizeChange(value) {
    if (value === fontSize) return;
    setSavingFontSize(true);
    try {
      await setFontSize(value);
      showFlash('Font size updated.');
    } catch (err) {
      showFlash(err.response?.data?.message || 'Failed to save font size preference.', 'error');
    } finally {
      setSavingFontSize(false);
    }
  }

  async function handleFontSizeReset() {
    if (fontSize === DEFAULT_FONT_SIZE) return;
    setSavingFontSize(true);
    try {
      await resetFontSize();
      showFlash('Font size reset to default.');
    } catch (err) {
      showFlash(err.response?.data?.message || 'Failed to reset font size.', 'error');
    } finally {
      setSavingFontSize(false);
    }
  }

  // Auto-scroll to SOP section when navigating with #sop hash (legacy compatibility)
  useEffect(() => {
    if (location.hash === '#sop' || location.hash === '#guide') {
      setTimeout(() => {
        const el = document.getElementById('guide');
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveSection('guide');
      }, 200);
    }
  }, [location.hash]);

  // Track which section is currently in view for the sticky nav highlight.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target?.id) setActiveSection(visible.target.id);
      },
      { rootMargin: '-30% 0px -55% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    SECTIONS.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const scrollToSection = useCallback((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveSection(id);
  }, []);

  async function handleToggleTeamsNotif() {
    setTogglingTeamsNotif(true);
    try {
      const newValue = !teamsNotifEnabled;
      await updateProfile({ teamsNotificationsEnabled: newValue });
      setTeamsNotifEnabled(newValue);
      showFlash(newValue ? 'Teams notifications enabled.' : 'Teams notifications disabled.');
    } catch (err) {
      showFlash(err.response?.data?.message || 'Failed to update Teams notification preference.', 'error');
    } finally {
      setTogglingTeamsNotif(false);
    }
  }

  async function handleSaveProfile(e) {
    e.preventDefault();
    if (!form.name.trim()) {
      showFlash('Name is required.', 'error');
      return;
    }
    setSaving(true);
    try {
      await updateProfile({
        name: form.name.trim(),
        department: form.department.trim(),
        designation: form.designation.trim(),
      });
      showFlash('Profile updated successfully.');
    } catch (err) {
      showFlash(err.response?.data?.message || 'Failed to update profile.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    if (!passwords.current || !passwords.newPass || !passwords.confirm) {
      showPasswordFlash('All password fields are required.', 'error');
      return;
    }
    if (passwords.newPass.length < 6) {
      showPasswordFlash('New password must be at least 6 characters.', 'error');
      return;
    }
    if (passwords.newPass !== passwords.confirm) {
      showPasswordFlash('New passwords do not match.', 'error');
      return;
    }
    setSavingPassword(true);
    try {
      await api.put('/auth/profile', {
        currentPassword: passwords.current,
        newPassword: passwords.newPass,
      });
      setPasswords({ current: '', newPass: '', confirm: '' });
      showPasswordFlash('Password changed successfully.');
    } catch (err) {
      showPasswordFlash(err.response?.data?.message || 'Failed to change password.', 'error');
    } finally {
      setSavingPassword(false);
    }
  }

  function getPasswordStrength(pw) {
    if (!pw) return { level: 0, label: '', color: '' };
    let score = 0;
    if (pw.length >= 8) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[a-z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pw)) score++;
    if (score <= 2) return { level: score, label: 'Weak', color: 'bg-danger' };
    if (score <= 3) return { level: score, label: 'Fair', color: 'bg-warning' };
    if (score <= 4) return { level: score, label: 'Good', color: 'bg-primary' };
    return { level: score, label: 'Strong', color: 'bg-success' };
  }

  async function handleCreatePassword(e) {
    e.preventDefault();
    if (!createPass.password || !createPass.confirm) {
      showPasswordFlash('Both password fields are required.', 'error');
      return;
    }
    if (createPass.password.length < 8) {
      showPasswordFlash('Password must be at least 8 characters.', 'error');
      return;
    }
    if (createPass.password !== createPass.confirm) {
      showPasswordFlash('Passwords do not match.', 'error');
      return;
    }
    setCreatingPassword(true);
    try {
      await api.post('/auth/create-password', {
        password: createPass.password,
        confirmPassword: createPass.confirm,
      });
      setCreatePass({ password: '', confirm: '' });
      showPasswordFlash('Password created! You can now log in with your email and password.');
      try {
        const res = await api.get('/auth/me');
        const u = res.data?.data?.user || res.data?.user;
        if (u) updateProfile({ hasLocalPassword: true });
      } catch {}
    } catch (err) {
      showPasswordFlash(err.response?.data?.message || 'Failed to create password.', 'error');
    } finally {
      setCreatingPassword(false);
    }
  }

  const roleStyle = ROLE_STYLES[user?.role] || ROLE_STYLES.member;
  const avatarUrl = user?.avatar ? (user.avatar.startsWith('http') ? user.avatar : user.avatar) : null;
  const initials = (user?.name || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const isMicrosoftSSO = user?.authProvider === 'microsoft' && !user?.hasLocalPassword;
  const memberSince = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';
  const lastUpdated = user?.updatedAt
    ? new Date(user.updatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';

  // Lightweight profile completion meter — purely a visual cue, no backend write.
  const completion = useMemo(() => {
    const checks = [
      !!user?.name,
      !!user?.email,
      !!user?.department,
      !!user?.designation,
      !!user?.avatar,
      !!user?.hasLocalPassword || user?.authProvider === 'microsoft',
    ];
    const done = checks.filter(Boolean).length;
    return { done, total: checks.length, pct: Math.round((done / checks.length) * 100) };
  }, [user]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 py-6 lg:py-8 space-y-6">

        {/* ─────────────── HERO BANNER ─────────────── */}
        <motion.section
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary-50 via-white to-purple-light/40 dark:from-primary-900/20 dark:via-[var(--bg-elevated)] dark:to-purple-900/10 shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
        >
          {/* Decorative background blobs (CSS-only, very subtle) */}
          <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute -top-24 -right-16 w-72 h-72 rounded-full bg-primary/15 blur-3xl animate-pulse-soft" />
            <div className="absolute -bottom-24 left-1/3 w-80 h-80 rounded-full bg-purple/15 blur-3xl animate-pulse-soft" style={{ animationDelay: '1.2s' }} />
          </div>

          <div className="relative p-6 sm:p-8">
            <div className="flex flex-col lg:flex-row lg:items-center gap-6">
              {/* Avatar */}
              <div className="flex items-center gap-5">
                <div className="relative shrink-0">
                  <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl overflow-hidden bg-gradient-to-br from-primary to-purple shadow-lg ring-4 ring-white/60 dark:ring-white/5 flex items-center justify-center">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt={user?.name} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-white text-2xl sm:text-3xl font-bold tracking-tight">{initials}</span>
                    )}
                  </div>
                  <span
                    className="absolute -bottom-1 -right-1 w-5 h-5 bg-success rounded-full border-[3px] border-white dark:border-[var(--bg-elevated)] shadow-sm"
                    title="Active"
                  />
                </div>

                {/* Identity (mobile/tablet) */}
                <div className="lg:hidden min-w-0 flex-1">
                  <h1 className="text-xl sm:text-2xl font-bold text-text-primary truncate">{user?.name || 'Account'}</h1>
                  <p className="text-sm text-text-secondary truncate flex items-center gap-1.5"><Mail size={13} />{user?.email}</p>
                </div>
              </div>

              {/* Identity + badges (desktop) */}
              <div className="flex-1 min-w-0">
                <div className="hidden lg:block">
                  <h1 className="text-2xl xl:text-3xl font-bold text-text-primary tracking-tight">{user?.name || 'Account'}</h1>
                  <p className="text-sm text-text-secondary mt-0.5 flex items-center gap-1.5"><Mail size={14} />{user?.email}</p>
                </div>

                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full border ${roleStyle.bg} ${roleStyle.text} ${roleStyle.border}`}>
                    <Shield size={12} />{roleStyle.label}
                  </span>
                  {user?.isSuperAdmin && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full bg-gradient-to-r from-primary/15 to-purple/15 text-primary border border-primary/20">
                      <Sparkles size={12} />Super Admin
                    </span>
                  )}
                  {user?.department && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-white/70 dark:bg-white/5 border border-border text-text-secondary backdrop-blur-sm">
                      <Building2 size={12} />{user.department}
                    </span>
                  )}
                  {user?.designation && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-white/70 dark:bg-white/5 border border-border text-text-secondary backdrop-blur-sm">
                      <Briefcase size={12} />{user.designation}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs text-text-tertiary">
                  <span className="inline-flex items-center gap-1.5"><Calendar size={12} />Member since {memberSince}</span>
                  <span className="inline-flex items-center gap-1.5"><Clock size={12} />Updated {lastUpdated}</span>
                </div>
              </div>

              {/* Quick actions */}
              <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-stretch lg:w-auto">
                <button
                  onClick={() => scrollToSection('profile')}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium shadow-sm hover:bg-primary-600 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200"
                >
                  <Save size={14} />Save Changes
                </button>
                <button
                  onClick={() => scrollToSection('security')}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-white/70 dark:bg-white/5 border border-border text-text-primary text-sm font-medium hover:bg-white dark:hover:bg-white/10 transition-colors"
                >
                  <KeyRound size={14} />{isMicrosoftSSO ? 'Create Password' : 'Change Password'}
                </button>
              </div>
            </div>

            {/* Profile completion meter */}
            <div className="mt-6 flex items-center gap-3">
              <div className="flex-1 h-1.5 rounded-full bg-white/60 dark:bg-white/5 overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${completion.pct}%` }}
                  transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
                  className="h-full rounded-full bg-gradient-to-r from-primary to-purple"
                />
              </div>
              <span className="text-xs font-semibold text-text-secondary whitespace-nowrap">
                Profile {completion.pct}% complete
              </span>
            </div>
          </div>
        </motion.section>

        {/* ─────────────── PAGE FLASH ─────────────── */}
        {flash && (
          <div
            role="status"
            className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium animate-fade-in shadow-sm border ${
              flash.type === 'error'
                ? 'bg-danger/10 text-danger border-danger/20'
                : 'bg-success/10 text-success border-success/20'
            }`}
          >
            {flash.type === 'error' ? <AlertCircle size={16} /> : <Check size={16} />}
            {flash.msg}
          </div>
        )}

        {/* ─────────────── MAIN GRID ─────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* ─── LEFT: Settings nav (sticky on desktop, horizontal scroll on mobile) ─── */}
          <aside className="lg:col-span-2 xl:col-span-2">
            {/* Mobile / tablet: horizontal scroll chips */}
            <nav
              aria-label="Settings sections"
              className="lg:hidden -mx-4 sm:-mx-6 px-4 sm:px-6 overflow-x-auto"
            >
              <ul className="inline-flex gap-1.5 pb-1">
                {SECTIONS.map(s => {
                  const Icon = s.icon;
                  const active = activeSection === s.id;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => scrollToSection(s.id)}
                        aria-current={active ? 'true' : undefined}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors ${
                          active
                            ? 'bg-primary text-white border-primary shadow-sm'
                            : 'bg-[var(--bg-elevated)] text-text-secondary border-border hover:text-text-primary hover:border-border-dark'
                        }`}
                      >
                        <Icon size={13} />{s.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>

            {/* Desktop: sticky vertical nav card */}
            <div className="hidden lg:block sticky top-4">
              <div className="rounded-2xl border border-border bg-[var(--bg-elevated)] p-2 shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
                <p className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-text-tertiary">
                  Settings
                </p>
                <ul className="flex flex-col gap-0.5">
                  {SECTIONS.map(s => {
                    const Icon = s.icon;
                    const active = activeSection === s.id;
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => scrollToSection(s.id)}
                          aria-current={active ? 'true' : undefined}
                          className={`relative w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                            active
                              ? 'bg-primary/10 text-primary'
                              : 'text-text-secondary hover:bg-surface-50 hover:text-text-primary'
                          }`}
                        >
                          {active && (
                            <motion.span
                              layoutId="settings-active-bar"
                              className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full bg-primary"
                              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                            />
                          )}
                          <Icon size={15} className={active ? 'text-primary' : 'text-text-tertiary'} />
                          <span className="flex-1 text-left">{s.label}</span>
                          {active && <ChevronRight size={13} className="text-primary" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </aside>

          {/* ─── MIDDLE: Main content ─── */}
          <div className="lg:col-span-10 xl:col-span-7 space-y-6">

            {/* Profile / Personal Information */}
            <SettingsCard
              id="profile"
              icon={UserIcon}
              iconColor="text-primary"
              title="Personal Information"
            >
              <form onSubmit={handleSaveProfile} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="Full Name">
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                      className={inputCls}
                      placeholder="Your full name"
                    />
                  </Field>
                  <Field label="Email Address">
                    <input
                      type="email"
                      value={user?.email || ''}
                      readOnly
                      className={readOnlyInputCls}
                    />
                  </Field>
                  <Field label="Department">
                    <input
                      type="text"
                      value={form.department}
                      onChange={(e) => setForm(f => ({ ...f, department: e.target.value }))}
                      className={inputCls}
                      placeholder="e.g., Engineering"
                    />
                  </Field>
                  <Field label="Designation">
                    <input
                      type="text"
                      value={form.designation}
                      onChange={(e) => setForm(f => ({ ...f, designation: e.target.value }))}
                      className={inputCls}
                      placeholder="e.g., Senior Developer"
                    />
                  </Field>
                </div>
                <Field label="Role" hint="Contact admin to change">
                  <input
                    type="text"
                    value={roleStyle.label}
                    readOnly
                    className={`${readOnlyInputCls} max-w-xs`}
                  />
                </Field>
                <div className="flex justify-end pt-1">
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex items-center gap-2 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-600 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50 disabled:translate-y-0 transition-all duration-200 shadow-sm"
                  >
                    {saving ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Save size={15} />}
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </form>
            </SettingsCard>

            {/* Security: Change / Create Password */}
            <SettingsCard
              id="security"
              icon={Lock}
              iconColor="text-warning"
              title={isMicrosoftSSO ? 'Create Password' : 'Change Password'}
            >
              {passwordFlash && (
                <div
                  role="status"
                  className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium mb-4 animate-fade-in border ${
                    passwordFlash.type === 'error'
                      ? 'bg-danger/10 text-danger border-danger/20'
                      : 'bg-success/10 text-success border-success/20'
                  }`}
                >
                  {passwordFlash.type === 'error' ? <AlertCircle size={16} /> : <Check size={16} />}
                  {passwordFlash.msg}
                </div>
              )}

              {isMicrosoftSSO ? (
                <>
                  <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 mb-4">
                    <div className="flex items-start gap-2">
                      <svg width="20" height="20" viewBox="0 0 21 21" fill="none" className="mt-0.5 flex-shrink-0">
                        <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
                        <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
                        <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
                        <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
                      </svg>
                      <p className="text-xs text-blue-700 dark:text-blue-300">
                        You're signed in with Microsoft. Create a local password to also log in with your email and password.
                      </p>
                    </div>
                  </div>
                  <form onSubmit={handleCreatePassword} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <Field label="New Password">
                        <PasswordInput
                          value={createPass.password}
                          onChange={(v) => setCreatePass(p => ({ ...p, password: v }))}
                          show={showPasswords.create}
                          onToggleShow={() => setShowPasswords(s => ({ ...s, create: !s.create }))}
                          placeholder="Min 8 characters"
                        />
                        {createPass.password && <PasswordStrength getStrength={getPasswordStrength} value={createPass.password} />}
                      </Field>
                      <Field label="Confirm Password">
                        <PasswordInput
                          value={createPass.confirm}
                          onChange={(v) => setCreatePass(p => ({ ...p, confirm: v }))}
                          show={showPasswords.createConfirm}
                          onToggleShow={() => setShowPasswords(s => ({ ...s, createConfirm: !s.createConfirm }))}
                          placeholder="Re-enter password"
                          error={createPass.confirm && createPass.password !== createPass.confirm}
                        />
                        {createPass.confirm && createPass.password !== createPass.confirm && (
                          <p className="text-[11px] text-danger mt-1">Passwords do not match</p>
                        )}
                      </Field>
                    </div>
                    <div className="flex justify-end pt-1">
                      <button
                        type="submit"
                        disabled={creatingPassword || !createPass.password || !createPass.confirm || createPass.password !== createPass.confirm}
                        className="inline-flex items-center gap-2 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-600 hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50 disabled:translate-y-0 transition-all duration-200 shadow-sm"
                      >
                        {creatingPassword ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Lock size={15} />}
                        {creatingPassword ? 'Creating...' : 'Create Password'}
                      </button>
                    </div>
                  </form>
                </>
              ) : (
                <form onSubmit={handleChangePassword} className="space-y-4">
                  <Field label="Current Password">
                    <PasswordInput
                      value={passwords.current}
                      onChange={(v) => setPasswords(p => ({ ...p, current: v }))}
                      show={showPasswords.current}
                      onToggleShow={() => setShowPasswords(s => ({ ...s, current: !s.current }))}
                      placeholder="Enter current password"
                    />
                  </Field>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="New Password">
                      <PasswordInput
                        value={passwords.newPass}
                        onChange={(v) => setPasswords(p => ({ ...p, newPass: v }))}
                        show={showPasswords.newPass}
                        onToggleShow={() => setShowPasswords(s => ({ ...s, newPass: !s.newPass }))}
                        placeholder="Min 8 characters"
                      />
                      {passwords.newPass && <PasswordStrength getStrength={getPasswordStrength} value={passwords.newPass} />}
                    </Field>
                    <Field label="Confirm New Password">
                      <PasswordInput
                        value={passwords.confirm}
                        onChange={(v) => setPasswords(p => ({ ...p, confirm: v }))}
                        show={showPasswords.confirm}
                        onToggleShow={() => setShowPasswords(s => ({ ...s, confirm: !s.confirm }))}
                        placeholder="Re-enter new password"
                        error={passwords.confirm && passwords.newPass !== passwords.confirm}
                      />
                      {passwords.confirm && passwords.newPass !== passwords.confirm && (
                        <p className="text-[11px] text-danger mt-1">Passwords do not match</p>
                      )}
                    </Field>
                  </div>
                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      disabled={savingPassword || !passwords.current || !passwords.newPass || !passwords.confirm || passwords.newPass !== passwords.confirm}
                      className="inline-flex items-center gap-2 px-5 py-2 bg-warning text-white text-sm font-medium rounded-lg hover:bg-warning-dark hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50 disabled:translate-y-0 transition-all duration-200 shadow-sm"
                    >
                      {savingPassword ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Lock size={15} />}
                      {savingPassword ? 'Changing...' : 'Change Password'}
                    </button>
                  </div>
                </form>
              )}
            </SettingsCard>

            {/* Preferences (Font size) */}
            <SettingsCard
              id="preferences"
              icon={Type}
              iconColor="text-primary"
              title="Preferences"
              action={
                <button
                  type="button"
                  onClick={handleFontSizeReset}
                  disabled={savingFontSize || fontSize === DEFAULT_FONT_SIZE}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-text-secondary rounded-md border border-border hover:bg-surface-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  aria-label="Reset font size to default"
                >
                  <RotateCcw size={12} />Reset
                </button>
              }
            >
              <p className="text-xs text-text-secondary mb-3">
                Choose how dense the interface feels. Saved to your account, so it follows you across devices.{' '}
                Currently:{' '}
                <span className="font-semibold text-text-primary">
                  {fontSizeOptions.find(o => o.value === fontSize)?.label || 'Default'}
                </span>
              </p>
              <div role="radiogroup" aria-label="Font size" className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {fontSizeOptions.map(opt => {
                  const active = opt.value === fontSize;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => handleFontSizeChange(opt.value)}
                      disabled={savingFontSize}
                      className={`flex flex-col items-start gap-1 px-3 py-2.5 rounded-lg border text-left transition-all duration-200 ${
                        active
                          ? 'border-primary bg-primary/5 text-text-primary shadow-sm scale-[1.02]'
                          : 'border-border bg-[var(--bg-elevated)] text-text-secondary hover:border-border-dark hover:bg-surface-50 hover:-translate-y-0.5'
                      } disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0`}
                    >
                      <span className="flex items-center gap-1.5 text-sm font-semibold">
                        {opt.label}
                        {active && <Check size={13} className="text-primary" />}
                      </span>
                      <span className="text-[11px] text-text-tertiary">{opt.description}</span>
                    </button>
                  );
                })}
              </div>
            </SettingsCard>

            {/* Notifications + Teams Integration — side by side on desktop */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <SettingsCard
                id="notifications"
                icon={Bell}
                iconColor="text-primary"
                title="Notifications"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary font-medium">Microsoft Teams alerts</p>
                    <p className="text-xs text-text-tertiary mt-1">
                      Receive task assignments, deadline changes, and removal notices in your Teams chat.
                    </p>
                  </div>
                  <button
                    onClick={handleToggleTeamsNotif}
                    disabled={togglingTeamsNotif}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 ${teamsNotifEnabled ? 'bg-primary' : 'bg-gray-300 dark:bg-zinc-600'}`}
                    role="switch"
                    aria-checked={teamsNotifEnabled}
                    aria-label="Toggle Teams notifications"
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${teamsNotifEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
              </SettingsCard>

              {/* Teams Integration card — keeps its own logic, just wrap in scroll target */}
              <div id="integrations" className="scroll-mt-24">
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '-40px' }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                >
                  <TeamsIntegrationSettings />
                </motion.div>
              </div>
            </div>

            {/* Admin Guide / SOP */}
            <motion.div
              id="guide"
              ref={sopRef}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="scroll-mt-24"
            >
              <SOPViewer onRestartTour={() => window.dispatchEvent(new Event('restart-onboarding'))} />
            </motion.div>

            {/* Account ID footer */}
            <div className="text-center text-xs text-text-tertiary pt-2 pb-2">
              Account ID: <span className="font-mono">{user?.id?.slice(0, 8)}</span> &middot; Last updated: {lastUpdated}
            </div>
          </div>

          {/* ─── RIGHT: Summary column (xl only) ─── */}
          <aside className="hidden xl:flex xl:col-span-3 flex-col gap-6">
            <div className="sticky top-4 flex flex-col gap-4">
              {/* Account Overview */}
              <motion.div
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
                className="rounded-2xl border border-border bg-[var(--bg-elevated)] p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
              >
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <Activity size={15} />
                  </div>
                  <h3 className="text-sm font-semibold text-text-primary">Account Overview</h3>
                </div>
                <dl className="space-y-3 text-sm">
                  <SummaryRow label="Status" value={
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success">
                      <span className="w-1.5 h-1.5 rounded-full bg-success" />Active
                    </span>
                  } />
                  <SummaryRow label="Role" value={<span className={`text-xs font-semibold ${roleStyle.text}`}>{roleStyle.label}</span>} />
                  {user?.department && <SummaryRow label="Department" value={user.department} />}
                  {user?.designation && <SummaryRow label="Title" value={user.designation} />}
                  <SummaryRow label="Member since" value={memberSince} />
                </dl>
                <div className="mt-4 pt-3 border-t border-border-light">
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="text-text-secondary font-medium">Profile completion</span>
                    <span className="font-semibold text-text-primary">{completion.done}/{completion.total}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-primary to-purple transition-all duration-700"
                      style={{ width: `${completion.pct}%` }}
                    />
                  </div>
                </div>
              </motion.div>

              {/* Connected Services */}
              <motion.div
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
                className="rounded-2xl border border-border bg-[var(--bg-elevated)] p-5 shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
              >
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 rounded-lg bg-purple/10 text-purple flex items-center justify-center">
                    <Plug size={15} />
                  </div>
                  <h3 className="text-sm font-semibold text-text-primary">Connected Services</h3>
                </div>
                <ul className="space-y-2.5 text-sm">
                  <ServiceRow
                    name="Microsoft Teams"
                    connected={user?.authProvider === 'microsoft' || user?.teamsUserId}
                  />
                  <ServiceRow
                    name="Local password"
                    connected={!!user?.hasLocalPassword || user?.authProvider !== 'microsoft'}
                  />
                  <ServiceRow
                    name="Teams notifications"
                    connected={teamsNotifEnabled}
                  />
                </ul>
                <button
                  onClick={() => scrollToSection('integrations')}
                  className="mt-4 w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-primary bg-primary/5 hover:bg-primary/10 rounded-lg border border-primary/15 transition-colors"
                >
                  Manage integrations<ChevronRight size={12} />
                </button>
              </motion.div>

              {/* Quick links */}
              <motion.div
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], delay: 0.3 }}
                className="rounded-2xl border border-border bg-gradient-to-br from-primary/5 to-purple/5 p-5"
              >
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles size={14} className="text-primary" />
                  <h3 className="text-sm font-semibold text-text-primary">Quick links</h3>
                </div>
                <div className="flex flex-col gap-1.5">
                  {SECTIONS.slice(1).map(s => {
                    const Icon = s.icon;
                    return (
                      <button
                        key={s.id}
                        onClick={() => scrollToSection(s.id)}
                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-xs font-medium text-text-secondary hover:bg-white/70 dark:hover:bg-white/5 hover:text-text-primary transition-colors"
                      >
                        <span className="flex items-center gap-2">
                          <Icon size={13} />{s.label}
                        </span>
                        <ChevronRight size={12} className="text-text-tertiary" />
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

// ─────────── Local presentational helpers ───────────
const inputCls =
  'w-full px-3 py-2 rounded-lg border border-border bg-[var(--bg-elevated)] text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all';

const readOnlyInputCls =
  'w-full px-3 py-2 rounded-lg border border-border text-sm text-text-tertiary bg-surface cursor-not-allowed';

function Field({ label, children, hint }) {
  return (
    <div>
      <label className="block text-xs font-medium text-text-secondary mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-text-tertiary italic mt-1">{hint}</p>}
    </div>
  );
}

function PasswordInput({ value, onChange, show, onToggleShow, placeholder, error }) {
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full px-3 py-2 pr-10 rounded-lg border bg-[var(--bg-elevated)] text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all ${
          error ? 'border-danger focus:border-danger' : 'border-border focus:border-primary'
        }`}
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={onToggleShow}
        aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors"
      >
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

function PasswordStrength({ value, getStrength }) {
  const strength = getStrength(value);
  return (
    <div className="mt-2">
      <div className="flex gap-1 mb-1">
        {[1, 2, 3, 4, 5].map(i => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${i <= strength.level ? strength.color : 'bg-gray-200 dark:bg-zinc-700'}`}
          />
        ))}
      </div>
      <p className="text-[10px] text-text-tertiary">{strength.label}</p>
    </div>
  );
}

function SummaryRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-text-tertiary">{label}</dt>
      <dd className="text-xs font-medium text-text-primary text-right truncate">{value}</dd>
    </div>
  );
}

function ServiceRow({ name, connected }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="text-xs text-text-secondary truncate">{name}</span>
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
          connected
            ? 'bg-success/10 text-success border-success/20'
            : 'bg-surface-100 text-text-tertiary border-border'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-success' : 'bg-text-tertiary/40'}`} />
        {connected ? 'Connected' : 'Off'}
      </span>
    </li>
  );
}
