import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Save, Lock, Eye, EyeOff, Shield, Mail, Building2, Briefcase,
  User as UserIcon, Check, AlertCircle, Type, RotateCcw, Calendar,
  X, ShieldCheck, Settings as SettingsIcon, BookOpen,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useFontSize, DEFAULT_FONT_SIZE } from '../context/FontSizeContext';
import { useLanguage } from '../context/LanguageContext';
import { Languages } from 'lucide-react';
import api from '../services/api';
import DesktopUpdateSettings from '../components/profile/DesktopUpdateSettings';
import SOPViewer from '../components/common/SOPViewer';
import DepartmentSelect from '../components/common/DepartmentSelect';
import { TIER_1, TIER_2, TIER_3, TIER_4, resolveTier, tierLabel } from '../utils/tiers';

// Tier-based badge styles. Replaces the old role-name palette.
const TIER_STYLES = {
  [TIER_1]: { bg: 'bg-danger/10',  text: 'text-danger',  border: 'border-danger/20' },
  [TIER_2]: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/20' },
  [TIER_3]: { bg: 'bg-purple/10',  text: 'text-purple',  border: 'border-purple/20' },
  [TIER_4]: { bg: 'bg-primary/10', text: 'text-primary', border: 'border-primary/20' },
};

// Section nav for the Task-Modal-style panel. Drives scrollspy + tab clicks.
// Labels are resolved at render time via t() so the tab row re-translates
// when the user switches languages without a refresh.
const SECTIONS = [
  { id: 'profile',     labelKey: 'profile.sections.profile',     icon: UserIcon },
  { id: 'security',    labelKey: 'profile.sections.security',    icon: ShieldCheck },
  { id: 'preferences', labelKey: 'profile.sections.preferences', icon: SettingsIcon },
  { id: 'guide',       labelKey: 'profile.sections.guide',       icon: BookOpen },
];

/**
 * ProfilePage — accepts a `variant` so the same body can be rendered as either
 * a routed full page (direct /profile visit) or as the children of a
 * DetailModalShell when opened from the user dropdown.
 *
 *   variant="page"  (default) — wraps content in the layout-level scroll
 *                                container + a centered card surface.
 *   variant="modal"           — emits content as a fragment so the parent
 *                                DetailModalShell provides the panel surface
 *                                (animation, backdrop, focus trap, ESC, etc).
 *                                In modal mode the body becomes a
 *                                `flex-1 overflow-y-auto` region so the modal
 *                                scrolls internally instead of growing past
 *                                the panel height.
 */
