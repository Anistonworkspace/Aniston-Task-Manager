import React, { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Camera, Save, Lock, Eye, EyeOff, Shield, Mail, Building2, Briefcase, User as UserIcon, Check, AlertCircle, Bell } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import TeamsIntegrationSettings from '../components/settings/TeamsIntegrationSettings';
import SOPViewer from '../components/common/SOPViewer';
import { validateFile, getAcceptString } from '../utils/uploadConfig';

const ROLE_STYLES = {
  admin: { bg: 'bg-danger/10', text: 'text-danger', border: 'border-danger/20', label: 'Administrator' },
  manager: { bg: 'bg-warning/10', text: 'text-warning', border: 'border-warning/20', label: 'Manager' },
  member: { bg: 'bg-primary/10', text: 'text-primary', border: 'border-primary/20', label: 'Member' },
};

export default function ProfilePage() {
  const { user, updateProfile } = useAuth();
  const fileInputRef = useRef(null);
  const sopRef = useRef(null);
  const location = useLocation();

  // Auto-scroll to SOP section when navigating with #sop hash
  useEffect(() => {
    if (location.hash === '#sop' && sopRef.current) {
      setTimeout(() => sopRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
    }
  }, [location.hash]);

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
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [flash, setFlash] = useState(null);
  const [passwordFlash, setPasswordFlash] = useState(null);
  const [teamsNotifEnabled, setTeamsNotifEnabled] = useState(user?.teamsNotificationsEnabled !== false);
  const [togglingTeamsNotif, setTogglingTeamsNotif] = useState(false);

  function showFlash(msg, type = 'success') {
    setFlash({ msg, type });
    setTimeout(() => setFlash(null), 3000);
  }

  function showPasswordFlash(msg, type = 'success') {
    setPasswordFlash({ msg, type });
    setTimeout(() => setPasswordFlash(null), 3000);
  }

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

  async function handleAvatarUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const validation = validateFile(file, 'avatar');
    if (!validation.valid) {
      showFlash(validation.message, 'error');
      return;
    }
    setUploadingAvatar(true);
    try {
      const formData = new FormData();
      formData.append('avatar', file);
      const res = await api.post('/auth/avatar', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const updatedUser = res.data?.data?.user || res.data?.user;
      if (updatedUser) {
        await updateProfile({ avatar: updatedUser.avatar });
      }
      showFlash('Avatar updated successfully.');
    } catch (err) {
      showFlash(err.response?.data?.message || 'Failed to upload avatar.', 'error');
    } finally {
      setUploadingAvatar(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
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

  // Password strength indicator
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
      // Refresh user data so UI updates to show change-password form
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

  return (
    <div className="flex-1 overflow-y-auto bg-surface p-6 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Account Settings</h1>
          <p className="text-sm text-text-secondary mt-1">Manage your profile information and security</p>
        </div>

        {/* Flash */}
        {flash && (
          <div className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium animate-fade-in ${flash.type === 'error' ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'}`}>
            {flash.type === 'error' ? <AlertCircle size={16} /> : <Check size={16} />}
            {flash.msg}
          </div>
        )}

        {/* Avatar + Role Card */}
        <div className="widget-card">
          <div className="flex items-start gap-6">
            {/* Avatar */}
            <div className="relative group flex-shrink-0">
              <div className="w-24 h-24 rounded-2xl overflow-hidden bg-gradient-to-br from-primary to-blue-400 flex items-center justify-center shadow-lg">
                {avatarUrl ? (
                  <img src={avatarUrl} alt={user?.name} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-white text-2xl font-bold">{initials}</span>
                )}
              </div>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingAvatar}
                className="absolute inset-0 rounded-2xl bg-black/0 group-hover:bg-black/40 flex items-center justify-center transition-all cursor-pointer"
              >
                <div className="opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center">
                  {uploadingAvatar ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Camera size={20} className="text-white" />
                  )}
                </div>
              </button>
              <input ref={fileInputRef} type="file" accept={getAcceptString('avatar')} onChange={handleAvatarUpload} className="hidden" />
              <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-success rounded-full border-2 border-white" title="Active" />
            </div>

            {/* User Info */}
            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-bold text-text-primary">{user?.name}</h2>
              <div className="flex items-center gap-1.5 mt-1 text-text-secondary text-sm">
                <Mail size={13} />
                <span>{user?.email}</span>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full border ${roleStyle.bg} ${roleStyle.text} ${roleStyle.border}`}>
                  <Shield size={12} />
                  {roleStyle.label}
                </span>
                {user?.department && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-surface border border-border text-text-secondary">
                    <Building2 size={12} />
                    {user.department}
                  </span>
                )}
                {user?.designation && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full bg-surface border border-border text-text-secondary">
                    <Briefcase size={12} />
                    {user.designation}
                  </span>
                )}
              </div>
              <p className="text-xs text-text-tertiary mt-3">
                Member since {user?.createdAt ? new Date(user.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}
              </p>
            </div>
          </div>
        </div>

        {/* Profile Form */}
        <div className="widget-card">
          <h3 className="text-base font-semibold text-text-primary mb-4 flex items-center gap-2">
            <UserIcon size={18} className="text-primary" />
            Personal Information
          </h3>
          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Full Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                  placeholder="Your full name"
                />
              </div>
              {/* Email (read-only) */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Email Address</label>
                <input
                  type="email"
                  value={user?.email || ''}
                  readOnly
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-text-tertiary bg-surface cursor-not-allowed"
                />
              </div>
              {/* Department */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Department</label>
                <input
                  type="text"
                  value={form.department}
                  onChange={(e) => setForm(f => ({ ...f, department: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                  placeholder="e.g., Engineering"
                />
              </div>
              {/* Designation */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Designation</label>
                <input
                  type="text"
                  value={form.designation}
                  onChange={(e) => setForm(f => ({ ...f, designation: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                  placeholder="e.g., Senior Developer"
                />
              </div>
            </div>
            {/* Role (read-only) */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Role</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={roleStyle.label}
                  readOnly
                  className="w-full max-w-xs px-3 py-2 rounded-lg border border-border text-sm text-text-tertiary bg-surface cursor-not-allowed"
                />
                <span className="text-[10px] text-text-tertiary italic">Contact admin to change</span>
              </div>
            </div>
            <div className="flex justify-end pt-2">
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors shadow-sm"
              >
                {saving ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Save size={15} />}
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </div>

        {/* Password Section */}
        <div className="widget-card">
          <h3 className="text-base font-semibold text-text-primary mb-4 flex items-center gap-2">
            <Lock size={18} className="text-warning" />
            {user?.authProvider === 'microsoft' && !user?.hasLocalPassword ? 'Create Password' : 'Change Password'}
          </h3>

          {passwordFlash && (
            <div className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium mb-4 animate-fade-in ${passwordFlash.type === 'error' ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'}`}>
              {passwordFlash.type === 'error' ? <AlertCircle size={16} /> : <Check size={16} />}
              {passwordFlash.msg}
            </div>
          )}

          {user?.authProvider === 'microsoft' && !user?.hasLocalPassword ? (
            /* Microsoft SSO users without local password — Create Password form */
            <>
              <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 mb-4">
                <div className="flex items-start gap-2">
                  <svg width="20" height="20" viewBox="0 0 21 21" fill="none" className="mt-0.5 flex-shrink-0">
                    <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
                    <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
                    <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
                    <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
                  </svg>
                  <p className="text-xs text-blue-700">
                    You're signed in with Microsoft. Create a local password to also log in with your email and password.
                  </p>
                </div>
              </div>
              <form onSubmit={handleCreatePassword} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">New Password</label>
                    <div className="relative">
                      <input
                        type={showPasswords.create ? 'text' : 'password'}
                        value={createPass.password}
                        onChange={(e) => setCreatePass(p => ({ ...p, password: e.target.value }))}
                        className="w-full px-3 py-2 pr-10 rounded-lg border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                        placeholder="Min 8 characters"
                      />
                      <button type="button" onClick={() => setShowPasswords(s => ({ ...s, create: !s.create }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                        {showPasswords.create ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                    {/* Password strength indicator */}
                    {createPass.password && (() => {
                      const strength = getPasswordStrength(createPass.password);
                      return (
                        <div className="mt-2">
                          <div className="flex gap-1 mb-1">
                            {[1,2,3,4,5].map(i => (
                              <div key={i} className={`h-1 flex-1 rounded-full ${i <= strength.level ? strength.color : 'bg-gray-200'}`} />
                            ))}
                          </div>
                          <p className="text-[10px] text-text-tertiary">{strength.label}</p>
                        </div>
                      );
                    })()}
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text-secondary mb-1.5">Confirm Password</label>
                    <div className="relative">
                      <input
                        type={showPasswords.createConfirm ? 'text' : 'password'}
                        value={createPass.confirm}
                        onChange={(e) => setCreatePass(p => ({ ...p, confirm: e.target.value }))}
                        className={`w-full px-3 py-2 pr-10 rounded-lg border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all ${createPass.confirm && createPass.password !== createPass.confirm ? 'border-danger focus:border-danger' : 'border-border focus:border-primary'}`}
                        placeholder="Re-enter password"
                      />
                      <button type="button" onClick={() => setShowPasswords(s => ({ ...s, createConfirm: !s.createConfirm }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                        {showPasswords.createConfirm ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                    {createPass.confirm && createPass.password !== createPass.confirm && (
                      <p className="text-[11px] text-danger mt-1">Passwords do not match</p>
                    )}
                  </div>
                </div>
                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={creatingPassword || !createPass.password || !createPass.confirm || createPass.password !== createPass.confirm}
                    className="flex items-center gap-2 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors shadow-sm"
                  >
                    {creatingPassword ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Lock size={15} />}
                    {creatingPassword ? 'Creating...' : 'Create Password'}
                  </button>
                </div>
              </form>
            </>
          ) : (
            /* Local users or Microsoft users with local password — Change Password form */
            <form onSubmit={handleChangePassword} className="space-y-4">
              {/* Current Password */}
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Current Password</label>
                <div className="relative">
                  <input
                    type={showPasswords.current ? 'text' : 'password'}
                    value={passwords.current}
                    onChange={(e) => setPasswords(p => ({ ...p, current: e.target.value }))}
                    className="w-full px-3 py-2 pr-10 rounded-lg border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                    placeholder="Enter current password"
                  />
                  <button type="button" onClick={() => setShowPasswords(s => ({ ...s, current: !s.current }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                    {showPasswords.current ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* New Password */}
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">New Password</label>
                  <div className="relative">
                    <input
                      type={showPasswords.newPass ? 'text' : 'password'}
                      value={passwords.newPass}
                      onChange={(e) => setPasswords(p => ({ ...p, newPass: e.target.value }))}
                      className="w-full px-3 py-2 pr-10 rounded-lg border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                      placeholder="Min 8 characters"
                    />
                    <button type="button" onClick={() => setShowPasswords(s => ({ ...s, newPass: !s.newPass }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                      {showPasswords.newPass ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  {/* Password strength indicator */}
                  {passwords.newPass && (() => {
                    const strength = getPasswordStrength(passwords.newPass);
                    return (
                      <div className="mt-2">
                        <div className="flex gap-1 mb-1">
                          {[1,2,3,4,5].map(i => (
                            <div key={i} className={`h-1 flex-1 rounded-full ${i <= strength.level ? strength.color : 'bg-gray-200'}`} />
                          ))}
                        </div>
                        <p className="text-[10px] text-text-tertiary">{strength.label}</p>
                      </div>
                    );
                  })()}
                </div>
                {/* Confirm Password */}
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">Confirm New Password</label>
                  <div className="relative">
                    <input
                      type={showPasswords.confirm ? 'text' : 'password'}
                      value={passwords.confirm}
                      onChange={(e) => setPasswords(p => ({ ...p, confirm: e.target.value }))}
                      className={`w-full px-3 py-2 pr-10 rounded-lg border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all ${passwords.confirm && passwords.newPass !== passwords.confirm ? 'border-danger focus:border-danger' : 'border-border focus:border-primary'}`}
                      placeholder="Re-enter new password"
                    />
                    <button type="button" onClick={() => setShowPasswords(s => ({ ...s, confirm: !s.confirm }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary">
                      {showPasswords.confirm ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  {passwords.confirm && passwords.newPass !== passwords.confirm && (
                    <p className="text-[11px] text-danger mt-1">Passwords do not match</p>
                  )}
                </div>
              </div>
              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={savingPassword || !passwords.current || !passwords.newPass || !passwords.confirm || passwords.newPass !== passwords.confirm}
                  className="flex items-center gap-2 px-5 py-2 bg-warning text-white text-sm font-medium rounded-lg hover:bg-warning-dark disabled:opacity-50 transition-colors shadow-sm"
                >
                  {savingPassword ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Lock size={15} />}
                  {savingPassword ? 'Changing...' : 'Change Password'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Teams Chat Notifications Toggle */}
        <div className="widget-card">
          <h3 className="text-base font-semibold text-text-primary mb-4 flex items-center gap-2">
            <Bell size={18} className="text-primary" />
            Teams Notifications
          </h3>
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text-primary font-medium">Receive task notifications in Microsoft Teams</p>
              <p className="text-xs text-text-tertiary mt-1">
                When enabled, you'll receive task assignments, deadline changes, and removal notices directly in your Microsoft Teams chat.
              </p>
            </div>
            <button
              onClick={handleToggleTeamsNotif}
              disabled={togglingTeamsNotif}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50 ${teamsNotifEnabled ? 'bg-primary' : 'bg-gray-300'}`}
              role="switch"
              aria-checked={teamsNotifEnabled}
            >
              <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${teamsNotifEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
        </div>

        {/* Teams Integration */}
        <TeamsIntegrationSettings />

        {/* Standard Operating Procedure */}
        <div ref={sopRef}>
          <SOPViewer onRestartTour={() => window.dispatchEvent(new Event('restart-onboarding'))} />
        </div>

        {/* Account Info Footer */}
        <div className="text-center text-xs text-text-tertiary pb-4">
          Account ID: <span className="font-mono">{user?.id?.slice(0, 8)}</span> &middot; Last updated: {user?.updatedAt ? new Date(user.updatedAt).toLocaleDateString() : '—'}
        </div>

      </div>
    </div>
  );
}
