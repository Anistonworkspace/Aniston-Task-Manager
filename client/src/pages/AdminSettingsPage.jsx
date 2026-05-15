import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useT } from '../context/LanguageContext';
import safeLog from '../utils/safeLog';

// TODO i18n: further strings (form labels, error messages, dialogs) still hardcoded — extend in a future pass
import {
  Settings, Shield, Users, LayoutGrid, Bell, Key, Plus, Trash2, Edit2,
  Check, X, ChevronRight, Search, AlertCircle, Clock, UserPlus, Eye,
  Lock, Unlock, BookmarkCheck, RefreshCw, Briefcase, MoreHorizontal,
  UserCheck, UserX, KeyRound, ShieldCheck
} from 'lucide-react';
import Avatar from '../components/common/Avatar';
import Modal from '../components/common/Modal';
import CreateUserModal from '../components/user/CreateUserModal';
import EditUserModal from '../components/user/EditUserModal';
import ResetPasswordModal from '../components/user/ResetPasswordModal';
import { useToast } from '../components/common/Toast';
import { RESOURCES, ACTIONS, RESOURCE_ACTIONS, getResourcesByCategory, getActionsForResource } from '../utils/permissions';
import {
  TIER_1, TIER_2, TIER_3, TIER_4, ALL_TIERS,
  resolveTier, tierLabel, tiersGrantableBy, hasTierAtLeast,
} from '../utils/tiers';

const TABS = [
  { id: 'users', label: 'Users', icon: Users },
  { id: 'workspaces', label: 'Workspaces', icon: LayoutGrid },
  { id: 'permissions', label: 'Permissions', icon: Shield },
  { id: 'access_requests', label: 'Access Requests', icon: Key },
  { id: 'templates', label: 'Templates', icon: BookmarkCheck },
  // 'security' is Tier 1 only and is filtered into the visible list at render time.
  { id: 'security', label: 'Security', icon: Lock, tier1Only: true },
];

// Tier badge styles. Numerically smaller = more privileged.
const TIER_BADGE = {
  [TIER_1]: { bg: 'bg-red-100',    text: 'text-red-700',    icon: ShieldCheck },
  [TIER_2]: { bg: 'bg-purple-100', text: 'text-purple-700', icon: ShieldCheck },
  [TIER_3]: { bg: 'bg-cyan-100',   text: 'text-cyan-700',   icon: Shield },
  [TIER_4]: { bg: 'bg-green-100',  text: 'text-green-700',  icon: Users },
};

// Map a tier value to the legacy (role, isSuperAdmin) pair the API still
// accepts during the compatibility window. The User-model `beforeSave` hook
// keeps tier and legacy fields in lockstep on the server side.
function legacyFromTier(tier) {
  switch (tier) {
    case TIER_1: return { role: 'admin', isSuperAdmin: true };
    case TIER_2: return { role: 'admin', isSuperAdmin: false };
    case TIER_3: return { role: 'assistant_manager', isSuperAdmin: false };
    case TIER_4: return { role: 'member', isSuperAdmin: false };
    default:     return { role: 'member', isSuperAdmin: false };
  }
}

const LEGACY_RESOURCE_TYPES = ['workspace', 'board', 'team', 'dashboard'];
const LEGACY_PERMISSION_LEVELS = ['view', 'edit', 'assign', 'manage', 'admin'];
const LEVEL_COLORS = {
  view: '#579bfc', edit: '#fdab3d', assign: '#9d50dd', manage: '#00c875', admin: '#df2f4a',
  create: '#00c875', delete: '#df2f4a', approve: '#9d50dd', export: '#579bfc',
  manage_members: '#00c875', manage_settings: '#df2f4a', change_status: '#fdab3d',
  comment: '#579bfc', upload: '#fdab3d',
};