export default function ProfilePage({ variant = 'page', onClose }) {
  const { user, updateProfile } = useAuth();
  const { fontSize, setFontSize, reset: resetFontSize, options: fontSizeOptions } = useFontSize();
  const { language, setLanguage, options: languageOptions, t } = useLanguage();
  const sopRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState('profile');

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
  const [savingFontSize, setSavingFontSize] = useState(false);
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [flash, setFlash] = useState(null);
  const [passwordFlash, setPasswordFlash] = useState(null);

  const isModal = variant === 'modal';

  function showFlash(msg, type = 'success') {
    setFlash({ msg, type });
    setTimeout(() => setFlash(null), 3000);
  }
  function showPasswordFlash(msg, type = 'success') {
    setPasswordFlash({ msg, type });
    setTimeout(() => setPasswordFlash(null), 3000);
  }

  // Auto-scroll to a section when navigating with a matching hash.
  // Keeps legacy `#sop` working and adds `#guide` plus the other section ids.
  useEffect(() => {
    const hash = (location.hash || '').replace('#', '');
    if (!hash) return;
    const targetId = hash === 'sop' ? 'guide' : hash;
    setTimeout(() => {
      const el = document.getElementById(targetId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setActiveSection(targetId);
      }
    }, 200);
  }, [location.hash]);

  // Highlight the section currently in view (drives the sticky tab row).
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target?.id) setActiveSection(visible.target.id);
      },
      { rootMargin: '-25% 0px -55% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] }
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

  // Page-variant default close: behave like the previous routed-page X.
  // Modal variant: parent route component provides `onClose` so the X plays
  // the DetailModalShell exit animation before unmounting.
  const handleClose = useCallback(() => {
    if (typeof onClose === 'function') return onClose();
    if (window.history.length > 1) navigate(-1);
    else navigate('/');
  }, [navigate, onClose]);

  async function handleLanguageChange(value) {
    if (value === language) return;
    setSavingLanguage(true);
    try {
      await setLanguage(value);
      // After the await the language has already switched — t() now resolves
      // to the new locale, so the flash reads in whichever language the user
      // just selected (matches what FontSize does for its own toasts).
      showFlash(value === 'hi' ? 'भाषा बदल गई।' : 'Language updated.');
    } catch (err) {
      showFlash(err.response?.data?.message || 'Failed to save language preference.', 'error');
    } finally {
      setSavingLanguage(false);
    }
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

  const userTier = resolveTier(user);
  const tierStyle = TIER_STYLES[userTier] || TIER_STYLES[TIER_4];
  const tierLabelText = tierLabel(userTier);
  const avatarUrl = user?.avatar ? (user.avatar.startsWith('http') ? user.avatar : user.avatar) : null;
  const initials = (user?.name || 'U').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const isMicrosoftSSO = user?.authProvider === 'microsoft' && !user?.hasLocalPassword;
  const memberSince = user?.createdAt
    ? new Date(user.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  // Status indicator shown in the modal-style header — mirrors the Task Modal's
  // "Saving... / Saved / Save failed" cluster so both surfaces share the same
  // visual language for in-flight + completion feedback.
  const headerStatus = (() => {
    if (saving || savingPassword || creatingPassword || savingFontSize || savingLanguage) {
      return <span className="text-[10px] text-blue-500 font-medium animate-pulse">{t('common.saving')}</span>;
    }
    if (flash?.type === 'success') return <span className="text-[10px] text-success font-medium">{t('common.saved')}</span>;
    if (flash?.type === 'error') return <span className="text-[10px] text-danger font-medium">{t('common.saveFailed')}</span>;
    return null;
  })();

  const content = (
    <>
      {/* Header — same primitives as TaskModal's panel header */}
      <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-text-secondary">{t('profile.title')}</span>
          {headerStatus}
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label={t('common.close')}
          className="p-1.5 rounded-md hover:bg-surface text-text-secondary"
        >
          <X size={18} />
        </button>
      </div>

      {/* Inline flash — shows the full message under the header. The brief
          pill in the header conveys state at a glance; this banner exposes
          the actual message text (e.g. validation errors). */}
      {flash && (
        <div
          role="status"
          className={`mx-4 sm:mx-6 mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border animate-fade-in flex-shrink-0 ${
            flash.type === 'error'
              ? 'bg-danger/10 text-danger border-danger/20'
              : 'bg-success/10 text-success border-success/20'
          }`}
        >
          {flash.type === 'error' ? <AlertCircle size={15} /> : <Check size={15} />}
          {flash.msg}
        </div>
      )}

      {/* Scrollable region — in modal mode this is the only thing that scrolls
          (the DetailModalShell panel is a fixed bottom sheet); in page mode
          we let it flow inside the layout's outer scroll container. */}
      <div className={isModal ? 'flex-1 min-h-0 overflow-y-auto' : ''}>
        {/* Identity band — sits where the TaskModal title + "Assigned by /
            Assigned to" row sits. Renders only data already on the page. */}
        <div className="px-4 sm:px-6 pt-5 pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5">
            <div className="relative shrink-0 self-start sm:self-auto">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl overflow-hidden bg-gradient-to-br from-primary to-purple shadow-md flex items-center justify-center">
                {avatarUrl ? (
                  <img src={avatarUrl} alt={user?.name} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-white text-xl sm:text-2xl font-bold tracking-tight">{initials}</span>
                )}
              </div>
              <span
                className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-success rounded-full border-[3px] border-[var(--primary-background-color)]"
                title={t('profile.active')}
              />
            </div>

            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold text-text-primary truncate">{user?.name || '—'}</h1>
              <p className="text-xs text-text-secondary mt-0.5 inline-flex items-center gap-1.5 max-w-full">
                <Mail size={12} className="shrink-0" />
                <span className="truncate">{user?.email}</span>
              </p>

              <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${tierStyle.bg} ${tierStyle.text} ${tierStyle.border}`}>
                  <Shield size={11} />{tierLabelText}
                </span>
                {user?.department && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-50 border border-border text-text-secondary">
                    <Building2 size={11} />{user.department}
                  </span>
                )}
                {user?.designation && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-50 border border-border text-text-secondary">
                    <Briefcase size={11} />{user.designation}
                  </span>
                )}
                {memberSince && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-surface-50 border border-border text-text-tertiary">
                    <Calendar size={11} />{t('profile.memberSince', { date: memberSince })}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Section nav — uses TaskModal's `tabs-compact` primitive verbatim
            so both surfaces share the same tab visual language. Sticky to
            the scroll container so the user can jump sections while
            scrolling (the parent scroll container differs between page and
            modal modes; both work because `top-0` is relative to whichever
            ancestor scrolls). */}
        <div className="sticky top-0 z-10 px-4 sm:px-6 bg-[var(--primary-background-color)] border-b border-border">
          <div className="tabs-compact !border-b-0" role="tablist" aria-label={t('profile.title')}>
            {SECTIONS.map(s => {
              const Icon = s.icon;
              const active = activeSection === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => scrollToSection(s.id)}
                  className="tab-trigger-compact"
                >
                  <Icon size={13} />
                  {t(s.labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Body — single-column flow; cards fill the panel width. */}
        <div className="px-4 sm:px-6 py-5 space-y-5">
          {/* Personal Information */}
          <Card id="profile" className="scroll-mt-16" icon={UserIcon} iconColor="text-primary" title={t('profile.personalInformation')}>
            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label={t('profile.fullName')}>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                    className={inputCls}
                    placeholder={t('profile.fullNamePlaceholder')}
                  />
                </Field>
                <Field label={t('profile.emailAddress')}>
                  <input
                    type="email"
                    value={user?.email || ''}
                    readOnly
                    className={readOnlyInputCls}
                  />
                </Field>
                <Field label={t('profile.department')}>
                  <DepartmentSelect
                    value={form.department}
                    onChange={dept => setForm(f => ({ ...f, department: dept }))}
                  />
                </Field>
                <Field label={t('profile.designation')}>
                  <input
                    type="text"
                    value={form.designation}
                    onChange={(e) => setForm(f => ({ ...f, designation: e.target.value }))}
                    className={inputCls}
                    placeholder={t('profile.designationPlaceholder')}
                  />
                </Field>
              </div>

              <Field label={t('profile.tier')} hint={t('profile.tierHint')}>
                <input
                  type="text"
                  value={tierLabelText}
                  readOnly
                  className={`${readOnlyInputCls} max-w-xs`}
                />
              </Field>

              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors shadow-sm"
                >
                  {saving ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Save size={15} />}
                  {saving ? t('profile.saving') : t('profile.saveChanges')}
                </button>
              </div>
            </form>
          </Card>

          {/* Change / Create Password */}
          <Card
            id="security"
            className="scroll-mt-16"
            icon={Lock}
            iconColor="text-warning"
            title={isMicrosoftSSO ? t('profile.createPassword') : t('profile.changePassword')}
          >
            {passwordFlash && (
              <div
                role="status"
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium mb-4 border animate-fade-in ${
                  passwordFlash.type === 'error'
                    ? 'bg-danger/10 text-danger border-danger/20'
                    : 'bg-success/10 text-success border-success/20'
                }`}
              >
                {passwordFlash.type === 'error' ? <AlertCircle size={15} /> : <Check size={15} />}
                {passwordFlash.msg}
              </div>
            )}

            {isMicrosoftSSO ? (
              <>
                <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 mb-4">
                  <div className="flex items-start gap-2">
                    <svg width="18" height="18" viewBox="0 0 21 21" fill="none" className="mt-0.5 flex-shrink-0">
                      <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
                      <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
                      <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
                      <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
                    </svg>
                    <p className="text-xs text-blue-700 dark:text-blue-300">
                      {t('profile.msSsoNotice')}
                    </p>
                  </div>
                </div>
                <form onSubmit={handleCreatePassword} className="space-y-4">
                  <Field label={t('profile.newPassword')}>
                    <PasswordInput
                      value={createPass.password}
                      onChange={(v) => setCreatePass(p => ({ ...p, password: v }))}
                      show={showPasswords.create}
                      onToggleShow={() => setShowPasswords(s => ({ ...s, create: !s.create }))}
                      placeholder={t('profile.newPasswordPlaceholder')}
                    />
                    {createPass.password && <PasswordStrength getStrength={getPasswordStrength} value={createPass.password} />}
                  </Field>
                  <Field label={t('profile.confirmPassword')}>
                    <PasswordInput
                      value={createPass.confirm}
                      onChange={(v) => setCreatePass(p => ({ ...p, confirm: v }))}
                      show={showPasswords.createConfirm}
                      onToggleShow={() => setShowPasswords(s => ({ ...s, createConfirm: !s.createConfirm }))}
                      placeholder={t('profile.reenterPasswordPlaceholder')}
                      error={createPass.confirm && createPass.password !== createPass.confirm}
                    />
                    {createPass.confirm && createPass.password !== createPass.confirm && (
                      <p className="text-[11px] text-danger mt-1">{t('profile.passwordsDoNotMatch')}</p>
                    )}
                  </Field>
                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      disabled={creatingPassword || !createPass.password || !createPass.confirm || createPass.password !== createPass.confirm}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors shadow-sm"
                    >
                      {creatingPassword ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Lock size={15} />}
                      {creatingPassword ? t('profile.creating') : t('profile.createPassword')}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <form onSubmit={handleChangePassword} className="space-y-4">
                <Field label={t('profile.currentPassword')}>
                  <PasswordInput
                    value={passwords.current}
                    onChange={(v) => setPasswords(p => ({ ...p, current: v }))}
                    show={showPasswords.current}
                    onToggleShow={() => setShowPasswords(s => ({ ...s, current: !s.current }))}
                    placeholder={t('profile.currentPasswordPlaceholder')}
                  />
                </Field>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label={t('profile.newPassword')}>
                    <PasswordInput
                      value={passwords.newPass}
                      onChange={(v) => setPasswords(p => ({ ...p, newPass: v }))}
                      show={showPasswords.newPass}
                      onToggleShow={() => setShowPasswords(s => ({ ...s, newPass: !s.newPass }))}
                      placeholder={t('profile.newPasswordPlaceholder')}
                    />
                    {passwords.newPass && <PasswordStrength getStrength={getPasswordStrength} value={passwords.newPass} />}
                  </Field>
                  <Field label={t('profile.confirmNewPassword')}>
                    <PasswordInput
                      value={passwords.confirm}
                      onChange={(v) => setPasswords(p => ({ ...p, confirm: v }))}
                      show={showPasswords.confirm}
                      onToggleShow={() => setShowPasswords(s => ({ ...s, confirm: !s.confirm }))}
                      placeholder={t('profile.reenterNewPasswordPlaceholder')}
                      error={passwords.confirm && passwords.newPass !== passwords.confirm}
                    />
                    {passwords.confirm && passwords.newPass !== passwords.confirm && (
                      <p className="text-[11px] text-danger mt-1">{t('profile.passwordsDoNotMatch')}</p>
                    )}
                  </Field>
                </div>
                <div className="flex justify-end pt-1">
                  <button
                    type="submit"
                    disabled={savingPassword || !passwords.current || !passwords.newPass || !passwords.confirm || passwords.newPass !== passwords.confirm}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-warning text-white text-sm font-medium rounded-lg hover:bg-warning-dark disabled:opacity-50 transition-colors shadow-sm"
                  >
                    {savingPassword ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Lock size={15} />}
                    {savingPassword ? t('profile.changing') : t('profile.changePassword')}
                  </button>
                </div>
              </form>
            )}
          </Card>

          {/* Display preferences */}
          <Card
            id="preferences"
            className="scroll-mt-16"
            icon={Type}
            iconColor="text-primary"
            title={t('profile.displayPreferences')}
            action={
              <button
                type="button"
                onClick={handleFontSizeReset}
                disabled={savingFontSize || fontSize === DEFAULT_FONT_SIZE}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-text-secondary rounded-md border border-border hover:bg-surface-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label={t('profile.resetFontSize')}
              >
                <RotateCcw size={12} />{t('common.reset')}
              </button>
            }
          >
            <p className="text-xs text-text-secondary mb-3">
              {t('profile.displayPrefHint')}{' '}
              {t('profile.currently')}{' '}
              <span className="font-semibold text-text-primary">
                {(() => {
                  const opt = fontSizeOptions.find(o => o.value === fontSize);
                  // FontSizeContext owns its option labels (in English). We
                  // translate them by mapping the value to a fontSize.* key.
                  return opt ? t(`fontSize.${opt.value}`) : t('fontSize.default');
                })()}
              </span>
            </p>
            <div role="radiogroup" aria-label={t('profile.fontSize')} className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
                    className={`flex flex-col items-start gap-1 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                      active
                        ? 'border-primary bg-primary/5 text-text-primary'
                        : 'border-border bg-[var(--bg-elevated)] text-text-secondary hover:border-border-dark hover:bg-surface-50'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      {t(`fontSize.${opt.value}`)}
                      {active && <Check size={13} className="text-primary" />}
                    </span>
                    <span className="text-[11px] text-text-tertiary leading-tight">{t(`fontSize.${opt.value}Description`)}</span>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Language selector — sits inside the same preferences anchor as
              Display preferences. Renders the picker for every tier; backend
              accepts the update for all authenticated users so there is no
              role-based gating here. Long Hindi labels are absorbed by the
              flex layout (segmented buttons stretch + wrap). */}
          <Card
            icon={Languages}
            iconColor="text-primary"
            title={t('profile.language')}
          >
            <p className="text-xs text-text-secondary mb-3">
              {t('profile.languageHint')}
            </p>
            <div
              role="radiogroup"
              aria-label={t('profile.language')}
              className="grid grid-cols-1 sm:grid-cols-2 gap-2"
            >
              {languageOptions.map(opt => {
                const active = opt.value === language;
                // Show the English name AND the native script side-by-side
                // so users who don't yet read the target script can still
                // make the choice confidently.
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => handleLanguageChange(opt.value)}
                    disabled={savingLanguage}
                    className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                      active
                        ? 'border-primary bg-primary/5 text-text-primary'
                        : 'border-border bg-[var(--bg-elevated)] text-text-secondary hover:border-border-dark hover:bg-surface-50'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <span className="flex flex-col min-w-0">
                      <span className="text-sm font-semibold truncate">{opt.nativeLabel}</span>
                      {opt.nativeLabel !== opt.label && (
                        <span className="text-[11px] text-text-tertiary leading-tight truncate">{opt.label}</span>
                      )}
                    </span>
                    {active && <Check size={14} className="text-primary flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Desktop App Updates (Slice 9) — only renders inside the
              Electron desktop wrapper. Returns null on web. */}
          <DesktopUpdateSettings />

          {/* Guide / SOP — full panel width */}
          <div id="guide" ref={sopRef} className="scroll-mt-16">
            <SOPViewer onRestartTour={() => window.dispatchEvent(new Event('restart-onboarding'))} />
          </div>

          {/* Account ID footer */}
          <div className="text-center text-xs text-text-tertiary pt-1 pb-1">
            {t('profile.accountId')}: <span className="font-mono">{user?.id?.slice(0, 8)}</span>
            {user?.updatedAt && (
              <> &middot; {t('profile.lastUpdated')}: {new Date(user.updatedAt).toLocaleDateString()}</>
            )}
          </div>
        </div>
      </div>
    </>
  );

  // Modal mode: emit a fragment so the parent DetailModalShell wraps us with
  // the actual overlay surface, animation, focus trap, ESC + backdrop close.
  if (isModal) return content;

  // Page mode (direct /profile visit): wrap the same content in the layout's
  // outer scroll container plus a centered card surface, so refresh / direct
  // links still render the redesigned panel without a modal overlay.
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1120px] px-3 sm:px-4 lg:px-6 py-4 sm:py-6">
        <div className="rounded-xl border border-border bg-[var(--primary-background-color)] shadow-2xl overflow-hidden flex flex-col">
          {content}
        </div>
      </div>
    </div>
  );
}

// ─────────── Local presentational helpers ───────────
const inputCls =
  'w-full px-3 py-2 rounded-lg border border-border bg-[var(--bg-elevated)] text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors';

const readOnlyInputCls =
  'w-full px-3 py-2 rounded-lg border border-border text-sm text-text-tertiary bg-surface cursor-not-allowed';

function Card({ id, icon: Icon, iconColor = 'text-primary', title, action, className = '', children }) {
  return (
    <section
      id={id}
      className={`rounded-2xl border border-border bg-[var(--bg-elevated)] p-5 sm:p-6 shadow-[0_1px_3px_rgba(0,0,0,0.03)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.05)] transition-shadow ${className}`}
    >
      <header className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          {Icon && (
            <div className="shrink-0 w-8 h-8 rounded-lg bg-surface-50 border border-border-light flex items-center justify-center">
              <Icon size={16} className={iconColor} />
            </div>
          )}
          <h3 className="text-base font-semibold text-text-primary truncate">{title}</h3>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

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
        className={`w-full px-3 py-2 pr-10 rounded-lg border bg-[var(--bg-elevated)] text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-colors ${
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
            className={`h-1 flex-1 rounded-full transition-colors ${i <= strength.level ? strength.color : 'bg-[var(--ui-background-color)]'}`}
          />
        ))}
      </div>
      <p className="text-[10px] text-text-tertiary">{strength.label}</p>
    </div>
  );
}
