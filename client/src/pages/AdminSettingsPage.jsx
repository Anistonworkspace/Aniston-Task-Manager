import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import {
  Settings, Shield, Users, LayoutGrid, Bell, Key, Plus, Trash2, Edit2,
  Check, X, ChevronRight, Search, AlertCircle, Clock, UserPlus, Eye,
  Lock, Unlock, BookmarkCheck, RefreshCw, Briefcase, MoreHorizontal,
  UserCheck, UserX, KeyRound, ShieldCheck
} from 'lucide-react';
import Avatar from '../components/common/Avatar';
import CreateUserModal from '../components/user/CreateUserModal';
import ResetPasswordModal from '../components/user/ResetPasswordModal';
import { RESOURCES, ACTIONS, RESOURCE_ACTIONS, getResourcesByCategory, getActionsForResource } from '../utils/permissions';

const TABS = [
  { id: 'users', label: 'Users', icon: Users },
  { id: 'workspaces', label: 'Workspaces', icon: LayoutGrid },
  { id: 'permissions', label: 'Permissions', icon: Shield },
  { id: 'access_requests', label: 'Access Requests', icon: Key },
  { id: 'templates', label: 'Templates', icon: BookmarkCheck },
];

const ROLE_BADGE = {
  superadmin: { bg: 'bg-red-100', text: 'text-red-700', label: 'Super Admin', icon: ShieldCheck },
  admin: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Admin', icon: ShieldCheck },
  manager: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Manager', icon: Shield },
  assistant_manager: { bg: 'bg-cyan-100', text: 'text-cyan-700', label: 'Asst. Manager', icon: Shield },
  member: { bg: 'bg-green-100', text: 'text-green-700', label: 'Member', icon: Users },
};

const LEGACY_RESOURCE_TYPES = ['workspace', 'board', 'team', 'dashboard'];
const LEGACY_PERMISSION_LEVELS = ['view', 'edit', 'assign', 'manage', 'admin'];
const LEVEL_COLORS = {
  view: '#579bfc', edit: '#fdab3d', assign: '#a25ddc', manage: '#00c875', admin: '#e2445c',
  create: '#00c875', delete: '#e2445c', approve: '#a25ddc', export: '#579bfc',
  manage_members: '#00c875', manage_settings: '#e2445c', change_status: '#fdab3d',
  comment: '#579bfc', upload: '#fdab3d',
};

export default function AdminSettingsPage() {
  const { user, isSuperAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState('users');

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2 mb-1">
          <Settings size={24} className="text-primary" />
          Admin Settings
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">Manage users, workspaces, permissions, and access control</p>
      </motion.div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 dark:bg-zinc-800 rounded-lg p-1 mb-6 w-fit">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition-all ${
              activeTab === tab.id ? 'bg-white dark:bg-zinc-700 text-primary shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            <tab.icon size={14} /> {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'users' && <UsersTab />}
      {activeTab === 'workspaces' && <WorkspacesTab />}
      {activeTab === 'permissions' && <PermissionsTab />}
      {activeTab === 'access_requests' && <AccessRequestsTab />}
      {activeTab === 'templates' && <TemplatesTab />}
    </div>
  );
}