export default function AdminSettingsPage() {
  const { user, isSuperAdmin } = useAuth();
  const t = useT();
  const [activeTab, setActiveTab] = useState('users');

  // Filter out super-admin-only tabs for regular admins. The Security tab is
  // intentionally invisible to admins/managers/members — they cannot read or
  // write the system inactivity timeout. Backend enforces the same on PUT.
  const visibleTabs = TABS.filter(tab => !tab.tier1Only || resolveTier(user) === TIER_1);

  // Map tab id → translation key for visible label. Untranslated/unknown ids
  // fall through to tab.label so the UI never breaks if a new tab is added.
  const TAB_LABEL_KEYS = {
    users: 'adminSettings.tabs.users',
    workspaces: 'adminSettings.tabs.workspaces',
    permissions: 'adminSettings.tabs.permissions',
    access_requests: 'adminSettings.tabs.accessRequests',
    templates: 'adminSettings.tabs.templates',
    security: 'adminSettings.tabs.security',
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2 mb-1">
          <Settings size={24} className="text-primary" />
          {t('adminSettings.title')}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">{t('adminSettings.subtitle')}</p>
      </motion.div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 dark:bg-zinc-800 rounded-lg p-1 mb-6 w-fit">
        {visibleTabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition-all ${
              activeTab === tab.id ? 'bg-white dark:bg-zinc-700 text-primary shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            <tab.icon size={14} /> {TAB_LABEL_KEYS[tab.id] ? t(TAB_LABEL_KEYS[tab.id]) : tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'workspaces' && <WorkspacesTab />}
      {activeTab === 'permissions' && <PermissionsTab />}
      {activeTab === 'access_requests' && <AccessRequestsTab />}
      {activeTab === 'templates' && <TemplatesTab />}
      {activeTab === 'security' && isSuperAdmin && <SecurityTab />}
    </div>
  );
}

function UsersTab() {
  const { user: currentUser } = useAuth();
  const actorTier = resolveTier(currentUser);
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [showReset, setShowReset] = useState(null);
  const [editUser, setEditUser] = useState(null);
  const [actionMenu, setActionMenu] = useState(null);
  const [tierChanging, setTierChanging] = useState(null);
  // Staged tier change awaiting confirmation. Holds the target user, their
  // current tier, and the requested new tier. The select stays bound to the
  // canonical user.tier, so cancelling the modal requires no manual revert.
  const [pendingTierChange, setPendingTierChange] = useState(null);
  const [visibleCount, setVisibleCount] = useState(25);

  // Tier 1/Tier 2 actors get the privileged edit form (tier / status / email).
  // Lower tiers see only the safe-profile-fields slice — server side enforces
  // the same via hierarchyService.canManageUser.
  const canEditPrivileged = hasTierAtLeast(currentUser, TIER_2);

  // Tiers this actor is allowed to grant. Tier 1 grants any tier; Tier 2
  // grants Tier 3/4 only. Tier 3/4 actors get an empty list — the dropdown
  // simply renders the user's current tier as read-only.
  const grantableTiers = tiersGrantableBy(currentUser);

  useEffect(() => { fetchUsers(); }, []);

  async function fetchUsers() {
    try {
      const res = await api.get('/users');
      setUsers(res.data.users || res.data.data?.users || res.data || []);
    } catch (err) { safeLog.error('[AdminSettings] error', err); } finally { setLoading(false); }
  }

  // Stage the tier change — does NOT hit the API. Confirmation modal calls
  // confirmTierChange() to actually mutate. Bail early if the dropdown
  // re-emits the user's current tier.
  function requestTierChange(u, newTier) {
    const currentTier = resolveTier(u);
    if (newTier === currentTier) return;
    // Defense in depth — backend also enforces these:
    if (newTier < actorTier) {
      toast.error(`You cannot grant a tier higher than your own (${tierLabel(actorTier)}).`);
      return;
    }
    if (actorTier === TIER_2 && newTier <= TIER_2) {
      toast.error('Tier 2 may only grant Tier 3 or Tier 4.');
      return;
    }
    setPendingTierChange({ user: u, oldTier: currentTier, newTier });
  }

  async function confirmTierChange() {
    if (!pendingTierChange) return;
    const { user: target, newTier } = pendingTierChange;
    if (tierChanging === target.id) return;
    setTierChanging(target.id);
    try {
      // Send legacy fields derived from the target tier — the server's
      // userTierSync hook keeps tier in lockstep on save.
      await api.put(`/users/${target.id}`, legacyFromTier(newTier));
      await fetchUsers();
      toast.success(`${tierLabel(newTier)} assigned.`);
      setPendingTierChange(null);
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
      toast.error(err.response?.data?.message || 'Failed to change tier');
      fetchUsers();
      setPendingTierChange(null);
    } finally {
      setTierChanging(null);
      setActionMenu(null);
    }
  }

  function cancelTierChange() {
    if (tierChanging) return;
    setPendingTierChange(null);
  }

  async function handleDelete(userId, name) {
    if (!confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/users/${userId}`);
      fetchUsers();
      toast.success(`Deleted ${name}.`);
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
      toast.error(err.response?.data?.message || 'Failed to delete user');
    }
  }

  async function handleToggleStatus(userId) {
    try {
      const res = await api.put(`/users/${userId}/toggle-status`);
      const updated = res.data?.data?.user;
      fetchUsers();
      if (updated) {
        toast.success(updated.isActive ? 'User activated.' : 'User deactivated.');
      }
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
      toast.error(err.response?.data?.message || 'Failed to toggle status');
    }
    setActionMenu(null);
  }

  const filtered = users.filter(u => {
    if (tierFilter !== 'all' && resolveTier(u) !== Number(tierFilter)) return false;
    if (search) {
      const q = search.toLowerCase();
      return u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) || u.designation?.toLowerCase().includes(q);
    }
    return true;
  });

  // Tier-keyed counts for stat cards and filter sub-tabs.
  const tierCounts = {
    [TIER_1]: 0, [TIER_2]: 0, [TIER_3]: 0, [TIER_4]: 0,
  };
  for (const u of users) {
    const t = resolveTier(u);
    if (tierCounts[t] !== undefined) tierCounts[t] += 1;
  }
  const stats = { total: users.length, ...tierCounts };

  if (loading) return <div className="animate-pulse space-y-3">{[1,2,3].map(i => <div key={i} className="h-16 bg-gray-100 dark:bg-zinc-800 rounded-xl" />)}</div>;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">User Management</h2>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors">
          <UserPlus size={14} /> Create User
        </button>
      </div>

      {/* Stats — tier-based, never role-based. */}
      <div className="grid grid-cols-5 gap-3 mb-4">
        {[
          { label: 'Total',  count: stats.total,     color: '#0073ea' },
          { label: 'Tier 1', count: stats[TIER_1],   color: '#bb3354' },
          { label: 'Tier 2', count: stats[TIER_2],   color: '#9d50dd' },
          { label: 'Tier 3', count: stats[TIER_3],   color: '#175a63' },
          { label: 'Tier 4', count: stats[TIER_4],   color: '#00854d' },
        ].map(s => (
          <div key={s.label} className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 px-4 py-3">
            <p className="text-2xl font-bold" style={{ color: s.color }}>{s.count}</p>
            <p className="text-[10px] text-gray-400 uppercase tracking-wider">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Tier sub-tabs + Search */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 bg-gray-100 dark:bg-zinc-800 rounded-lg p-0.5">
          {[
            { value: 'all',          label: `All (${stats.total})` },
            { value: String(TIER_1), label: `Tier 1 (${stats[TIER_1]})` },
            { value: String(TIER_2), label: `Tier 2 (${stats[TIER_2]})` },
            { value: String(TIER_3), label: `Tier 3 (${stats[TIER_3]})` },
            { value: String(TIER_4), label: `Tier 4 (${stats[TIER_4]})` },
          ].map(opt => (
            <button key={opt.value} onClick={() => setTierFilter(opt.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                tierFilter === opt.value ? 'bg-white dark:bg-zinc-700 text-primary shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>{opt.label}</button>
          ))}
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search name, email..." className="pl-8 pr-3 py-2 text-sm border border-gray-200 dark:border-zinc-600 rounded-lg w-56 focus:outline-none focus:border-primary" />
        </div>
      </div>

      {/* User Table */}
      <div className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 dark:border-zinc-700 bg-gray-50/50 dark:bg-zinc-800/50">
              <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">User</th>
              <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Department</th>
              <th className="text-center text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Tier</th>
              <th className="text-center text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Status</th>
              <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, visibleCount).map(u => {
              const userTier = resolveTier(u);
              const badge = TIER_BADGE[userTier] || TIER_BADGE[TIER_4];
              const canChangeThisUserTier = grantableTiers.length > 0 && u.id !== currentUser?.id;
              // Build the dropdown options. Always include the user's CURRENT
              // tier (so the select can render their state) plus every tier
              // the actor is allowed to grant. Tier 3/4 actors see no options
              // beyond the read-only current-tier label.
              const optionTiers = Array.from(new Set([
                userTier,
                ...grantableTiers.map(g => g.value),
              ])).sort((a, b) => a - b);
              return (
                <tr key={u.id} className="border-b border-gray-50 dark:border-zinc-700/50 hover:bg-gray-50/50 dark:hover:bg-zinc-700/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={u.name} size="sm" />
                      <div>
                        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{u.name}</p>
                        <p className="text-[10px] text-gray-400">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-500">{u.department || '—'}</span>
                    {u.designation && <p className="text-[10px] text-gray-400">{u.designation}</p>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <select value={userTier} onChange={e => requestTierChange(u, Number(e.target.value))}
                      disabled={!canChangeThisUserTier || tierChanging === u.id}
                      className={`text-xs font-semibold px-2.5 py-1 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/30 ${badge.bg} ${badge.text} disabled:cursor-not-allowed disabled:opacity-80`}>
                      {optionTiers.map(t => (
                        <option key={t} value={t}>{tierLabel(t)}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${u.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      <div className={`w-1.5 h-1.5 rounded-full ${u.isActive ? 'bg-green-500' : 'bg-gray-400'}`} />
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="relative inline-block">
                      <button onClick={() => setActionMenu(actionMenu === u.id ? null : u.id)}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-zinc-700 rounded-md transition-colors">
                        <MoreHorizontal size={14} />
                      </button>
                      {actionMenu === u.id && (
                        <div className="absolute right-0 top-full mt-1 bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-lg shadow-xl z-20 w-44 py-1">
                          <button onClick={() => { setEditUser(u); setActionMenu(null); }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700">
                            <Edit2 size={12} /> Edit User
                          </button>
                          <button onClick={() => { setShowReset(u); setActionMenu(null); }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700">
                            <KeyRound size={12} /> Reset Password
                          </button>
                          <button onClick={() => handleToggleStatus(u.id)}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700">
                            {u.isActive ? <><UserX size={12} /> Deactivate</> : <><UserCheck size={12} /> Activate</>}
                          </button>
                          {/* Tier 1 users cannot be deleted via this UI — server-side last-Tier-1 protection enforces the same rule. */}
                          {resolveTier(u) !== TIER_1 && actorTier === TIER_1 && (
                            <button onClick={() => { handleDelete(u.id, u.name); setActionMenu(null); }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
                              <Trash2 size={12} /> Delete User
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-sm text-gray-400">
                <Users size={32} className="mx-auto mb-2 opacity-40" />
                No users found
              </td></tr>
            )}
          </tbody>
        </table>
        {filtered.length > visibleCount && (
          <div className="text-center py-3 border-t border-gray-100">
            <button onClick={() => setVisibleCount(prev => prev + 25)}
              className="text-xs text-primary hover:text-primary-dark font-medium transition-colors">
              Show more ({filtered.length - visibleCount} remaining)
            </button>
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreate && <CreateUserModal isOpen={showCreate} onClose={() => setShowCreate(false)} onCreated={fetchUsers} />}
      {showReset && <ResetPasswordModal isOpen={!!showReset} onClose={() => setShowReset(null)} user={showReset} />}
      {editUser && (
        <EditUserModal
          isOpen={!!editUser}
          onClose={() => setEditUser(null)}
          user={editUser}
          isAdmin={canEditPrivileged}
          onUpdated={fetchUsers}
          onToast={({ type, message }) => (toast[type] || toast.info)(message)}
        />
      )}
      <TierChangeConfirmModal
        pending={pendingTierChange}
        isSubmitting={!!pendingTierChange && tierChanging === pendingTierChange.user.id}
        onCancel={cancelTierChange}
        onConfirm={confirmTierChange}
      />
    </div>
  );
}

function TierChangeConfirmModal({ pending, isSubmitting, onCancel, onConfirm }) {
  if (!pending) return null;
  const { user, oldTier, newTier } = pending;
  const oldBadge = TIER_BADGE[oldTier] || TIER_BADGE[TIER_4];
  const newBadge = TIER_BADGE[newTier] || TIER_BADGE[TIER_4];

  return (
    <Modal
      isOpen={!!pending}
      onClose={onCancel}
      title="Confirm Tier Change"
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-gray-200 dark:border-zinc-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
          >
            {isSubmitting && <RefreshCw size={12} className="animate-spin" />}
            {isSubmitting ? 'Updating…' : 'Confirm Changes'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Avatar name={user.name} size="md" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">{user.name}</p>
            <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
          </div>
        </div>

        <div className="rounded-lg border border-gray-100 dark:border-zinc-700 bg-gray-50/60 dark:bg-zinc-900/40 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-gray-400">Current</span>
              <span className={`mt-1 inline-flex items-center self-start text-[11px] font-semibold px-2 py-0.5 rounded-full ${oldBadge.bg} ${oldBadge.text}`}>
                {tierLabel(oldTier)}
              </span>
            </div>
            <ChevronRight size={16} className="text-gray-400 shrink-0" />
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-gray-400">New</span>
              <span className={`mt-1 inline-flex items-center self-start text-[11px] font-semibold px-2 py-0.5 rounded-full ${newBadge.bg} ${newBadge.text}`}>
                {tierLabel(newTier)}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
          <AlertCircle size={14} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
            This will change the user's tier-based permissions immediately.
            They may gain or lose the ability to manage boards, users, or sensitive settings.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function WorkspacesTab() {
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', color: '#0073ea', icon: 'Briefcase' });
  const [editId, setEditId] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [allBoards, setAllBoards] = useState([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState(null);
  const [assignUserId, setAssignUserId] = useState('');
  const [assignBoardId, setAssignBoardId] = useState('');

  useEffect(() => {
    fetchAll();
  }, []);

  async function fetchAll() {
    try {
      const [wsRes, usersRes, boardsRes] = await Promise.all([
        api.get('/workspaces'),
        api.get('/auth/users'),
        api.get('/boards'),
      ]);
      setWorkspaces(wsRes.data.workspaces || []);
      setAllUsers(usersRes.data.users || usersRes.data || []);
      setAllBoards(boardsRes.data.boards || []);
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    try {
      if (editId) {
        await api.put(`/workspaces/${editId}`, form);
      } else {
        await api.post('/workspaces', form);
      }
      setForm({ name: '', description: '', color: '#0073ea', icon: 'Briefcase' });
      setShowCreate(false);
      setEditId(null);
      fetchAll();
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this workspace?')) return;
    try {
      await api.delete(`/workspaces/${id}`);
      fetchAll();
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    }
  }

  async function handleAssignMembers(wsId) {
    if (!assignUserId) return;
    try {
      await api.post(`/workspaces/${wsId}/members`, { userIds: [assignUserId] });
      setAssignUserId('');
      fetchAll();
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    }
  }

  async function handleRemoveMember(wsId, userId) {
    try {
      await api.delete(`/workspaces/${wsId}/members/${userId}`);
      fetchAll();
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    }
  }

  async function handleAssignBoard(wsId) {
    if (!assignBoardId) return;
    try {
      await api.post(`/workspaces/${wsId}/boards`, { boardId: assignBoardId });
      setAssignBoardId('');
      fetchAll();
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    }
  }

  if (loading) return <div className="animate-pulse space-y-3">{[1,2,3].map(i => <div key={i} className="h-20 bg-gray-100 dark:bg-zinc-800 rounded-xl" />)}</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Workspaces</h2>
        <button onClick={() => { setShowCreate(true); setEditId(null); setForm({ name: '', description: '', color: '#0073ea', icon: 'Briefcase' }); }}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors">
          <Plus size={14} /> Create Workspace
        </button>
      </div>

      {/* Create/Edit Form */}
      <AnimatePresence>
        {showCreate && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-5 mb-4">
            <h3 className="text-sm font-semibold mb-3">{editId ? 'Edit Workspace' : 'New Workspace'}</h3>
            <div className="grid grid-cols-2 gap-3">
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="Workspace name" className="px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary" />
              <input type="text" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="Description" className="px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary" />
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">Color:</label>
                <input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })} className="w-8 h-8 rounded cursor-pointer" />
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={handleCreate} className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary/90">{editId ? 'Update' : 'Create'}</button>
              <button onClick={() => { setShowCreate(false); setEditId(null); }} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Workspace List */}
      <div className="space-y-4">
        {workspaces.map(ws => (
          <motion.div key={ws.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
            <div className="flex items-center justify-between p-4 cursor-pointer" onClick={() => setSelectedWorkspace(selectedWorkspace === ws.id ? null : ws.id)}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${ws.color}20` }}>
                  <Briefcase size={18} style={{ color: ws.color }} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{ws.name}</h3>
                  <p className="text-xs text-gray-500">{ws.description || 'No description'} · {ws.boards?.length || 0} boards · {ws.workspaceMembers?.length || 0} members</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={(e) => { e.stopPropagation(); setEditId(ws.id); setForm({ name: ws.name, description: ws.description, color: ws.color, icon: ws.icon }); setShowCreate(true); }}
                  className="p-1.5 text-gray-400 hover:text-primary rounded-md hover:bg-gray-50 dark:hover:bg-zinc-700"><Edit2 size={14} /></button>
                <button onClick={(e) => { e.stopPropagation(); handleDelete(ws.id); }}
                  className="p-1.5 text-gray-400 hover:text-red-500 rounded-md hover:bg-gray-50 dark:hover:bg-zinc-700"><Trash2 size={14} /></button>
                <ChevronRight size={16} className={`text-gray-400 transition-transform ${selectedWorkspace === ws.id ? 'rotate-90' : ''}`} />
              </div>
            </div>

            {/* Expanded details */}
            <AnimatePresence>
              {selectedWorkspace === ws.id && (
                <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
                  <div className="border-t border-gray-100 dark:border-zinc-700 p-4 space-y-4">
                    {/* Members */}
                    <div>
                      <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Members</h4>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {(ws.workspaceMembers || []).map(m => (
                          <div key={m.id} className="flex items-center gap-1.5 bg-gray-50 dark:bg-zinc-700 rounded-full pl-1 pr-2 py-1">
                            <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center text-[9px] font-bold text-primary">
                              {m.avatar ? <img src={m.avatar} className="w-5 h-5 rounded-full" /> : m.name?.charAt(0)}
                            </div>
                            <span className="text-[11px] text-gray-700 dark:text-gray-300">{m.name}</span>
                            <button onClick={() => handleRemoveMember(ws.id, m.id)} className="text-gray-400 hover:text-red-500"><X size={10} /></button>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <select value={assignUserId} onChange={e => setAssignUserId(e.target.value)}
                          className="text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 flex-1 focus:outline-none focus:border-primary">
                          <option value="">Select user to add...</option>
                          {allUsers.filter(u => !(ws.workspaceMembers || []).find(m => m.id === u.id)).map(u => (
                            <option key={u.id} value={u.id}>{u.name} ({tierLabel(resolveTier(u))})</option>
                          ))}
                        </select>
                        <button onClick={() => handleAssignMembers(ws.id)} className="px-3 py-1.5 bg-primary text-white text-xs rounded-md hover:bg-primary/90">
                          <UserPlus size={12} />
                        </button>
                      </div>
                    </div>

                    {/* Boards */}
                    <div>
                      <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Boards</h4>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {(ws.boards || []).map(b => (
                          <div key={b.id} className="flex items-center gap-1.5 bg-gray-50 dark:bg-zinc-700 rounded-md px-2.5 py-1.5">
                            <div className="w-2.5 h-2.5 rounded" style={{ backgroundColor: b.color }} />
                            <span className="text-[11px] text-gray-700 dark:text-gray-300">{b.name}</span>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <select value={assignBoardId} onChange={e => setAssignBoardId(e.target.value)}
                          className="text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 flex-1 focus:outline-none focus:border-primary">
                          <option value="">Assign board...</option>
                          {allBoards.filter(b => !b.workspaceId || b.workspaceId !== ws.id).map(b => (
                            <option key={b.id} value={b.id}>{b.name}</option>
                          ))}
                        </select>
                        <button onClick={() => handleAssignBoard(ws.id)} className="px-3 py-1.5 bg-primary text-white text-xs rounded-md hover:bg-primary/90">Add</button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        ))}

        {workspaces.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <LayoutGrid size={32} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">No workspaces created yet</p>
          </div>
        )}
      </div>
    </div>
  );
}

function MultiSelectDropdown({ label, options, selected, onChange, groupedOptions, placeholder, renderOption }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = React.useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const allOptions = groupedOptions
    ? Object.values(groupedOptions).flat()
    : (options || []);

  const filtered = search
    ? allOptions.filter(o => {
        const label = typeof o === 'string' ? o : (o.label || o.key || '');
        return label.toLowerCase().includes(search.toLowerCase());
      })
    : null;

  function isDisabled(o) {
    return typeof o === 'object' && o !== null && !!o.disabled;
  }

  function toggle(value, optDisabled = false) {
    // Phase 7 — disabled options (enforcement: pending / locked / no_surface)
    // are not togglable from the UI. Backend would reject them anyway with
    // PERMISSION_NOT_ENFORCEABLE / PERMISSION_LOCKED.
    if (optDisabled) return;
    if (selected.includes(value)) {
      onChange(selected.filter(v => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  function selectAll() {
    // Skip disabled options on select-all so we never auto-select non-savable
    // actions (which would silently strip on submit).
    const allKeys = allOptions
      .filter((o) => !isDisabled(o))
      .map(o => typeof o === 'string' ? o : o.key);
    onChange(allKeys);
  }

  function clearAll() { onChange([]); }

  return (
    <div ref={ref} className="relative">
      <label className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1 block">{label}</label>
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm text-left focus:outline-none focus:border-primary dark:bg-zinc-700 dark:text-gray-200 flex items-center justify-between min-h-[38px]">
        {selected.length === 0
          ? <span className="text-gray-400">{placeholder || 'Select...'}</span>
          : <span className="text-gray-700 dark:text-gray-200">{selected.length} selected</span>
        }
        <ChevronRight size={14} className={`text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {selected.map(key => {
            const opt = allOptions.find(o => (typeof o === 'string' ? o : o.key) === key);
            const display = typeof opt === 'string' ? (ACTIONS[opt]?.label || opt) : (opt?.label || key);
            return (
              <span key={key} className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary text-[11px] font-medium rounded-full">
                {display}
                <button type="button" onClick={(e) => { e.stopPropagation(); toggle(key); }} className="hover:text-red-500 transition-colors">
                  <X size={10} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Dropdown panel */}
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-600 rounded-lg shadow-xl max-h-64 overflow-hidden flex flex-col">
          {/* Search + Select all / Clear */}
          <div className="p-2 border-b border-gray-100 dark:border-zinc-700 flex flex-col gap-1.5">
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..."
              className="w-full px-2.5 py-1.5 border border-gray-200 dark:border-zinc-600 rounded-md text-xs focus:outline-none focus:border-primary dark:bg-zinc-700 dark:text-gray-200" />
            <div className="flex gap-2">
              <button type="button" onClick={selectAll} className="text-[10px] text-primary hover:underline font-medium">Select All</button>
              <button type="button" onClick={clearAll} className="text-[10px] text-gray-400 hover:text-red-500 font-medium">Clear</button>
            </div>
          </div>

          {/* Options list. Phase 7 — supports per-option badge / disabled
              metadata so the Actions dropdown can render "Pending",
              "Locked", "Dangerous" labels and prevent selection of
              non-savable actions. */}
          <div className="overflow-y-auto flex-1 py-1">
            {(() => {
              const renderOpt = (o) => {
                const key = typeof o === 'string' ? o : o.key;
                const display = typeof o === 'string' ? (ACTIONS[o]?.label || o) : (o.label || o.key);
                const desc = typeof o === 'string' ? (ACTIONS[o]?.description || '') : (o.description || '');
                const disabled = isDisabled(o);
                const badge = typeof o === 'object' ? o.badge : null;
                const badgeTone = typeof o === 'object' ? o.badgeTone : null;
                const isSelected = selected.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggle(key, disabled)}
                    disabled={disabled}
                    title={disabled ? (typeof o === 'object' && o.reason) || 'Not available' : (desc || '')}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                      disabled
                        ? 'opacity-50 cursor-not-allowed'
                        : 'hover:bg-gray-50 dark:hover:bg-zinc-700'
                    } ${isSelected ? 'bg-primary/5' : ''}`}
                  >
                    <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-gray-300 dark:border-zinc-500'}`}>
                      {isSelected && <Check size={9} className="text-white" />}
                    </div>
                    <span className="font-medium text-gray-700 dark:text-gray-300">{display}</span>
                    {badge && (
                      <span className={`ml-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                        badgeTone === 'red' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                        : badgeTone === 'amber' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                        : badgeTone === 'gray' ? 'bg-gray-100 text-gray-600 dark:bg-zinc-700 dark:text-zinc-300'
                        : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                      }`}>{badge}</span>
                    )}
                    {!badge && desc && <span className="text-gray-400 text-[10px] ml-auto">{desc}</span>}
                  </button>
                );
              };

              if (filtered) return filtered.map(renderOpt);
              if (groupedOptions) {
                return Object.entries(groupedOptions).map(([category, items]) => (
                  <div key={category}>
                    <div className="px-3 py-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50/50 dark:bg-zinc-800/50 sticky top-0">{category}</div>
                    {items.map(renderOpt)}
                  </div>
                ));
              }
              return allOptions.map(renderOpt);
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

function PermissionsTab() {
  const { user: currentUser } = useAuth();
  const currentUserTier = resolveTier(currentUser);
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [users, setUsers] = useState([]);
  const [showGrant, setShowGrant] = useState(false);
  const [form, setForm] = useState({ userId: '', resources: [], actions: [], expiresAt: '', reason: '', scope: 'global', effect: 'grant' });
  const [grantError, setGrantError] = useState('');
  const [grantSuccess, setGrantSuccess] = useState('');
  const [granting, setGranting] = useState(false);
  const [effectiveUser, setEffectiveUser] = useState('');
  const [effectiveData, setEffectiveData] = useState(null);
  const [effectiveLoading, setEffectiveLoading] = useState(false);
  const [historyUser, setHistoryUser] = useState('');
  const [historyData, setHistoryData] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [filterResource, setFilterResource] = useState('');
  // Phase B — by default, the actions dropdown shows ONLY savable/wired
  // entries to reduce the visual noise from pending / locked / no_surface
  // catalog entries. Operators can flip this toggle to see the full
  // catalog and understand why an action isn't currently grantable.
  const [showNonSavable, setShowNonSavable] = useState(false);

  // Phase 6 — canonical catalog fetched from the backend. Includes resources,
  // actions, and per-(resource,action) grantability flags so the UI can hide
  // or disable actions the current admin cannot legitimately grant/deny.
  // Falls back to the bundled RESOURCES/RESOURCE_ACTIONS constants on first
  // paint so the form is usable even before the API returns.
  const [catalog, setCatalog] = useState(null);

  const resourcesByCategory = catalog?.resourcesByCategory
    || getResourcesByCategory();
  const resourceActionsMap = catalog?.resourceActions || RESOURCE_ACTIONS;
  const grantabilityMap = catalog?.grantability || {};
  const selectedUser = users.find(u => u.id === form.userId);

  // Helper: is (resource, action) grantable/deniable by the current admin?
  // Defaults to the bundled action list if the catalog hasn't loaded yet.
  function isAuthoredByCurrentUser(resource, action, effect) {
    const g = grantabilityMap[resource]?.[action];
    if (!g) {
      // Catalog not loaded yet — fall back to "allow" so the dropdown
      // stays usable; the backend will still reject if the pair is
      // non-grantable.
      return true;
    }
    const list = effect === 'deny' ? g.deniableBy : g.grantableBy;
    return Array.isArray(list) && list.includes(currentUserTier);
  }

  function actionsForResource(resource) {
    return resourceActionsMap[resource] || getActionsForResource(resource);
  }

  // Compute available actions per Phase 7 — every catalog action for the
  // selected resources is surfaced, with metadata. Non-savable actions
  // (pending / locked / no_surface) are RENDERED but DISABLED with an
  // explanatory badge instead of being silently hidden, so admins can see
  // the full intended catalog and understand why each row isn't settable.
  // Actions outside the grantability for the current admin's tier ARE
  // hidden (they could neither grant nor deny these anyway).
  const availableActions = React.useMemo(() => {
    if (form.resources.length === 0) return [];
    const out = [];
    const seen = new Set();
    for (const r of form.resources) {
      for (const a of actionsForResource(r)) {
        if (seen.has(a)) continue;
        seen.add(a);
        const meta = catalog?.meta?.[`${r}.${a}`] || {};
        const enforcement = meta.enforcement || 'wired';
        const dangerous = !!meta.dangerous;
        const warnOnDeny = !!meta.warnOnDeny;
        const grantable = isAuthoredByCurrentUser(r, a, form.effect);

        // Build per-option object. Hide entries the current admin is not
        // authorised to author (true "not your business"); render but
        // disable non-savable entries (visible but unusable).
        const isWired = enforcement === 'wired';
        if (!grantable && isWired) continue; // hidden by GRANTABILITY for current tier

        let badge = null;
        let badgeTone = null;
        let disabled = false;
        let reason = null;
        if (enforcement === 'locked') {
          badge = 'Locked';
          badgeTone = 'red';
          disabled = true;
          reason = 'System rule — cannot be granted or denied via overrides.';
        } else if (enforcement === 'no_surface') {
          badge = 'Not enforceable';
          badgeTone = 'gray';
          disabled = true;
          reason = 'No in-app surface to gate — granting / denying would have no effect.';
        } else if (enforcement === 'pending') {
          badge = 'Pending';
          badgeTone = 'amber';
          disabled = true;
          reason = 'Not yet wired in the backend — saving would have no effect.';
        } else if (dangerous) {
          badge = 'Dangerous';
          badgeTone = 'red';
        } else if (warnOnDeny && form.effect === 'deny') {
          badge = 'Default ON';
          badgeTone = 'amber';
        }

        // Phase B — default behavior: hide non-savable entries to reduce
        // visual noise. Operator can toggle "Show non-wired" to see the
        // full catalog with explanatory badges.
        if (disabled && !showNonSavable) continue;

        out.push({
          key: a,
          label: ACTIONS[a]?.label || a,
          description: ACTIONS[a]?.description || '',
          disabled,
          badge,
          badgeTone,
          reason,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.resources, form.effect, catalog, currentUserTier, showNonSavable]);

  // Count actions that were filtered out by grantability so we can show a
  // small explainer banner. This is a UX signal that the catalog is active —
  // operators learn which (resource, action) pairs are reserved for higher
  // tiers rather than chasing silent submit failures.
  const filteredOutActions = React.useMemo(() => {
    if (form.resources.length === 0) return [];
    const blocked = [];
    for (const r of form.resources) {
      for (const a of actionsForResource(r)) {
        if (!isAuthoredByCurrentUser(r, a, form.effect)) {
          blocked.push({ resource: r, action: a });
        }
      }
    }
    return blocked;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.resources, form.effect, catalog, currentUserTier]);

  // Build preview: which resource+action combos will be created
  const grantPreview = React.useMemo(() => {
    if (form.resources.length === 0 || form.actions.length === 0) return [];
    const entries = [];
    for (const r of form.resources) {
      const validActions = getActionsForResource(r);
      const matching = form.actions.filter(a => validActions.includes(a));
      if (matching.length > 0) {
        entries.push({ resource: r, label: RESOURCES[r]?.label || r, actions: matching });
      }
    }
    return entries;
  }, [form.resources, form.actions]);

  const totalCombinations = grantPreview.reduce((sum, e) => sum + e.actions.length, 0);

  useEffect(() => { fetchData(); }, []);

  // Map a failed permissions request to a clear, status-aware message instead
  // of the generic "Failed to fetch permissions." toast. Pass `_silent: true`
  // so the global axios interceptor does not also fire its toast — we render
  // our own inline banner with a Retry button.
  function describePermissionsError(err) {
    const status = err?.response?.status;
    const serverMessage = err?.response?.data?.message;
    if (status === 401) return 'Your session has expired or is unauthorized. Please log in again.';
    if (status === 403) return 'You do not have permission to view permission settings.';
    if (status === 404) return 'Permissions API route not found. This is a deployment or backend route issue — contact an administrator.';
    if (status === 500) return serverMessage || 'Server error loading permissions. Check backend logs for details.';
    if (!err?.response) return 'Network error. Could not reach the permissions API.';
    return serverMessage || 'Could not load permissions.';
  }

  async function fetchData() {
    setLoadError('');
    // Fetch users, permissions, and the canonical catalog in parallel so a
    // single failure does not block the others. Catalog failures are
    // recoverable — the form falls back to the bundled RESOURCE_ACTIONS list
    // and the backend remains the authoritative gate on submission.
    const [permResult, usersResult, catalogResult] = await Promise.allSettled([
      api.get('/permissions', { _silent: true }),
      api.get('/auth/users', { _silent: true }),
      api.get('/permissions/catalog', { _silent: true }),
    ]);

    if (permResult.status === 'fulfilled') {
      setPermissions(permResult.value.data.permissions || []);
    } else {
      safeLog.error('[Permissions] load failed', permResult.reason);
      setLoadError(describePermissionsError(permResult.reason));
    }

    if (usersResult.status === 'fulfilled') {
      const d = usersResult.value.data;
      setUsers(d.users || d || []);
    } else {
      safeLog.error('[Permissions] users load failed', usersResult.reason);
    }

    if (catalogResult.status === 'fulfilled') {
      // API shape: { data: { catalog: { resources, actions, resourceActions,
      //   resourcesByCategory, grantability, tierPermissions } } }
      const cat = catalogResult.value.data?.data?.catalog
        || catalogResult.value.data?.catalog;
      if (cat) setCatalog(cat);
    } else {
      safeLog.warn('[Permissions] catalog load failed (using bundled fallback)', catalogResult.reason);
    }

    setLoading(false);
  }

  // When the user toggles between Grant and Deny — or selects new resources —
  // some previously-selected actions may become non-grantable or non-savable.
  // Strip them silently so the operator is never holding an invalid selection
  // that the backend would reject. Phase 7 — only keeps actions that are
  // present AND not disabled (locked / pending / no_surface).
  useEffect(() => {
    if (form.actions.length === 0) return;
    const validKeys = new Set(
      availableActions.filter((o) => !o.disabled).map((o) => o.key)
    );
    const stillValid = form.actions.filter((a) => validKeys.has(a));
    if (stillValid.length !== form.actions.length) {
      setForm((prev) => ({ ...prev, actions: stillValid }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.effect, form.resources, catalog]);

  async function handleGrant() {
    setGrantError('');
    setGrantSuccess('');
    if (!form.userId || form.resources.length === 0 || form.actions.length === 0) {
      setGrantError('Please select user, at least one resource, and at least one action.');
      return;
    }

    // Phase 7 — dangerous-action warning. Confirm before granting a
    // dangerous action OR denying a default-everyone action (warnOnDeny).
    // Native confirm keeps the UI footprint small while making the rule
    // explicit. The label is built per-pair so the admin sees what
    // they're about to do.
    const warnings = [];
    for (const r of form.resources) {
      for (const a of form.actions) {
        const meta = catalog?.meta?.[`${r}.${a}`] || {};
        if (form.effect === 'grant' && meta.dangerous) {
          warnings.push(`Grant DANGEROUS: ${r}.${a}`);
        }
        if (form.effect === 'deny' && meta.warnOnDeny) {
          warnings.push(`Deny default-on action: ${r}.${a}`);
        }
      }
    }
    if (warnings.length > 0) {
      // eslint-disable-next-line no-alert
      const ok = window.confirm(
        `You are about to apply ${warnings.length} sensitive change(s):\n\n`
        + warnings.slice(0, 6).join('\n')
        + (warnings.length > 6 ? `\n... and ${warnings.length - 6} more` : '')
        + `\n\nDeny overrides win over base role and grant. Continue?`
      );
      if (!ok) return;
    }

    setGranting(true);
    try {
      const res = await api.post('/permissions/multi', {
        userId: form.userId,
        resources: form.resources,
        actions: form.actions,
        scope: form.scope || 'global',
        expiresAt: form.expiresAt || null,
        reason: form.reason || null,
        effect: form.effect || 'grant',
      });
      const s = res.data?.data?.summary || {};
      const parts = [];
      if (s.created > 0) parts.push(`${s.created} created`);
      if (s.updated > 0) parts.push(`${s.updated} updated`);
      if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
      const verb = form.effect === 'deny' ? 'denied' : 'granted';
      setGrantSuccess(`Permissions ${verb} successfully (${parts.join(', ')}).`);
      setForm({ userId: '', resources: [], actions: [], expiresAt: '', reason: '', scope: 'global', effect: 'grant' });
      fetchData();
      setTimeout(() => setGrantSuccess(''), 6000);
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to grant permissions.';
      setGrantError(msg);
    } finally { setGranting(false); }
  }

  async function handleRevoke(id) {
    try {
      await api.delete(`/permissions/${id}`);
      fetchData();
    } catch (err) { safeLog.error('[AdminSettings] error', err); }
  }

  async function fetchEffective() {
    if (!effectiveUser) return;
    setEffectiveLoading(true);
    try {
      const res = await api.get(`/permissions/effective/${effectiveUser}`);
      setEffectiveData(res.data.effective);
    } catch (err) { safeLog.error('[AdminSettings] error', err); }
    finally { setEffectiveLoading(false); }
  }

  async function fetchHistory(userId) {
    setHistoryUser(userId);
    setShowHistory(true);
    try {
      const res = await api.get(`/permissions/history/${userId}`);
      setHistoryData(res.data.history || []);
    } catch (err) { safeLog.error('[AdminSettings] error', err); }
  }

  const filteredPermissions = filterResource
    ? permissions.filter(p => p.resourceType === filterResource)
    : permissions;

  if (loading) return <div className="animate-pulse space-y-3">{[1,2,3].map(i => <div key={i} className="h-16 bg-gray-100 dark:bg-zinc-800 rounded-xl" />)}</div>;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Permission Overrides</h2>
          <p className="text-xs text-gray-500 mt-0.5">Grant extra permissions beyond a user's base role, or deny a default permission for a specific user. Deny wins over grant and role default.</p>
        </div>
        <button onClick={() => { setShowGrant(!showGrant); setGrantError(''); setGrantSuccess(''); }}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors">
          <Plus size={14} /> Grant / Deny
        </button>
      </div>

      {loadError && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 dark:border-red-800/60 bg-red-50 dark:bg-red-900/20 px-4 py-3">
          <div className="flex items-start gap-2 text-sm">
            <AlertCircle size={16} className="text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-semibold text-red-700 dark:text-red-300">Could not load permissions</div>
              <div className="text-red-600 dark:text-red-300/80 mt-0.5">{loadError}</div>
            </div>
          </div>
          <button
            onClick={() => { setLoading(true); fetchData(); }}
            className="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Grant form */}
      <AnimatePresence>
        {showGrant && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-5">

            {/* Row 0: Effect — Grant or Deny */}
            <div className="mb-4">
              <label className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1 block">Effect</label>
              <div className="inline-flex rounded-lg border border-gray-200 dark:border-zinc-600 overflow-hidden text-sm">
                <button type="button"
                  onClick={() => setForm({ ...form, effect: 'grant' })}
                  className={`px-4 py-2 font-medium transition-colors ${form.effect !== 'deny'
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                    : 'bg-white dark:bg-zinc-700 text-gray-500 hover:bg-gray-50 dark:hover:bg-zinc-600'}`}>
                  Grant — add permission
                </button>
                <button type="button"
                  onClick={() => setForm({ ...form, effect: 'deny' })}
                  className={`px-4 py-2 font-medium transition-colors border-l border-gray-200 dark:border-zinc-600 ${form.effect === 'deny'
                    ? 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                    : 'bg-white dark:bg-zinc-700 text-gray-500 hover:bg-gray-50 dark:hover:bg-zinc-600'}`}>
                  Deny — block permission
                </button>
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                {form.effect === 'deny'
                  ? 'Deny overrides win over role defaults and grants. Use to revoke a default permission for one user.'
                  : 'Grant adds extra permissions beyond the user\'s base role.'}
              </p>
            </div>

            {/* Row 1: User */}
            <div className="mb-4">
              <label className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1 block">User</label>
              <select value={form.userId} onChange={e => setForm({ ...form, userId: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary dark:bg-zinc-700 dark:text-gray-200">
                <option value="">Select user...</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.name} ({tierLabel(resolveTier(u))})</option>
                ))}
              </select>
              {selectedUser && (() => {
                const selUserTier = resolveTier(selectedUser);
                const selBadge = TIER_BADGE[selUserTier] || TIER_BADGE[TIER_4];
                return (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">{selectedUser.name?.charAt(0)}</div>
                    <div>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{selectedUser.name}</span>
                      <span className={`ml-2 text-[10px] font-semibold px-2 py-0.5 rounded-full ${selBadge.bg} ${selBadge.text}`}>
                        {tierLabel(selUserTier)}
                      </span>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Phase B — non-wired filter toggle. Default OFF so the operator
                sees only actions that can actually be granted/denied. Flip
                ON to see the full catalog with Pending / Locked / Not
                enforceable badges and per-action explanations. */}
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                {showNonSavable
                  ? 'Showing the full catalog including non-savable entries (greyed out).'
                  : 'Showing only actions that can be granted or denied (current default).'}
              </p>
              <label className="inline-flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showNonSavable}
                  onChange={(e) => setShowNonSavable(e.target.checked)}
                  className="w-3 h-3 rounded border-gray-300 text-primary focus:ring-0"
                />
                Show pending / locked / not-enforceable actions
              </label>
            </div>

            {/* Row 2: Multi-select Resource + Multi-select Action */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <MultiSelectDropdown
                label={`Resources / Modules${form.resources.length > 0 ? ` (${form.resources.length})` : ''}`}
                selected={form.resources}
                onChange={resources => {
                  // When resources change, filter out actions that are no longer valid
                  const newActionSet = new Set();
                  for (const r of resources) {
                    for (const a of getActionsForResource(r)) newActionSet.add(a);
                  }
                  const filteredActions = form.actions.filter(a => newActionSet.has(a));
                  setForm({ ...form, resources, actions: filteredActions });
                }}
                groupedOptions={resourcesByCategory}
                placeholder="Select resources..."
              />
              <MultiSelectDropdown
                label={`Actions${form.actions.length > 0 ? ` (${form.actions.length})` : ''}`}
                selected={form.actions}
                onChange={actions => setForm({ ...form, actions })}
                options={availableActions}
                placeholder={form.resources.length > 0 ? 'Select actions...' : 'Select resources first'}
              />
            </div>

            {/* Selection summary */}
            {form.resources.length > 0 && form.actions.length > 0 && (
              <div className="mb-4 text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
                <Shield size={12} className="text-primary" />
                <span>{form.resources.length} resource{form.resources.length > 1 ? 's' : ''} × {form.actions.length} action{form.actions.length > 1 ? 's' : ''} = <strong className="text-gray-700 dark:text-gray-200">{totalCombinations} permission{totalCombinations !== 1 ? 's' : ''}</strong></span>
              </div>
            )}

            {/* Grantability hint — surfaces when the GRANTABILITY catalog
                hides actions for the current admin's tier. Without this,
                operators wonder why expected actions don't appear in the
                dropdown (the backend would reject them anyway, but silent
                filtering is confusing). */}
            {filteredOutActions.length > 0 && form.resources.length > 0 && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/15 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <div>
                  <strong className="font-semibold">{filteredOutActions.length} action{filteredOutActions.length === 1 ? '' : 's'} hidden</strong>
                  {' '}— reserved for higher tiers, destructive, or system-only. Examples:{' '}
                  <span className="font-mono">
                    {filteredOutActions.slice(0, 4).map((p) => `${p.resource}.${p.action}`).join(', ')}
                    {filteredOutActions.length > 4 ? `, +${filteredOutActions.length - 4} more` : ''}
                  </span>
                  {form.effect === 'grant' && (
                    <>. Switch to <strong>Deny</strong> to revoke (if your tier permits) or promote the user instead.</>
                  )}
                </div>
              </div>
            )}

            {/* Grant preview */}
            {grantPreview.length > 0 && (
              <div className="mb-4 p-3 bg-gray-50 dark:bg-zinc-700/30 rounded-lg border border-gray-100 dark:border-zinc-700">
                <p className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Preview — permissions to grant</p>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {grantPreview.map(entry => (
                    <div key={entry.resource} className="flex items-start gap-2">
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-300 w-32 shrink-0">{entry.label}</span>
                      <div className="flex flex-wrap gap-1">
                        {entry.actions.map(a => (
                          <span key={a} className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                            style={{ backgroundColor: `${LEVEL_COLORS[a] || '#ccc'}15`, color: LEVEL_COLORS[a] || '#666' }}>
                            {ACTIONS[a]?.label || a}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                {/* Show skipped actions (selected but not valid for some resources) */}
                {form.resources.some(r => {
                  const valid = getActionsForResource(r);
                  return form.actions.some(a => !valid.includes(a));
                }) && (
                  <p className="text-[10px] text-amber-600 mt-2 flex items-center gap-1">
                    <AlertCircle size={10} /> Some actions are not valid for all selected resources and will be skipped automatically.
                  </p>
                )}
              </div>
            )}

            {/* Row 3: Scope + Expiry + Reason */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1 block">Scope</label>
                <select value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary dark:bg-zinc-700 dark:text-gray-200">
                  <option value="global">Global (all instances)</option>
                  <option value="workspace">Workspace-specific</option>
                  <option value="board">Board-specific</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1 block">Expires (optional)</label>
                <input type="datetime-local" value={form.expiresAt} onChange={e => setForm({ ...form, expiresAt: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary dark:bg-zinc-700 dark:text-gray-200" />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1 block">Reason (optional)</label>
                <input type="text" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}
                  placeholder="Why is this override needed?"
                  className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary dark:bg-zinc-700 dark:text-gray-200" />
              </div>
            </div>

            {/* Messages */}
            {grantError && (
              <div className="mb-3 flex items-center gap-2 text-xs text-red-600 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
                <AlertCircle size={14} /> {grantError}
              </div>
            )}
            {grantSuccess && (
              <div className="mb-3 flex items-center gap-2 text-xs text-green-600 bg-green-50 dark:bg-green-900/20 rounded-lg px-3 py-2">
                <Check size={14} /> {grantSuccess}
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-3">
              <button onClick={handleGrant} disabled={granting || !form.userId || form.resources.length === 0 || form.actions.length === 0}
                className={`px-5 py-2 text-white text-sm font-medium rounded-lg disabled:opacity-40 transition-colors flex items-center gap-2 ${form.effect === 'deny' ? 'bg-red-600 hover:bg-red-700' : 'bg-primary hover:bg-primary/90'}`}>
                {granting ? (
                  <><RefreshCw size={14} className="animate-spin" /> {form.effect === 'deny' ? 'Denying' : 'Granting'} {totalCombinations} permission{totalCombinations !== 1 ? 's' : ''}...</>
                ) : (
                  <>{form.effect === 'deny' ? 'Deny' : 'Grant'} {totalCombinations > 0 ? `${totalCombinations} Override${totalCombinations !== 1 ? 's' : ''}` : 'Override'}</>
                )}
              </button>
              <button onClick={() => { setShowGrant(false); setGrantError(''); setGrantSuccess(''); }}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Effective Permissions Preview */}
      <div className="bg-gray-50 dark:bg-zinc-800/50 rounded-xl p-4 border border-gray-100 dark:border-zinc-700">
        <h3 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2 flex items-center gap-1.5">
          <Eye size={12} /> Effective Permissions Preview
        </h3>
        <div className="flex gap-2 mb-3">
          <select value={effectiveUser} onChange={e => setEffectiveUser(e.target.value)}
            className="text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 flex-1 focus:outline-none focus:border-primary dark:bg-zinc-700 dark:text-gray-200">
            <option value="">Select user to preview...</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name} ({tierLabel(resolveTier(u))})</option>)}
          </select>
          <button onClick={fetchEffective} disabled={!effectiveUser || effectiveLoading}
            className="px-3 py-1.5 bg-primary/10 text-primary text-xs rounded-md hover:bg-primary/20 font-medium disabled:opacity-40">
            {effectiveLoading ? 'Loading...' : 'Check'}
          </button>
          {effectiveUser && (
            <button onClick={() => fetchHistory(effectiveUser)}
              className="px-3 py-1.5 bg-gray-100 dark:bg-zinc-700 text-gray-600 dark:text-gray-300 text-xs rounded-md hover:bg-gray-200 dark:hover:bg-zinc-600 font-medium flex items-center gap-1">
              <Clock size={10} /> History
            </button>
          )}
        </div>

        {effectiveData && (() => {
          const effTier = resolveTier(effectiveData);
          const effBadge = TIER_BADGE[effTier] || TIER_BADGE[TIER_4];
          return (
          <div className="space-y-3">
            {/* Tier info */}
            <div className="flex items-center gap-3 p-3 bg-white dark:bg-zinc-800 rounded-lg border border-gray-100 dark:border-zinc-700">
              <div>
                <span className="text-xs text-gray-500">Base Tier: </span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${effBadge.bg} ${effBadge.text}`}>
                  {tierLabel(effTier)}
                </span>
              </div>
              {effTier === TIER_1 && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Tier 1 — Full Access</span>
              )}
              {effectiveData.overrides?.length > 0 && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                  +{effectiveData.overrides.length} grant{effectiveData.overrides.length > 1 ? 's' : ''}
                </span>
              )}
              {effectiveData.denials?.length > 0 && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                  −{effectiveData.denials.length} deny{effectiveData.denials.length > 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Permissions by resource — Tier 1 sees no per-resource matrix; full access is implied. */}
            {effectiveData.permissions && effTier !== TIER_1 && (
              <div className="p-3 bg-white dark:bg-zinc-800 rounded-lg border border-gray-100 dark:border-zinc-700">
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Effective Permissions by Module</p>
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {Object.entries(RESOURCES).map(([resKey, resMeta]) => {
                    const resourcePerms = Object.entries(effectiveData.permissions)
                      .filter(([k]) => k.startsWith(`${resKey}.`))
                      .map(([k, v]) => ({ action: k.split('.')[1], allowed: v }));
                    if (resourcePerms.length === 0) return null;

                    const hasAny = resourcePerms.some(p => p.allowed);
                    const basePerms = effectiveData.basePermissions || {};
                    const overrideActions = (effectiveData.overrides || [])
                      .filter(o => o.resource === resKey)
                      .map(o => o.action);
                    const denialActions = (effectiveData.denials || [])
                      .filter(o => o.resource === resKey)
                      .map(o => o.action);

                    return (
                      <div key={resKey} className="flex items-start gap-3 py-1.5 border-b border-gray-50 dark:border-zinc-700/50 last:border-0">
                        <span className={`text-xs font-medium w-36 shrink-0 ${hasAny ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400'}`}>
                          {resMeta.label}
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {resourcePerms.map(p => {
                            const isOverride = overrideActions.includes(p.action);
                            const isDenied = denialActions.includes(p.action);
                            const cls = isDenied
                              ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800 line-through'
                              : p.allowed
                                ? (isOverride
                                  ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800'
                                  : 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800')
                                : 'bg-gray-50 text-gray-400 border-gray-200 dark:bg-zinc-700 dark:text-zinc-500 dark:border-zinc-600';
                            const title = isDenied
                              ? 'Explicitly denied (overrides base + grant)'
                              : p.allowed
                                ? (isOverride ? 'Override grant' : 'Base role permission')
                                : 'Not allowed';
                            const prefix = isDenied ? '−' : (isOverride ? '+' : '');
                            return (
                              <span key={p.action} className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${cls}`} title={title}>
                                {prefix}{p.action}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 flex items-center gap-4 text-[10px] text-gray-400 border-t border-gray-100 dark:border-zinc-700 pt-2">
                  <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-green-50 border border-green-200" /> Base role</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-amber-50 border border-amber-200" /> Grant override</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-red-50 border border-red-200" /> Deny override</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-gray-50 border border-gray-200" /> Not allowed</span>
                </div>
              </div>
            )}
          </div>
          );
        })()}
      </div>

      {/* Permission History Modal */}
      <AnimatePresence>
        {showHistory && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                <Clock size={14} /> Permission History
                {historyUser && <span className="text-xs text-gray-400 font-normal ml-1">for {users.find(u => u.id === historyUser)?.name}</span>}
              </h3>
              <button onClick={() => setShowHistory(false)} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
            </div>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {historyData.map((h, i) => {
                const effect = h.effect || 'grant';
                const isDeny = effect === 'deny';
                return (
                <div key={i} className={`flex items-center gap-3 text-xs p-2 rounded-lg ${h.isActive ? (isDeny ? 'bg-red-50/50 dark:bg-red-900/10' : 'bg-green-50/50 dark:bg-green-900/10') : 'bg-gray-50 dark:bg-zinc-700/30'}`}>
                  <div className={`w-2 h-2 rounded-full ${h.isActive ? (isDeny ? 'bg-red-500' : 'bg-green-500') : h.revokedAt ? 'bg-red-400' : 'bg-gray-400'}`} />
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${isDeny ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'}`}>
                    {effect}
                  </span>
                  <span className="font-medium text-gray-700 dark:text-gray-300 w-28 shrink-0 capitalize">{RESOURCES[h.resourceType]?.label || h.resourceType}</span>
                  <span className="font-semibold px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: `${LEVEL_COLORS[h.action || h.permissionLevel] || '#ccc'}15`, color: LEVEL_COLORS[h.action || h.permissionLevel] || '#666' }}>
                    {h.action || h.permissionLevel}
                  </span>
                  <span className="text-gray-400 flex-1">by {h.grantedBy}</span>
                  <span className="text-gray-400">{new Date(h.grantedAt).toLocaleDateString()}</span>
                  {h.revokedAt && <span className="text-red-400 text-[10px]">Revoked {new Date(h.revokedAt).toLocaleDateString()}</span>}
                  {h.expiresAt && !h.revokedAt && h.isActive && <span className="text-yellow-500 text-[10px] flex items-center gap-0.5"><Clock size={8} /> {new Date(h.expiresAt).toLocaleDateString()}</span>}
                  {!h.isActive && !h.revokedAt && <span className="text-gray-400 text-[10px]">Inactive</span>}
                </div>
                );
              })}
              {historyData.length === 0 && <p className="text-xs text-gray-400 text-center py-4">No permission history</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Active Grants Table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">Active Permission Overrides ({filteredPermissions.length})</h3>
          <select value={filterResource} onChange={e => setFilterResource(e.target.value)}
            className="text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 focus:outline-none focus:border-primary dark:bg-zinc-700 dark:text-gray-200">
            <option value="">All resources</option>
            {Object.entries(RESOURCES).map(([key, meta]) => (
              <option key={key} value={key}>{meta.label}</option>
            ))}
          </select>
        </div>

        <div className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100 dark:border-zinc-700 bg-gray-50/50 dark:bg-zinc-800/50">
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">User</th>
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Effect</th>
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Resource</th>
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Action</th>
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Scope</th>
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Granted By</th>
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Expires</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPermissions.map(p => {
                const effect = p.effect || 'grant';
                const isDeny = effect === 'deny';
                return (
                <tr key={p.id} className={`border-b border-gray-50 dark:border-zinc-700/50 hover:bg-gray-50/50 dark:hover:bg-zinc-700/30 transition-colors ${isDeny ? 'bg-red-50/30 dark:bg-red-900/10' : ''}`}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary">
                        {p.user?.name?.charAt(0)}
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-800 dark:text-gray-200">{p.user?.name}</p>
                        <p className="text-[10px] text-gray-500">{p.user ? tierLabel(resolveTier(p.user)) : ''}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${isDeny ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'}`}>
                      {isDeny ? 'Deny' : 'Grant'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs text-gray-600 dark:text-gray-400">{RESOURCES[p.resourceType]?.label || p.resourceType}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ backgroundColor: `${LEVEL_COLORS[p.action || p.permissionLevel] || '#ccc'}15`, color: LEVEL_COLORS[p.action || p.permissionLevel] || '#666' }}>
                      {ACTIONS[p.action]?.label || p.action || p.permissionLevel}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 capitalize">{p.scope || 'global'}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-500">{p.granter?.name}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-500">
                    {p.expiresAt ? (
                      <span className="flex items-center gap-1 text-yellow-600"><Clock size={10} /> {new Date(p.expiresAt).toLocaleDateString()}</span>
                    ) : <span className="text-green-600">Permanent</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => handleRevoke(p.id)} className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors">Revoke</button>
                  </td>
                </tr>
                );
              })}
              {filteredPermissions.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-gray-400">
                  <Shield size={28} className="mx-auto mb-2 opacity-30" />
                  No active permission overrides
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AccessRequestsTab() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [reviewNote, setReviewNote] = useState('');

  useEffect(() => {
    fetchRequests();
  }, [statusFilter]);

  async function fetchRequests() {
    try {
      const res = await api.get(`/access-requests?status=${statusFilter}`);
      setRequests(res.data.requests || []);
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove(id) {
    try {
      await api.put(`/access-requests/${id}/approve`, { reviewNote });
      setReviewNote('');
      fetchRequests();
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    }
  }

  async function handleReject(id) {
    try {
      await api.put(`/access-requests/${id}/reject`, { reviewNote });
      setReviewNote('');
      fetchRequests();
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    }
  }

  if (loading) return <div className="animate-pulse space-y-3">{[1,2].map(i => <div key={i} className="h-20 bg-gray-100 dark:bg-zinc-800 rounded-xl" />)}</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Access Requests</h2>
        <div className="flex gap-1 bg-gray-100 dark:bg-zinc-700 rounded-lg p-0.5">
          {['pending', 'approved', 'rejected'].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all capitalize ${
                statusFilter === s ? 'bg-white dark:bg-zinc-600 text-primary shadow-sm' : 'text-gray-500'
              }`}>{s}</button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {requests.map(r => (
          <motion.div key={r.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-4">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-sm font-bold text-primary mt-0.5">
                  {r.requester?.name?.charAt(0)}
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{r.requester?.name}</p>
                  <p className="text-xs text-gray-500">
                    Requesting <span className="font-semibold capitalize text-primary">{r.requestType}</span> access to <span className="capitalize">{r.resourceType}</span>
                  </p>
                  {r.reason && <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 italic">"{r.reason}"</p>}
                  {r.isTemporary && r.expiresAt && (
                    <p className="text-[10px] text-yellow-600 flex items-center gap-1 mt-1"><Clock size={10} /> Temporary until {new Date(r.expiresAt).toLocaleDateString()}</p>
                  )}
                  <p className="text-[10px] text-gray-400 mt-1">{new Date(r.createdAt).toLocaleString()}</p>
                </div>
              </div>
              {r.status === 'pending' && (
                <div className="flex items-center gap-2">
                  <input type="text" value={reviewNote} onChange={e => setReviewNote(e.target.value)}
                    placeholder="Note (optional)" className="text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 w-40 focus:outline-none focus:border-primary" />
                  <button onClick={() => handleApprove(r.id)}
                    className="flex items-center gap-1 px-3 py-1.5 bg-green-500 text-white text-xs font-medium rounded-lg hover:bg-green-600">
                    <Check size={12} /> Approve
                  </button>
                  <button onClick={() => handleReject(r.id)}
                    className="flex items-center gap-1 px-3 py-1.5 bg-red-500 text-white text-xs font-medium rounded-lg hover:bg-red-600">
                    <X size={12} /> Reject
                  </button>
                </div>
              )}
              {r.status !== 'pending' && (
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                  r.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }`}>{r.status}</span>
              )}
            </div>
            {r.reviewNote && r.status !== 'pending' && (
              <div className="mt-2 ml-12 text-xs text-gray-500 italic">Review note: {r.reviewNote}</div>
            )}
          </motion.div>
        ))}
        {requests.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <CheckCircle size={32} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">No {statusFilter} requests</p>
          </div>
        )}
      </div>
    </div>
  );
}

function CheckCircle({ size, className }) {
  return <Check size={size} className={className} />;
}

function TemplatesTab() {
  const [templates, setTemplates] = useState({});
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const [tRes, uRes] = await Promise.all([
        api.get('/permissions/templates'),
        api.get('/auth/users'),
      ]);
      setTemplates(tRes.data.templates || {});
      setUsers(uRes.data.users || uRes.data || []);
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    }
  }

  async function handleApply() {
    if (!selectedUser || !selectedTemplate) return;
    try {
      await api.post('/permissions/apply-template', { userId: selectedUser, template: selectedTemplate });
      setApplied(true);
      setTimeout(() => setApplied(false), 3000);
    } catch (err) {
      safeLog.error('[AdminSettings] error', err);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-4">Permission Templates</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {Object.entries(templates).map(([key, t]) => (
          <motion.div key={key} whileHover={{ scale: 1.02 }}
            onClick={() => setSelectedTemplate(key)}
            className={`bg-white dark:bg-zinc-800 rounded-xl border p-4 cursor-pointer transition-all ${
              selectedTemplate === key ? 'border-primary ring-2 ring-primary/20' : 'border-gray-200 dark:border-zinc-700 hover:border-gray-300'
            }`}>
            <div className="flex items-center gap-2 mb-2">
              <Shield size={16} className="text-primary" />
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{t.label}</h3>
            </div>
            <p className="text-xs text-gray-500 mb-3">{t.description}</p>
            <div className="space-y-1">
              {t.permissions.map((p, i) => (
                <div key={i} className="flex items-center justify-between text-[11px]">
                  <span className="text-gray-500 capitalize">{p.resourceType}</span>
                  <span className="font-medium px-1.5 py-0.5 rounded" style={{ backgroundColor: `${LEVEL_COLORS[p.permissionLevel]}15`, color: LEVEL_COLORS[p.permissionLevel] }}>
                    {p.permissionLevel}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        ))}
      </div>

      <div className="bg-gray-50 dark:bg-zinc-800/50 rounded-xl p-5 border border-gray-100 dark:border-zinc-700">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">Apply Template to User</h3>
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="text-xs text-gray-500 mb-1 block">User</label>
            <select value={selectedUser} onChange={e => setSelectedUser(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
              <option value="">Select user...</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name} ({tierLabel(resolveTier(u))})</option>)}
            </select>
          </div>
          <div className="flex-1">
            <label className="text-xs text-gray-500 mb-1 block">Template</label>
            <select value={selectedTemplate} onChange={e => setSelectedTemplate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
              <option value="">Select template...</option>
              {Object.entries(templates).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
            </select>
          </div>
          <button onClick={handleApply} disabled={!selectedUser || !selectedTemplate}
            className="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-40 transition-colors">
            Apply
          </button>
        </div>
        {applied && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-xs text-green-600 mt-2 flex items-center gap-1">
            <Check size={12} /> Template applied successfully!
          </motion.p>
        )}
      </div>
    </div>
  );
}

// ─── Security & Session ──────────────────────────────────────
// Super-admin-only tab. Controls platform-wide auth/session policy. Currently
// surfaces just the inactivity auto-logout duration; future security knobs
// (password rotation, session lifetime, MFA enforcement) belong here too.
//
// The selector is a number + unit (minutes/hours) — internally everything is
// stored and shipped to the backend in MINUTES. Hours mode is purely a display
// affordance so a Super Admin doesn't have to translate "24 hours = 1440" by hand.

// Format a minute count for human display. 60 → "1 hour", 120 → "2 hours",
// 45 → "45 minutes". Keeps singular/plural correct.
function formatMinutesReadable(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n <= 0) return '0 minutes';
  if (n >= 60 && n % 60 === 0) {
    const h = n / 60;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${n} minute${n === 1 ? '' : 's'}`;
}

// Pick the most natural display unit for a saved minute value. If it's an
// exact non-zero hour, show it as hours; otherwise show as minutes.
function pickInitialUnit(totalMinutes) {
  const m = Number(totalMinutes);
  if (Number.isFinite(m) && m >= 60 && m % 60 === 0) {
    return { unit: 'hours', count: String(m / 60) };
  }
  return { unit: 'minutes', count: String(Number.isFinite(m) ? m : 5) };
}

// Curated quick-select presets covering everyday windows from a coffee break
// (5 min) through a full workday (8 hr) up to the daily-rotation max (24 hr).
// Each preset stores its display unit so clicking "1 hr" puts the selector in
// hours mode rather than showing "60 minutes".
const SECURITY_PRESETS = [
  { label: '5 min',  unit: 'minutes', count: 5 },
  { label: '10 min', unit: 'minutes', count: 10 },
  { label: '15 min', unit: 'minutes', count: 15 },
  { label: '30 min', unit: 'minutes', count: 30 },
  { label: '1 hr',   unit: 'hours',   count: 1 },
  { label: '2 hr',   unit: 'hours',   count: 2 },
  { label: '4 hr',   unit: 'hours',   count: 4 },
  { label: '8 hr',   unit: 'hours',   count: 8 },
  { label: '12 hr',  unit: 'hours',   count: 12 },
  { label: '24 hr',  unit: 'hours',   count: 24 },
];

function SecurityTab() {
  const toast = useToast();
  const {
    isSuperAdmin,
    inactivityTimeoutMinutes,
    refreshInactivityTimeout,
    applyInactivityTimeoutMinutes,
    INACTIVITY_MIN_MINUTES,
    INACTIVITY_MAX_MINUTES,
  } = useAuth();

  // Bounds expressed in MINUTES — the canonical unit. Hours mode derives its
  // own count bounds from these (1..24).
  const MIN = INACTIVITY_MIN_MINUTES ?? 5;
  const MAX = INACTIVITY_MAX_MINUTES ?? 1440;

  // Stepper count is held as a raw string so the user can type freely
  // (including transient invalid states like blank, decimals, or text); strict
  // validation happens below. Unit is the dropdown selection.
  const initial = pickInitialUnit(inactivityTimeoutMinutes ?? 5);
  const [unit, setUnit] = useState(initial.unit);
  const [countRaw, setCountRaw] = useState(initial.count);
  const [savedValue, setSavedValue] = useState(inactivityTimeoutMinutes ?? 5);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isSuperAdmin) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const minutes = await refreshInactivityTimeout();
        if (cancelled) return;
        const safe = Number.isFinite(minutes) ? minutes : 5;
        const init = pickInitialUnit(safe);
        setUnit(init.unit);
        setCountRaw(init.count);
        setSavedValue(safe);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [refreshInactivityTimeout, isSuperAdmin]);

  // Defense-in-depth: even if the tab somehow renders for a non-super-admin
  // (e.g. a future routing bug), refuse to display the controls. Backend PUT
  // is also locked, so they couldn't save anyway. Placed AFTER hooks so the
  // rules-of-hooks invariant holds regardless of role.
  if (!isSuperAdmin) {
    return (
      <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-lg p-6">
        <p className="text-sm text-gray-600 dark:text-gray-400">Super Admin privileges are required to view this section.</p>
      </div>
    );
  }

  // Per-unit count bounds. In hours mode the smallest sensible count is 1
  // (= 60 min, well above the 5-minute floor); in minutes mode it's MIN itself.
  const unitMin = unit === 'hours' ? 1 : MIN;
  const unitMax = unit === 'hours' ? Math.floor(MAX / 60) : MAX;
  const unitLabel = unit === 'hours' ? 'hours' : 'minutes';

  // Strict integer validation. /^\d+$/ rejects decimals (5.5), blanks,
  // negatives, scientific notation (5e2), and any non-digit characters that
  // Number() would silently coerce. Both the per-unit count range AND the
  // resulting total-minutes range must hold — total minutes is what the
  // backend enforces, so it stays the canonical gate.
  const trimmed = String(countRaw ?? '').trim();
  const isBlank = trimmed === '';
  const isIntegerString = /^\d+$/.test(trimmed);
  const countNum = Number(trimmed);
  const totalMinutes = unit === 'hours' ? countNum * 60 : countNum;
  const isValidDraft =
    !isBlank &&
    isIntegerString &&
    countNum >= unitMin &&
    countNum <= unitMax &&
    totalMinutes >= MIN &&
    totalMinutes <= MAX;
  const isDirty = isValidDraft && totalMinutes !== savedValue;

  const handleStep = (delta) => {
    // If the current count is invalid (e.g. the user typed garbage and then
    // hit +/-), recover by re-deriving the count from the last known-good
    // saved value in the current unit. This makes the stepper a "rescue"
    // path out of bad input.
    let base;
    if (Number.isFinite(countNum) && countNum > 0) {
      base = Math.round(countNum);
    } else {
      base = unit === 'hours'
        ? Math.max(1, Math.round(savedValue / 60))
        : savedValue;
    }
    const next = Math.max(unitMin, Math.min(unitMax, base + delta));
    setCountRaw(String(next));
  };

  const handlePresetClick = (preset) => {
    setUnit(preset.unit);
    setCountRaw(String(preset.count));
  };

  const handleUnitChange = (e) => {
    // Switching units does NOT auto-convert the number. The user picked a unit
    // for a reason; silently scaling 30 → 1800 would be more surprising than
    // letting validation guide them. The presets and stepper are the natural
    // ways to land on a sensible value after a unit change.
    setUnit(e.target.value);
  };

  const handleSave = async () => {
    if (!isValidDraft || saving) return;
    setSaving(true);
    try {
      const res = await api.put('/system-settings/session-timeout', {
        inactivityTimeoutMinutes: totalMinutes,
      });
      const minutes = Number(res.data?.data?.inactivityTimeoutMinutes) || totalMinutes;
      setSavedValue(minutes);
      // Re-derive display unit from the canonical saved value so e.g. saving
      // "60 minutes" snaps the UI to "1 hour" on the next tick.
      const init = pickInitialUnit(minutes);
      setUnit(init.unit);
      setCountRaw(init.count);
      // Apply to the running session immediately so the new window takes effect
      // without a page refresh — gives the super admin instant feedback.
      applyInactivityTimeoutMinutes(minutes);
      toast.success(`Inactivity logout set to ${formatMinutesReadable(minutes)}.`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to update inactivity timeout');
    } finally {
      setSaving(false);
    }
  };

  // Highlight a preset chip when the currently-typed value resolves to the
  // same total minutes AND the same display unit — so "1 hr" lights up only
  // when you're showing 1 hour, not when you've typed 60 in minutes mode.
  // Keeps the UI honest about which path the user took.
  const isPresetActive = (p) =>
    isValidDraft && unit === p.unit && countNum === p.count;

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-lg p-6 max-w-2xl">
        <div className="flex items-start gap-3 mb-5">
          <div className="p-2 rounded-md bg-primary/10 text-primary">
            <Lock size={18} />
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-800 dark:text-gray-100">Security & Session</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Platform-wide session policy. Only Super Admins can change these values.
            </p>
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-zinc-800 pt-5">
          <label className="block text-sm font-medium text-gray-800 dark:text-gray-100">
            Auto logout after inactivity
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-4">
            Users will be automatically signed out after this period of inactivity.
            Allowed range: {MIN} minutes – {Math.floor(MAX / 60)} hours.
          </p>

          {loading ? (
            <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
              <RefreshCw size={12} className="animate-spin" /> Loading current setting…
            </div>
          ) : (
            <>
              {/* Stepper + unit selector */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="inline-flex items-stretch rounded-lg border border-gray-300 dark:border-zinc-700 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => handleStep(-1)}
                    disabled={(isValidDraft && countNum <= unitMin) || saving}
                    aria-label="Decrease"
                    className="px-3 text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                    −
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={unitMin}
                    max={unitMax}
                    step={1}
                    value={countRaw}
                    onChange={(e) => setCountRaw(e.target.value)}
                    disabled={saving}
                    aria-label="Inactivity timeout value"
                    aria-invalid={!isValidDraft}
                    className={`w-20 text-center text-sm font-medium bg-white dark:bg-zinc-900 text-gray-800 dark:text-gray-100 border-l border-r focus:outline-none focus:ring-1 transition-colors ${
                      isValidDraft || isBlank
                        ? 'border-gray-300 dark:border-zinc-700 focus:ring-primary'
                        : 'border-red-400 dark:border-red-700 focus:ring-red-400'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => handleStep(+1)}
                    disabled={(isValidDraft && countNum >= unitMax) || saving}
                    aria-label="Increase"
                    className="px-3 text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                    +
                  </button>
                </div>
                <select
                  value={unit}
                  onChange={handleUnitChange}
                  disabled={saving}
                  aria-label="Inactivity timeout unit"
                  className="px-3 py-1.5 text-sm bg-white dark:bg-zinc-900 text-gray-800 dark:text-gray-100 border border-gray-300 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary">
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>

              {/* Selected timeout summary OR validation error — mutually
                  exclusive so the card stays compact. */}
              {isValidDraft ? (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  Selected timeout:{' '}
                  <span className="font-medium text-gray-700 dark:text-gray-200">
                    {countNum} {unitLabel}
                  </span>
                </p>
              ) : (
                <p className="text-xs text-red-600 mt-2 flex items-center gap-1">
                  <AlertCircle size={12} />
                  {isBlank
                    ? 'Please enter a value.'
                    : `Must be a whole number between ${unitMin} and ${unitMax} ${unitLabel}.`}
                </p>
              )}

              {/* Presets */}
              <div className="flex flex-wrap gap-2 mt-4">
                {SECURITY_PRESETS.map(p => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => handlePresetClick(p)}
                    disabled={saving}
                    className={`px-3 py-1 text-xs rounded-md border transition-colors ${
                      isPresetActive(p)
                        ? 'bg-primary/10 border-primary text-primary'
                        : 'bg-white dark:bg-zinc-900 border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-800'
                    } disabled:opacity-40 disabled:cursor-not-allowed`}>
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Save row */}
              <div className="flex items-center justify-between mt-5 pt-4 border-t border-gray-100 dark:border-zinc-800">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Current saved value:{' '}
                  <span className="font-medium text-gray-700 dark:text-gray-200">
                    {formatMinutesReadable(savedValue)}
                  </span>
                </p>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!isDirty || saving}
                  className="px-4 py-1.5 bg-primary text-white text-sm font-medium rounded-md hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5">
                  {saving ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />}
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
