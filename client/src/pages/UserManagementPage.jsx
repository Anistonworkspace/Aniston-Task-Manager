import React, { useState, useEffect } from 'react';
import {
  UserPlus, Search, Filter, MoreHorizontal, KeyRound,
  Pencil, UserX, UserCheck, Shield, ShieldCheck, Users as UsersIcon,
  Building2, Plus, Trash2, LayoutGrid, ChevronDown, Briefcase, RefreshCw,
} from 'lucide-react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import api from '../services/api';
import { HIERARCHY_LEVELS } from '../utils/constants';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/common/Avatar';
import CreateUserModal from '../components/user/CreateUserModal';
import EditUserModal from '../components/user/EditUserModal';
import ResetPasswordModal from '../components/user/ResetPasswordModal';
import DepartmentModal from '../components/department/DepartmentModal';
import WorkspaceAssignModal from '../components/workspace/WorkspaceAssignModal';
import TeamPlannerModal from '../components/workspace/TeamPlannerModal';

const ROLE_BADGE = {
  admin: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Admin', icon: ShieldCheck },
  manager: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Manager', icon: Shield },
  member: { bg: 'bg-green-100', text: 'text-green-700', label: 'Member', icon: UsersIcon },
};

export default function UserManagementPage() {
  const { user: currentUser, isAdmin, canManage } = useAuth();
  const [activeTab, setActiveTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [wsLoading, setWsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [resetUser, setResetUser] = useState(null);
  const [assignWsUser, setAssignWsUser] = useState(null);
  const [showTeamPlanner, setShowTeamPlanner] = useState(false);
  const [actionMenu, setActionMenu] = useState(null);
  const [showDeptModal, setShowDeptModal] = useState(false);
  const [editDept, setEditDept] = useState(null);
  const [deptActionMenu, setDeptActionMenu] = useState(null);
  const [wsSearch, setWsSearch] = useState('');
  const [wsActionMenu, setWsActionMenu] = useState(null);
  const [openWs, setOpenWs] = useState({});
  const [pendingUsers, setPendingUsers] = useState([]);

  useEffect(() => { loadUsers(); loadDepartments(); loadWorkspaces(); loadPendingUsers(); }, []);

  async function loadUsers() {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (search) params.append('search', search);
      if (filterRole) params.append('role', filterRole);
      if (filterStatus) params.append('status', filterStatus);
      const res = await api.get(`/users?${params.toString()}`);
      setUsers(res.data.users || res.data.data?.users || []);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadDepartments() {
    try {
      const res = await api.get('/departments');
      setDepartments(res.data.departments || res.data.data?.departments || []);
    } catch (err) { console.error('Failed to load departments:', err); }
  }

  async function loadWorkspaces() {
    try {
      setWsLoading(true);
      const res = await api.get('/workspaces');
      setWorkspaces(res.data.workspaces || res.data.data?.workspaces || []);
    } catch (err) { console.error('Failed to load workspaces:', err); }
    setWsLoading(false);
  }

  useEffect(() => {
    const timer = setTimeout(() => loadUsers(), 300);
    return () => clearTimeout(timer);
  }, [search, filterRole, filterStatus]);

  async function loadPendingUsers() {
    try {
      const res = await api.get('/auth/pending-accounts');
      setPendingUsers(res.data.users || res.data.data?.users || []);
    } catch (err) { console.error('Failed to load pending:', err); }
  }

  async function handleApproveUser(userId) {
    try {
      await api.put(`/auth/approve/${userId}`);
      loadPendingUsers(); loadUsers();
    } catch (err) { console.error('Failed to approve:', err); }
  }

  async function handleRejectUser(userId) {
    if (!confirm('Reject and delete this account request?')) return;
    try {
      await api.put(`/auth/reject/${userId}`);
      loadPendingUsers();
    } catch (err) { console.error('Failed to reject:', err); }
  }

  async function handleDeleteUser(userId) {
    if (!confirm('Permanently delete this user? This cannot be undone.')) return;
    try {
      await api.delete(`/users/${userId}`);
      loadUsers();
    } catch (err) { console.error('Failed to delete user:', err); }
    setActionMenu(null);
  }

  async function handleToggleStatus(userId) {
    try {
      await api.put(`/users/${userId}/toggle-status`);
      loadUsers();
    } catch (err) { console.error('Failed to toggle status:', err); }
    setActionMenu(null);
  }

  async function handleDeleteDept(deptId) {
    if (!confirm('Delete this department? Users will be unassigned.')) return;
    try {
      await api.delete(`/departments/${deptId}`);
      loadDepartments(); loadUsers();
    } catch (err) { console.error('Failed to delete department:', err); }
    setDeptActionMenu(null);
  }

  async function handleRemoveFromWorkspace(wsId, userId) {
    try {
      await api.delete(`/workspaces/${wsId}/members/${userId}`);
      loadWorkspaces(); loadUsers();
    } catch (err) { console.error('Failed to remove from workspace:', err); }
  }

  const stats = {
    total: users.length,
    active: users.filter(u => u.isActive).length,
    admins: users.filter(u => u.role === 'admin').length,
    managers: users.filter(u => u.role === 'manager').length,
    members: users.filter(u => u.role === 'member').length,
  };

  const filteredWorkspaces = workspaces.filter(w =>
    !wsSearch || w.name.toLowerCase().includes(wsSearch.toLowerCase())
  );

  // Derive designations and roles from user data
  const designations = [...new Set(users.map(u => u.designation).filter(Boolean))].sort();
  const roleGroups = { admin: users.filter(u => u.role === 'admin'), manager: users.filter(u => u.role === 'manager'), member: users.filter(u => u.role === 'member') };

  async function handleSyncDepartments() {
    try {
      await api.post('/departments/sync-from-users');
      loadDepartments(); loadUsers();
    } catch (err) { console.error('Failed to sync departments:', err); }
  }

  const TABS = [
    { id: 'users', label: 'Users', icon: UsersIcon, count: stats.total },
    { id: 'pending', label: 'Pending', icon: UserPlus, count: pendingUsers.length },
    { id: 'departments', label: 'Departments', icon: Building2, count: departments.length },
    { id: 'designations', label: 'Designations', icon: Briefcase, count: designations.length },
    { id: 'roles', label: 'Roles', icon: Shield, count: 3 },
    { id: 'workspaces', label: 'Workspaces', icon: LayoutGrid, count: workspaces.length },
  ];

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Team Management</h1>
          <p className="text-sm text-text-secondary mt-0.5">Manage users, roles, departments, and workspaces</p>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'departments' ? (
            <button onClick={() => { setEditDept(null); setShowDeptModal(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-600 transition-colors shadow-sm">
              <Plus size={16} /> Add Department
            </button>
          ) : activeTab === 'users' ? (
            <div className="flex items-center gap-2">
              <button onClick={() => setShowTeamPlanner(true)}
                className="flex items-center gap-2 px-4 py-2 bg-surface border border-border text-text-primary text-sm font-medium rounded-lg hover:bg-surface-hover transition-colors">
                <LayoutGrid size={16} className="text-primary" /> Team Planner
              </button>
              <button onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-600 transition-colors shadow-sm">
                <UserPlus size={16} /> Add User
              </button>
            </div>
          ) : (
            <button onClick={() => setShowTeamPlanner(true)}
              className="flex items-center gap-2 px-4 py-2 bg-surface border border-border text-text-primary text-sm font-medium rounded-lg hover:bg-surface-hover transition-colors">
              <LayoutGrid size={16} className="text-primary" /> Team Planner
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-border">
        {TABS.map(tab => (
          <button key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${activeTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            <tab.icon size={15} /> {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      {/* ── USERS TAB ── */}
      {/* ═══ PENDING REQUESTS TAB ═══ */}
      {activeTab === 'pending' && (
        <div>
          {pendingUsers.length === 0 ? (
            <div className="text-center py-16 bg-surface rounded-xl">
              <UserPlus size={32} className="text-text-tertiary mx-auto mb-3" />
              <p className="text-sm text-text-secondary">No pending account requests</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-4 px-5 py-3 bg-surface/50 text-xs font-semibold text-text-secondary uppercase border-b border-border">
                <span>Name</span><span>Email</span><span>Department</span><span>Actions</span>
              </div>
              {pendingUsers.map(u => (
                <div key={u.id} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-4 px-5 py-3 border-b border-border last:border-0 items-center hover:bg-surface/30">
                  <div className="flex items-center gap-2">
                    <Avatar name={u.name} size="sm" />
                    <span className="text-sm font-medium text-text-primary">{u.name}</span>
                  </div>
                  <span className="text-sm text-text-secondary">{u.email}</span>
                  <span className="text-sm text-text-secondary">{u.department || '—'}</span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleApproveUser(u.id)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-success text-white text-xs font-medium rounded-lg hover:bg-success/90 transition-colors">
                      <UserCheck size={13} /> Approve
                    </button>
                    <button onClick={() => handleRejectUser(u.id)}
                      className="flex items-center gap-1 px-3 py-1.5 bg-danger text-white text-xs font-medium rounded-lg hover:bg-danger/90 transition-colors">
                      <UserX size={13} /> Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'users' && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            {[
              { label: 'Total Users', value: stats.total, color: '#0073ea' },
              { label: 'Active', value: stats.active, color: '#00c875' },
              { label: 'Admins', value: stats.admins, color: '#a25ddc' },
              { label: 'Managers', value: stats.managers, color: '#0073ea' },
              { label: 'Members', value: stats.members, color: '#00c875' },
            ].map(card => (
              <div key={card.label} className="widget-card">
                <p className="text-xs text-text-secondary font-medium mb-1">{card.label}</p>
                <p className="text-2xl font-bold" style={{ color: card.color }}>{card.value}</p>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-2 bg-white border border-border rounded-lg px-3 py-2 flex-1 max-w-md">
              <Search size={15} className="text-text-tertiary" />
              <input type="text" placeholder="Search by name, email, or designation..." value={search} onChange={e => setSearch(e.target.value)}
                className="bg-transparent border-none outline-none text-sm w-full placeholder:text-text-tertiary" />
            </div>
            <div className="flex items-center gap-2">
              <Filter size={14} className="text-text-tertiary" />
              <select value={filterRole} onChange={e => setFilterRole(e.target.value)}
                className="px-3 py-2 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20">
                <option value="">All Roles</option>
                <option value="admin">Admin</option>
                <option value="manager">Manager</option>
                <option value="assistant_manager">Assistant Manager</option>
                <option value="member">Member</option>
              </select>
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                className="px-3 py-2 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20">
                <option value="">All Status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" />
              </div>
            ) : users.length === 0 ? (
              <div className="text-center py-16">
                <UsersIcon size={40} className="mx-auto text-text-tertiary mb-3" />
                <p className="text-text-secondary font-medium">No users found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-surface/50 border-b border-border">
                      <th className="text-left py-3 px-4 text-xs font-semibold text-text-secondary uppercase tracking-wider">User</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold text-text-secondary uppercase tracking-wider">Designation</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold text-text-secondary uppercase tracking-wider">Department</th>
                      <th className="text-center py-3 px-4 text-xs font-semibold text-text-secondary uppercase tracking-wider">Role</th>
                      <th className="text-center py-3 px-4 text-xs font-semibold text-text-secondary uppercase tracking-wider">Level</th>
                      <th className="text-center py-3 px-4 text-xs font-semibold text-text-secondary uppercase tracking-wider">Status</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold text-text-secondary uppercase tracking-wider">Workspace</th>
                      <th className="text-left py-3 px-4 text-xs font-semibold text-text-secondary uppercase tracking-wider">Joined</th>
                      {canManage && (
                        <th className="text-center py-3 px-4 text-xs font-semibold text-text-secondary uppercase tracking-wider w-[80px]">Actions</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {users.map(u => {
                      const roleBadge = ROLE_BADGE[u.role] || ROLE_BADGE.member;
                      const RoleIcon = roleBadge.icon;
                      const isSelf = u.id === currentUser?.id;
                      // Find workspace this user is assigned to
                      const userWorkspace = workspaces.find(w => w.workspaceMembers?.some(m => m.id === u.id));
                      return (
                        <tr key={u.id} className={`border-b border-border/50 hover:bg-surface/30 transition-colors ${!u.isActive ? 'opacity-60' : ''}`}>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <div className="relative">
                                <Avatar name={u.name} size="md" />
                                <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white ${u.isActive ? 'bg-success' : 'bg-gray-300'}`} />
                              </div>
                              <div>
                                <p className="text-sm font-medium text-text-primary">
                                  {u.name}
                                  {isSelf && <span className="text-xs text-primary ml-1.5">(you)</span>}
                                </p>
                                <p className="text-xs text-text-tertiary">{u.email}</p>
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-4"><span className="text-sm text-text-secondary">{u.designation || '—'}</span></td>
                          <td className="py-3 px-4">
                            {u.department ? (
                              <span className="inline-block px-2 py-0.5 bg-surface rounded text-xs font-medium text-text-secondary">{u.department}</span>
                            ) : <span className="text-sm text-text-tertiary">—</span>}
                          </td>
                          <td className="py-3 px-4 text-center">
                            <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${roleBadge.bg} ${roleBadge.text}`}>
                              <RoleIcon size={12} /> {roleBadge.label}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-center">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-surface text-text-secondary">
                              {HIERARCHY_LEVELS.find(h => h.value === u.hierarchyLevel)?.label || u.hierarchyLevel || '—'}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-center">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${u.isActive ? 'bg-success/10 text-success' : 'bg-gray-100 text-gray-500'}`}>
                              <div className={`w-1.5 h-1.5 rounded-full ${u.isActive ? 'bg-success' : 'bg-gray-400'}`} />
                              {u.isActive ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            {userWorkspace ? (
                              <button
                                onClick={() => setAssignWsUser(u)}
                                className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium hover:bg-surface transition-colors"
                                style={{ color: userWorkspace.color || '#0073ea' }}
                              >
                                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: userWorkspace.color || '#0073ea' }} />
                                {userWorkspace.name}
                              </button>
                            ) : (
                              canManage ? (
                                <button
                                  onClick={() => setAssignWsUser(u)}
                                  className="text-xs text-text-tertiary hover:text-primary transition-colors border border-dashed border-border hover:border-primary px-2 py-1 rounded"
                                >
                                  + Assign workspace
                                </button>
                              ) : <span className="text-xs text-text-tertiary">—</span>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <span className="text-xs text-text-tertiary">
                              {u.createdAt ? formatDistanceToNow(parseISO(u.createdAt), { addSuffix: true }) : '—'}
                            </span>
                          </td>
                          {canManage && (
                            <td className="py-3 px-4 text-center">
                              <div className="relative">
                                <button onClick={() => setActionMenu(actionMenu === u.id ? null : u.id)}
                                  className="p-1.5 rounded-md hover:bg-surface text-text-tertiary hover:text-text-secondary transition-colors">
                                  <MoreHorizontal size={16} />
                                </button>
                                {actionMenu === u.id && (
                                  <>
                                    <div className="fixed inset-0 z-40" onClick={() => setActionMenu(null)} />
                                    <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-dropdown border border-border py-1 min-w-[200px]">
                                      {isAdmin && (
                                        <button onClick={() => { setEditUser(u); setActionMenu(null); }}
                                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-primary hover:bg-surface transition-colors">
                                          <Pencil size={14} /> Edit Details
                                        </button>
                                      )}
                                      <button onClick={() => { setAssignWsUser(u); setActionMenu(null); }}
                                        className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-primary hover:bg-surface transition-colors">
                                        <LayoutGrid size={14} /> Assign Workspace
                                      </button>
                                      {isAdmin && (
                                        <button onClick={() => { setResetUser(u); setActionMenu(null); }}
                                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-primary hover:bg-surface transition-colors">
                                          <KeyRound size={14} /> Reset Password
                                        </button>
                                      )}
                                      <div className="border-t border-border my-1" />
                                      {isAdmin && !isSelf && (
                                        <button onClick={() => handleToggleStatus(u.id)}
                                          className={`flex items-center gap-2.5 w-full px-3 py-2 text-sm transition-colors ${u.isActive ? 'text-danger hover:bg-danger/5' : 'text-success hover:bg-success/5'}`}>
                                          {u.isActive ? <><UserX size={14} /> Deactivate</> : <><UserCheck size={14} /> Activate</>}
                                        </button>
                                      )}
                                      {isAdmin && !isSelf && (
                                        <button onClick={() => handleDeleteUser(u.id)}
                                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-danger hover:bg-danger/5 transition-colors">
                                          <Trash2 size={14} /> Delete Account
                                        </button>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── DEPARTMENTS TAB ── */}
      {activeTab === 'departments' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {departments.length === 0 ? (
            <div className="col-span-full text-center py-16 bg-white rounded-xl border border-border">
              <Building2 size={40} className="mx-auto text-text-tertiary mb-3" />
              <p className="text-text-secondary font-medium">No departments yet</p>
              <p className="text-sm text-text-tertiary mt-1 mb-4">Sync departments from your team data or create manually</p>
              <div className="flex items-center gap-3 justify-center">
                <button onClick={handleSyncDepartments}
                  className="px-4 py-2 bg-primary text-white text-sm rounded-md font-medium hover:bg-primary-hover">
                  <RefreshCw size={14} className="inline mr-1" /> Sync from Users
                </button>
                <button onClick={() => { setEditDept(null); setShowDeptModal(true); }}
                  className="px-4 py-2 bg-surface border border-border text-text-primary text-sm rounded-md font-medium hover:bg-surface-hover">
                  <Plus size={14} className="inline mr-1" /> Create Department
                </button>
              </div>
            </div>
          ) : departments.map(dept => (
            <div key={dept.id} className="bg-white rounded-xl border border-border shadow-sm overflow-hidden hover:shadow-md transition-shadow">
              <div className="h-1.5" style={{ backgroundColor: dept.color || '#0073ea' }} />
              <div className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${dept.color || '#0073ea'}15` }}>
                      <Building2 size={18} style={{ color: dept.color || '#0073ea' }} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-text-primary">{dept.name}</h3>
                      {dept.description && <p className="text-xs text-text-tertiary mt-0.5 line-clamp-1">{dept.description}</p>}
                    </div>
                  </div>
                  <div className="relative">
                    <button onClick={() => setDeptActionMenu(deptActionMenu === dept.id ? null : dept.id)}
                      className="p-1 rounded hover:bg-surface text-text-tertiary">
                      <MoreHorizontal size={15} />
                    </button>
                    {deptActionMenu === dept.id && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setDeptActionMenu(null)} />
                        <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-dropdown border border-border py-1 min-w-[150px]">
                          <button onClick={() => { setEditDept(dept); setShowDeptModal(true); setDeptActionMenu(null); }}
                            className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-surface">
                            <Pencil size={13} /> Edit
                          </button>
                          {isAdmin && (
                            <button onClick={() => handleDeleteDept(dept.id)}
                              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-danger hover:bg-danger/5">
                              <Trash2 size={13} /> Delete
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                {dept.headUser && (
                  <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 bg-surface/50 rounded-lg">
                    <Avatar name={dept.headUser.name} size="xs" />
                    <div>
                      <p className="text-xs font-medium text-text-primary">{dept.headUser.name}</p>
                      <p className="text-[10px] text-text-tertiary">Head of Department</p>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <UsersIcon size={13} className="text-text-tertiary" />
                    <span className="text-xs text-text-secondary font-medium">{dept.memberCount || 0} members</span>
                  </div>
                  {dept.members && dept.members.length > 0 && (
                    <div className="flex -space-x-1.5">
                      {dept.members.slice(0, 5).map(m => (
                        <div key={m.id} title={m.name}><Avatar name={m.name} size="xs" /></div>
                      ))}
                      {dept.members.length > 5 && (
                        <div className="w-6 h-6 rounded-full bg-surface border-2 border-white flex items-center justify-center text-[9px] font-medium text-text-secondary">
                          +{dept.members.length - 5}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ═══ DESIGNATIONS TAB ═══ */}
      {activeTab === 'designations' && (
        <div>
          {designations.length === 0 ? (
            <div className="text-center py-16 bg-surface rounded-xl">
              <Briefcase size={32} className="text-text-tertiary mx-auto mb-3" />
              <p className="text-sm text-text-secondary">No designations found</p>
              <p className="text-xs text-text-tertiary mt-1">Designations are synced from Microsoft 365 job titles</p>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-border overflow-hidden">
              <div className="grid grid-cols-[1fr_80px_1fr] gap-4 px-5 py-3 bg-surface/50 text-xs font-semibold text-text-secondary uppercase border-b border-border">
                <span>Designation</span><span>Count</span><span>Employees</span>
              </div>
              {designations.map(d => {
                const dUsers = users.filter(u => u.designation === d);
                return (
                  <div key={d} className="grid grid-cols-[1fr_80px_1fr] gap-4 px-5 py-3 border-b border-border last:border-0 items-center hover:bg-surface/30">
                    <span className="text-sm font-medium text-text-primary flex items-center gap-2">
                      <Briefcase size={14} className="text-primary" /> {d}
                    </span>
                    <span className="text-sm text-text-secondary font-semibold">{dUsers.length}</span>
                    <div className="flex items-center gap-1 flex-wrap">
                      {dUsers.slice(0, 5).map(u => (
                        <span key={u.id} className="text-xs bg-surface px-2 py-0.5 rounded-full text-text-secondary">{u.name}</span>
                      ))}
                      {dUsers.length > 5 && <span className="text-xs text-text-tertiary">+{dUsers.length - 5} more</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══ ROLES TAB ═══ */}
      {activeTab === 'roles' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Object.entries(roleGroups).map(([role, roleUsers]) => {
            const badge = ROLE_BADGE[role] || {};
            const Icon = badge.icon || UsersIcon;
            return (
              <div key={role} className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
                <div className={`px-5 py-4 ${badge.bg || 'bg-surface'} border-b border-border`}>
                  <div className="flex items-center gap-2">
                    <Icon size={18} className={badge.text || 'text-text-primary'} />
                    <h3 className={`text-lg font-bold ${badge.text || 'text-text-primary'} capitalize`}>{role}s</h3>
                    <span className={`ml-auto text-2xl font-bold ${badge.text || 'text-text-primary'}`}>{roleUsers.length}</span>
                  </div>
                </div>
                <div className="divide-y divide-border max-h-[300px] overflow-y-auto">
                  {roleUsers.length === 0 ? (
                    <p className="text-sm text-text-tertiary text-center py-6">No {role}s</p>
                  ) : roleUsers.map(u => (
                    <div key={u.id} className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface/30">
                      <Avatar name={u.name} size="xs" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">{u.name}</p>
                        <p className="text-[10px] text-text-tertiary truncate">{u.email}</p>
                      </div>
                      {u.department && <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface text-text-tertiary">{u.department}</span>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── WORKSPACES TAB ── */}
      {activeTab === 'workspaces' && (
        <div className="space-y-4">
          {/* Search */}
          <div className="flex items-center gap-2 bg-white border border-border rounded-lg px-3 py-2 max-w-sm">
            <Search size={15} className="text-text-tertiary" />
            <input type="text" placeholder="Search workspaces..." value={wsSearch} onChange={e => setWsSearch(e.target.value)}
              className="bg-transparent border-none outline-none text-sm w-full placeholder:text-text-tertiary" />
          </div>

          {wsLoading ? (
            <div className="flex justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" />
            </div>
          ) : filteredWorkspaces.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-xl border border-border">
              <LayoutGrid size={40} className="mx-auto text-text-tertiary mb-3" />
              <p className="text-text-secondary font-medium">No workspaces yet</p>
              <p className="text-sm text-text-tertiary mt-1 mb-4">Create workspaces in Admin Settings to organize your team's boards</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredWorkspaces.map(ws => {
                const isOpen = openWs[ws.id] !== false;
                const members = ws.workspaceMembers || [];
                const boards = ws.boards || [];
                return (
                  <div key={ws.id} className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
                    {/* Workspace header */}
                    <div className="flex items-center gap-3 p-4">
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
                        style={{ backgroundColor: ws.color || '#0073ea' }}>
                        {ws.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-text-primary">{ws.name}</h3>
                        {ws.description && <p className="text-xs text-text-tertiary truncate">{ws.description}</p>}
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-xs text-text-tertiary flex items-center gap-1">
                            <UsersIcon size={11} /> {members.length} members
                          </span>
                          <span className="text-xs text-text-tertiary flex items-center gap-1">
                            <LayoutGrid size={11} /> {boards.length} boards
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => setOpenWs(p => ({ ...p, [ws.id]: !isOpen }))}
                        className="p-1.5 rounded-md text-text-tertiary hover:bg-surface transition-colors">
                        <ChevronDown size={16} className={`transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                      </button>
                    </div>

                    {/* Members list */}
                    {isOpen && (
                      <div className="border-t border-border px-4 py-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Members</span>
                          {canManage && (
                            <span className="text-xs text-text-tertiary italic">Click user row → Assign Workspace to change</span>
                          )}
                        </div>
                        {members.length === 0 ? (
                          <p className="text-xs text-text-tertiary py-2">No members assigned yet.</p>
                        ) : (
                          <div className="space-y-1.5">
                            {members.map(m => (
                              <div key={m.id} className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-surface/50 group">
                                <Avatar name={m.name} size="xs" />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-text-primary truncate">{m.name}</p>
                                  <p className="text-xs text-text-tertiary capitalize">{m.role}</p>
                                </div>
                                {canManage && (
                                  <button
                                    onClick={() => handleRemoveFromWorkspace(ws.id, m.id)}
                                    className="opacity-0 group-hover:opacity-100 text-xs text-danger hover:text-danger/80 transition-all"
                                  >
                                    Remove
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      <CreateUserModal isOpen={showCreate} onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); loadUsers(); loadWorkspaces(); }} creatorRole={currentUser?.role} />

      {editUser && (
        <EditUserModal isOpen={!!editUser} onClose={() => setEditUser(null)} user={editUser}
          onUpdated={loadUsers} isAdmin={isAdmin} />
      )}

      {resetUser && (
        <ResetPasswordModal isOpen={!!resetUser} onClose={() => setResetUser(null)}
          user={resetUser} onReset={loadUsers} />
      )}

      {showDeptModal && (
        <DepartmentModal department={editDept} onClose={() => { setShowDeptModal(false); setEditDept(null); }}
          onSave={() => { loadDepartments(); loadUsers(); }} />
      )}

      {assignWsUser && (
        <WorkspaceAssignModal
          user={assignWsUser}
          onClose={() => setAssignWsUser(null)}
          onUpdated={() => { loadWorkspaces(); loadUsers(); }}
        />
      )}

      {showTeamPlanner && (
        <TeamPlannerModal onClose={() => { setShowTeamPlanner(false); loadUsers(); loadWorkspaces(); }} />
      )}
    </div>
  );
}