function UsersTab() {
  const { user: currentUser, isSuperAdmin } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [showReset, setShowReset] = useState(null);
  const [actionMenu, setActionMenu] = useState(null);
  const [roleChanging, setRoleChanging] = useState(null);
  const [visibleCount, setVisibleCount] = useState(25);

  useEffect(() => { fetchUsers(); }, []);

  async function fetchUsers() {
    try {
      const res = await api.get('/users');
      setUsers(res.data.users || res.data.data?.users || res.data || []);
    } catch (err) { console.error(err); } finally { setLoading(false); }
  }

  async function handleChangeRole(userId, newRole) {
    setRoleChanging(userId);
    try {
      if (newRole === 'superadmin') {
        await api.put(`/users/${userId}`, { role: 'admin', isSuperAdmin: true });
      } else {
        await api.put(`/users/${userId}`, { role: newRole, isSuperAdmin: false });
      }
      fetchUsers();
    } catch (err) { console.error(err); alert(err.response?.data?.message || 'Failed to change role'); }
    finally { setRoleChanging(null); setActionMenu(null); }
  }

  async function handleDelete(userId, name) {
    if (!confirm(`Permanently delete "${name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/users/${userId}`);
      fetchUsers();
    } catch (err) { console.error(err); alert(err.response?.data?.message || 'Failed to delete user'); }
  }

  async function handleToggleStatus(userId) {
    try {
      await api.put(`/users/${userId}/toggle-status`);
      fetchUsers();
    } catch (err) { console.error(err); }
    setActionMenu(null);
  }

  const filtered = users.filter(u => {
    if (roleFilter !== 'all' && u.role !== roleFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q) || u.designation?.toLowerCase().includes(q);
    }
    return true;
  });

  const stats = {
    total: users.length,
    admin: users.filter(u => u.role === 'admin').length,
    manager: users.filter(u => u.role === 'manager').length,
    member: users.filter(u => u.role === 'member').length,
  };

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

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Total', count: stats.total, color: '#0073ea' },
          { label: 'Admin', count: stats.admin, color: '#8b5cf6' },
          { label: 'Manager', count: stats.manager, color: '#0073ea' },
          { label: 'Member', count: stats.member, color: '#00c875' },
        ].map(s => (
          <div key={s.label} className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 px-4 py-3">
            <p className="text-2xl font-bold" style={{ color: s.color }}>{s.count}</p>
            <p className="text-[10px] text-gray-400 uppercase tracking-wider">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Role sub-tabs + Search */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 bg-gray-100 dark:bg-zinc-800 rounded-lg p-0.5">
          {['all', 'admin', 'manager', 'member'].map(r => (
            <button key={r} onClick={() => setRoleFilter(r)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all capitalize ${
                roleFilter === r ? 'bg-white dark:bg-zinc-700 text-primary shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>{r === 'all' ? `All (${stats.total})` : `${r}s (${stats[r]})`}</button>
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
              <th className="text-center text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Role</th>
              <th className="text-center text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Status</th>
              <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, visibleCount).map(u => {
              const badge = u.isSuperAdmin ? ROLE_BADGE.superadmin : (ROLE_BADGE[u.role] || ROLE_BADGE.member);
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
                    <select value={u.isSuperAdmin ? 'superadmin' : u.role} onChange={e => handleChangeRole(u.id, e.target.value)}
                      disabled={roleChanging === u.id}
                      className={`text-xs font-semibold px-2.5 py-1 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/30 ${badge.bg} ${badge.text}`}>
                      <option value="member">Member</option>
                      <option value="assistant_manager">Assistant Manager</option>
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                      {isSuperAdmin && <option value="superadmin">Super Admin</option>}
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
                          <button onClick={() => { setShowReset(u); setActionMenu(null); }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700">
                            <KeyRound size={12} /> Reset Password
                          </button>
                          <button onClick={() => handleToggleStatus(u.id)}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-zinc-700">
                            {u.isActive ? <><UserX size={12} /> Deactivate</> : <><UserCheck size={12} /> Activate</>}
                          </button>
                          {!u.isSuperAdmin && (
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
    </div>
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
      console.error(err);
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
      console.error(err);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this workspace?')) return;
    try {
      await api.delete(`/workspaces/${id}`);
      fetchAll();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleAssignMembers(wsId) {
    if (!assignUserId) return;
    try {
      await api.post(`/workspaces/${wsId}/members`, { userIds: [assignUserId] });
      setAssignUserId('');
      fetchAll();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleRemoveMember(wsId, userId) {
    try {
      await api.delete(`/workspaces/${wsId}/members/${userId}`);
      fetchAll();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleAssignBoard(wsId) {
    if (!assignBoardId) return;
    try {
      await api.post(`/workspaces/${wsId}/boards`, { boardId: assignBoardId });
      setAssignBoardId('');
      fetchAll();
    } catch (err) {
      console.error(err);
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
                            <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
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

  function toggle(value) {
    if (selected.includes(value)) {
      onChange(selected.filter(v => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  function selectAll() {
    const allKeys = allOptions.map(o => typeof o === 'string' ? o : o.key);
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

          {/* Options list */}
          <div className="overflow-y-auto flex-1 py-1">
            {filtered ? (
              filtered.map(o => {
                const key = typeof o === 'string' ? o : o.key;
                const display = typeof o === 'string' ? (ACTIONS[o]?.label || o) : (o.label || o.key);
                const desc = typeof o === 'string' ? (ACTIONS[o]?.description || '') : '';
                const isSelected = selected.includes(key);
                return (
                  <button key={key} type="button" onClick={() => toggle(key)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors ${isSelected ? 'bg-primary/5' : ''}`}>
                    <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-gray-300 dark:border-zinc-500'}`}>
                      {isSelected && <Check size={9} className="text-white" />}
                    </div>
                    <span className="font-medium text-gray-700 dark:text-gray-300">{display}</span>
                    {desc && <span className="text-gray-400 text-[10px] ml-auto">{desc}</span>}
                  </button>
                );
              })
            ) : groupedOptions ? (
              Object.entries(groupedOptions).map(([category, items]) => (
                <div key={category}>
                  <div className="px-3 py-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider bg-gray-50/50 dark:bg-zinc-800/50 sticky top-0">{category}</div>
                  {items.map(o => {
                    const key = typeof o === 'string' ? o : o.key;
                    const display = typeof o === 'string' ? o : (o.label || o.key);
                    const isSelected = selected.includes(key);
                    return (
                      <button key={key} type="button" onClick={() => toggle(key)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors ${isSelected ? 'bg-primary/5' : ''}`}>
                        <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-gray-300 dark:border-zinc-500'}`}>
                          {isSelected && <Check size={9} className="text-white" />}
                        </div>
                        <span className="font-medium text-gray-700 dark:text-gray-300">{display}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            ) : (
              allOptions.map(o => {
                const key = typeof o === 'string' ? o : o.key;
                const display = typeof o === 'string' ? (ACTIONS[o]?.label || o) : (o.label || o.key);
                const desc = typeof o === 'string' ? (ACTIONS[o]?.description || '') : '';
                const isSelected = selected.includes(key);
                return (
                  <button key={key} type="button" onClick={() => toggle(key)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors ${isSelected ? 'bg-primary/5' : ''}`}>
                    <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-gray-300 dark:border-zinc-500'}`}>
                      {isSelected && <Check size={9} className="text-white" />}
                    </div>
                    <span className="font-medium text-gray-700 dark:text-gray-300">{display}</span>
                    {desc && <span className="text-gray-400 text-[10px] ml-auto">{desc}</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PermissionsTab() {
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [showGrant, setShowGrant] = useState(false);
  const [form, setForm] = useState({ userId: '', resources: [], actions: [], expiresAt: '', reason: '', scope: 'global' });
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

  const resourcesByCategory = getResourcesByCategory();
  const selectedUser = users.find(u => u.id === form.userId);

  // Compute union of available actions across all selected resources
  const availableActions = React.useMemo(() => {
    if (form.resources.length === 0) return [];
    const actionSet = new Set();
    for (const r of form.resources) {
      for (const a of getActionsForResource(r)) {
        actionSet.add(a);
      }
    }
    return [...actionSet];
  }, [form.resources]);

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

  async function fetchData() {
    try {
      const [permRes, usersRes] = await Promise.all([
        api.get('/permissions'),
        api.get('/auth/users'),
      ]);
      setPermissions(permRes.data.permissions || []);
      setUsers(usersRes.data.users || usersRes.data || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }

  async function handleGrant() {
    setGrantError('');
    setGrantSuccess('');
    if (!form.userId || form.resources.length === 0 || form.actions.length === 0) {
      setGrantError('Please select user, at least one resource, and at least one action.');
      return;
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
      });
      const s = res.data?.data?.summary || {};
      const parts = [];
      if (s.created > 0) parts.push(`${s.created} created`);
      if (s.updated > 0) parts.push(`${s.updated} updated`);
      if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
      setGrantSuccess(`Permissions granted successfully (${parts.join(', ')}).`);
      setForm({ userId: '', resources: [], actions: [], expiresAt: '', reason: '', scope: 'global' });
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
    } catch (err) { console.error(err); }
  }

  async function fetchEffective() {
    if (!effectiveUser) return;
    setEffectiveLoading(true);
    try {
      const res = await api.get(`/permissions/effective/${effectiveUser}`);
      setEffectiveData(res.data.effective);
    } catch (err) { console.error(err); }
    finally { setEffectiveLoading(false); }
  }

  async function fetchHistory(userId) {
    setHistoryUser(userId);
    setShowHistory(true);
    try {
      const res = await api.get(`/permissions/history/${userId}`);
      setHistoryData(res.data.history || []);
    } catch (err) { console.error(err); }
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
          <p className="text-xs text-gray-500 mt-0.5">Grant extra permissions beyond a user's base role. Select multiple resources and actions at once.</p>
        </div>
        <button onClick={() => { setShowGrant(!showGrant); setGrantError(''); setGrantSuccess(''); }}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors">
          <Plus size={14} /> Grant Permission
        </button>
      </div>

      {/* Grant form */}
      <AnimatePresence>
        {showGrant && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-5">

            {/* Row 1: User */}
            <div className="mb-4">
              <label className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1 block">User</label>
              <select value={form.userId} onChange={e => setForm({ ...form, userId: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary dark:bg-zinc-700 dark:text-gray-200">
                <option value="">Select user...</option>
                {users.map(u => {
                  const badge = u.isSuperAdmin ? 'Super Admin' : (ROLE_BADGE[u.role]?.label || u.role);
                  return <option key={u.id} value={u.id}>{u.name} ({badge})</option>;
                })}
              </select>
              {selectedUser && (
                <div className="mt-2 flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary">{selectedUser.name?.charAt(0)}</div>
                  <div>
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{selectedUser.name}</span>
                    <span className={`ml-2 text-[10px] font-semibold px-2 py-0.5 rounded-full ${(ROLE_BADGE[selectedUser.isSuperAdmin ? 'superadmin' : selectedUser.role] || ROLE_BADGE.member).bg} ${(ROLE_BADGE[selectedUser.isSuperAdmin ? 'superadmin' : selectedUser.role] || ROLE_BADGE.member).text}`}>
                      {selectedUser.isSuperAdmin ? 'Super Admin' : (ROLE_BADGE[selectedUser.role]?.label || selectedUser.role)}
                    </span>
                  </div>
                </div>
              )}
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
                className="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-40 transition-colors flex items-center gap-2">
                {granting ? (
                  <><RefreshCw size={14} className="animate-spin" /> Granting {totalCombinations} permission{totalCombinations !== 1 ? 's' : ''}...</>
                ) : (
                  <>Grant {totalCombinations > 0 ? `${totalCombinations} Override${totalCombinations !== 1 ? 's' : ''}` : 'Override'}</>
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
            {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.isSuperAdmin ? 'Super Admin' : u.role})</option>)}
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

        {effectiveData && (
          <div className="space-y-3">
            {/* Role info */}
            <div className="flex items-center gap-3 p-3 bg-white dark:bg-zinc-800 rounded-lg border border-gray-100 dark:border-zinc-700">
              <div>
                <span className="text-xs text-gray-500">Base Role: </span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${(ROLE_BADGE[effectiveData.role] || ROLE_BADGE.member).bg} ${(ROLE_BADGE[effectiveData.role] || ROLE_BADGE.member).text}`}>
                  {effectiveData.role}
                </span>
              </div>
              {effectiveData.isSuperAdmin && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">Super Admin — Full Access</span>
              )}
              {effectiveData.overrides?.length > 0 && (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                  +{effectiveData.overrides.length} override{effectiveData.overrides.length > 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Permissions by resource */}
            {effectiveData.permissions && !effectiveData.isSuperAdmin && (
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

                    return (
                      <div key={resKey} className="flex items-start gap-3 py-1.5 border-b border-gray-50 dark:border-zinc-700/50 last:border-0">
                        <span className={`text-xs font-medium w-36 shrink-0 ${hasAny ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400'}`}>
                          {resMeta.label}
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {resourcePerms.map(p => {
                            const isOverride = overrideActions.includes(p.action);
                            const isBase = !!basePerms[`${resKey}.${p.action}`];
                            return (
                              <span key={p.action}
                                className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${
                                  p.allowed
                                    ? isOverride
                                      ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800'
                                      : 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800'
                                    : 'bg-gray-50 text-gray-400 border-gray-200 dark:bg-zinc-700 dark:text-zinc-500 dark:border-zinc-600'
                                }`}
                                title={p.allowed ? (isOverride ? 'Override grant' : 'Base role permission') : 'Not allowed'}>
                                {isOverride ? '+' : ''}{p.action}
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
                  <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-amber-50 border border-amber-200" /> Override grant</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-gray-50 border border-gray-200" /> Not allowed</span>
                </div>
              </div>
            )}
          </div>
        )}
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
              {historyData.map((h, i) => (
                <div key={i} className={`flex items-center gap-3 text-xs p-2 rounded-lg ${h.isActive ? 'bg-green-50/50 dark:bg-green-900/10' : 'bg-gray-50 dark:bg-zinc-700/30'}`}>
                  <div className={`w-2 h-2 rounded-full ${h.isActive ? 'bg-green-500' : h.revokedAt ? 'bg-red-400' : 'bg-gray-400'}`} />
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
              ))}
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
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Resource</th>
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Action</th>
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Scope</th>
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Granted By</th>
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Expires</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPermissions.map(p => (
                <tr key={p.id} className="border-b border-gray-50 dark:border-zinc-700/50 hover:bg-gray-50/50 dark:hover:bg-zinc-700/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary">
                        {p.user?.name?.charAt(0)}
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-800 dark:text-gray-200">{p.user?.name}</p>
                        <p className="text-[10px] text-gray-500">{p.user?.isSuperAdmin ? 'Super Admin' : p.user?.role}</p>
                      </div>
                    </div>
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
              ))}
              {filteredPermissions.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-gray-400">
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
      console.error(err);
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
      console.error(err);
    }
  }

  async function handleReject(id) {
    try {
      await api.put(`/access-requests/${id}/reject`, { reviewNote });
      setReviewNote('');
      fetchRequests();
    } catch (err) {
      console.error(err);
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
      console.error(err);
    }
  }

  async function handleApply() {
    if (!selectedUser || !selectedTemplate) return;
    try {
      await api.post('/permissions/apply-template', { userId: selectedUser, template: selectedTemplate });
      setApplied(true);
      setTimeout(() => setApplied(false), 3000);
    } catch (err) {
      console.error(err);
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
              {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
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
