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

const TABS = [
  { id: 'users', label: 'Users', icon: Users },
  { id: 'workspaces', label: 'Workspaces', icon: LayoutGrid },
  { id: 'permissions', label: 'Permissions', icon: Shield },
  { id: 'access_requests', label: 'Access Requests', icon: Key },
  { id: 'templates', label: 'Templates', icon: BookmarkCheck },
];

const ROLE_BADGE = {
  admin: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Admin', icon: ShieldCheck },
  manager: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Manager', icon: Shield },
  assistant_manager: { bg: 'bg-cyan-100', text: 'text-cyan-700', label: 'Asst. Manager', icon: Shield },
  member: { bg: 'bg-green-100', text: 'text-green-700', label: 'Member', icon: Users },
};

const RESOURCE_TYPES = ['workspace', 'board', 'team', 'dashboard'];
const PERMISSION_LEVELS = ['view', 'edit', 'assign', 'manage', 'admin'];
const LEVEL_COLORS = {
  view: '#579bfc', edit: '#fdab3d', assign: '#a25ddc', manage: '#00c875', admin: '#e2445c',
};

export default function AdminSettingsPage() {
  const { user } = useAuth();
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
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [showReset, setShowReset] = useState(null);
  const [actionMenu, setActionMenu] = useState(null);
  const [roleChanging, setRoleChanging] = useState(null);

  useEffect(() => { fetchUsers(); }, []);

  async function fetchUsers() {
    try {
      const res = await api.get('/auth/users');
      setUsers(res.data.users || res.data.data?.users || res.data || []);
    } catch (err) { console.error(err); } finally { setLoading(false); }
  }

  async function handleChangeRole(userId, newRole) {
    setRoleChanging(userId);
    try {
      await api.put(`/users/${userId}`, { role: newRole });
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
            {filtered.map(u => {
              const badge = ROLE_BADGE[u.role] || ROLE_BADGE.member;
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
                    <select value={u.role} onChange={e => handleChangeRole(u.id, e.target.value)}
                      disabled={roleChanging === u.id || u.isSuperAdmin}
                      className={`text-xs font-semibold px-2.5 py-1 rounded-full border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/30 ${badge.bg} ${badge.text} ${u.isSuperAdmin ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <option value="member">Member</option>
                      <option value="assistant_manager">Assistant Manager</option>
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
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

function PermissionsTab() {
  const [permissions, setPermissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [showGrant, setShowGrant] = useState(false);
  const [form, setForm] = useState({ userId: '', resourceType: 'workspace', resourceId: '', permissionLevel: 'view', expiresAt: '' });
  const [effectiveUser, setEffectiveUser] = useState('');
  const [effectiveData, setEffectiveData] = useState(null);

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const [permRes, usersRes] = await Promise.all([
        api.get('/permissions'),
        api.get('/auth/users'),
      ]);
      setPermissions(permRes.data.permissions || []);
      setUsers(usersRes.data.users || usersRes.data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleGrant() {
    try {
      await api.post('/permissions', {
        ...form,
        resourceId: form.resourceId || null,
        expiresAt: form.expiresAt || null,
      });
      setShowGrant(false);
      setForm({ userId: '', resourceType: 'workspace', resourceId: '', permissionLevel: 'view', expiresAt: '' });
      fetchData();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleRevoke(id) {
    try {
      await api.delete(`/permissions/${id}`);
      fetchData();
    } catch (err) {
      console.error(err);
    }
  }

  async function fetchEffective() {
    if (!effectiveUser) return;
    try {
      const res = await api.get(`/permissions/effective/${effectiveUser}?resourceType=workspace`);
      setEffectiveData(res.data.effective);
    } catch (err) {
      console.error(err);
    }
  }

  if (loading) return <div className="animate-pulse space-y-3">{[1,2,3].map(i => <div key={i} className="h-16 bg-gray-100 dark:bg-zinc-800 rounded-xl" />)}</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Permission Grants</h2>
        <button onClick={() => setShowGrant(true)}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90">
          <Plus size={14} /> Grant Permission
        </button>
      </div>

      {/* Grant form */}
      <AnimatePresence>
        {showGrant && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-5 mb-4">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <select value={form.userId} onChange={e => setForm({ ...form, userId: e.target.value })}
                className="px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
                <option value="">Select user</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
              </select>
              <select value={form.resourceType} onChange={e => setForm({ ...form, resourceType: e.target.value })}
                className="px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
                {RESOURCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select value={form.permissionLevel} onChange={e => setForm({ ...form, permissionLevel: e.target.value })}
                className="px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
                {PERMISSION_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
              <input type="datetime-local" value={form.expiresAt} onChange={e => setForm({ ...form, expiresAt: e.target.value })}
                className="px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary" placeholder="Expiry (optional)" />
              <div className="flex gap-2">
                <button onClick={handleGrant} className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary/90">Grant</button>
                <button onClick={() => setShowGrant(false)} className="px-4 py-2 text-sm text-gray-500">Cancel</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Effective permissions preview */}
      <div className="bg-gray-50 dark:bg-zinc-800/50 rounded-xl p-4 mb-4 border border-gray-100 dark:border-zinc-700">
        <h3 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Effective Permissions Preview</h3>
        <div className="flex gap-2">
          <select value={effectiveUser} onChange={e => setEffectiveUser(e.target.value)}
            className="text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 flex-1 focus:outline-none focus:border-primary">
            <option value="">Select user...</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
          </select>
          <button onClick={fetchEffective} className="px-3 py-1.5 bg-primary/10 text-primary text-xs rounded-md hover:bg-primary/20 font-medium">Check</button>
        </div>
        {effectiveData && (
          <div className="mt-3 p-3 bg-white dark:bg-zinc-800 rounded-lg border border-gray-100 dark:border-zinc-700">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-gray-500">Effective level:</span>
              <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: `${LEVEL_COLORS[effectiveData.level] || '#ccc'}20`, color: LEVEL_COLORS[effectiveData.level] }}>{effectiveData.level}</span>
              <span className="text-xs text-gray-400">Role default: {effectiveData.roleDefault}</span>
            </div>
            {effectiveData.grants?.length > 0 && (
              <div className="space-y-1">
                {effectiveData.grants.map(g => (
                  <div key={g.id} className="flex items-center gap-2 text-[11px] text-gray-600">
                    <span className="font-medium" style={{ color: LEVEL_COLORS[g.level] }}>{g.level}</span>
                    {g.isTemporary && <span className="text-yellow-600 flex items-center gap-0.5"><Clock size={10} /> expires {new Date(g.expiresAt).toLocaleDateString()}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Permissions table */}
      <div className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 dark:border-zinc-700">
              <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">User</th>
              <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Resource</th>
              <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Level</th>
              <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Granted By</th>
              <th className="text-left text-xs font-medium text-gray-500 px-4 py-3">Expires</th>
              <th className="text-right text-xs font-medium text-gray-500 px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {permissions.map(p => (
              <tr key={p.id} className="border-b border-gray-50 dark:border-zinc-700/50 hover:bg-gray-50/50 dark:hover:bg-zinc-700/30">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary">
                      {p.user?.name?.charAt(0)}
                    </div>
                    <div>
                      <p className="text-xs font-medium text-gray-800 dark:text-gray-200">{p.user?.name}</p>
                      <p className="text-[10px] text-gray-500">{p.user?.role}</p>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-gray-400 capitalize">{p.resourceType}</td>
                <td className="px-4 py-2.5">
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ backgroundColor: `${LEVEL_COLORS[p.permissionLevel]}15`, color: LEVEL_COLORS[p.permissionLevel] }}>
                    {p.permissionLevel}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-500">{p.granter?.name}</td>
                <td className="px-4 py-2.5 text-xs text-gray-500">
                  {p.expiresAt ? <span className="flex items-center gap-1"><Clock size={10} /> {new Date(p.expiresAt).toLocaleDateString()}</span> : 'Permanent'}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => handleRevoke(p.id)} className="text-xs text-red-500 hover:text-red-700 font-medium">Revoke</button>
                </td>
              </tr>
            ))}
            {permissions.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">No permission grants yet</td></tr>
            )}
          </tbody>
        </table>
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
