import React, { useState, useEffect } from 'react';
import { Archive, RotateCcw, Trash2, Search, FolderKanban, ListTodo, AlertTriangle, X, Building2, Layers, Link2, HelpCircle, Shield, ShieldCheck, ArrowRight, Calendar as CalIcon, Filter } from 'lucide-react';
import { formatDistanceToNow, parseISO, differenceInDays } from 'date-fns';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../utils/constants';
import { useToast } from '../components/common/Toast';

const PROTECTION_DAYS = 90;

function ProtectionBadge({ archivedAt }) {
  if (!archivedAt) return null;
  const daysSince = differenceInDays(new Date(), parseISO(archivedAt));
  const daysRemaining = Math.max(0, PROTECTION_DAYS - daysSince);
  if (daysRemaining > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[9px] bg-orange-50 text-orange-600 px-2 py-0.5 rounded-full font-medium">
        <Shield size={9} /> Protected for {daysRemaining}d
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[9px] bg-green-50 text-green-600 px-2 py-0.5 rounded-full font-medium">
      <ShieldCheck size={9} /> Ready to delete
    </span>
  );
}

function canDeleteItem(user, archivedAt) {
  if (user?.isSuperAdmin) return true;
  if (!archivedAt) return true;
  const daysSince = differenceInDays(new Date(), parseISO(archivedAt));
  return daysSince >= PROTECTION_DAYS;
}

function ConfirmDeleteModal({ item, type, onConfirm, onCancel, canDelete }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
        <div className="p-6 text-center">
          <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle size={28} className="text-red-500" />
          </div>
          <h3 className="text-lg font-bold text-gray-800 mb-2">Permanently Delete?</h3>
          <p className="text-sm text-gray-500 mb-1">Are you sure you want to permanently delete this {type}?</p>
          <p className="text-sm font-semibold text-gray-800 mb-3">"{item?.name || item?.title || item?.task?.title || 'Item'}"</p>
          {!canDelete && (
            <p className="text-xs text-orange-600 font-medium bg-orange-50 rounded-lg px-3 py-2 mb-3">
              This item is still within the 90-day protection period. Only Super Admin can delete it.
            </p>
          )}
          <p className="text-xs text-red-500 font-medium bg-red-50 rounded-lg px-3 py-2 mb-5">
            This action cannot be undone. All associated data will be permanently removed.
          </p>
          <div className="flex gap-3">
            <button onClick={onCancel} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors">Cancel</button>
            <button onClick={onConfirm} disabled={!canDelete}
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium flex items-center justify-center gap-2 transition-colors ${canDelete ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}>
              <Trash2 size={14} /> Delete Permanently
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ArchivedPage() {
  const { canManage, isAdmin, user } = useAuth();
  const { success: toastSuccess, error: toastError } = useToast();
  const [boards, setBoards] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [archivedGroups, setArchivedGroups] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [dependencies, setDependencies] = useState([]);
  const [helpRequests, setHelpRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('tasks');
  const [search, setSearch] = useState('');
  const [deleteItem, setDeleteItem] = useState(null);
  const [deleteType, setDeleteType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => { loadArchived(); }, []);

  async function loadArchived() {
    setLoading(true);
    try {
      const [boardsRes, allBoardsRes, tasksRes, wsRes, depsRes, helpRes] = await Promise.all([
        api.get('/boards?archived=true'),
        api.get('/boards'),
        api.get('/tasks?archived=true&limit=200'),
        canManage ? api.get('/workspaces/archived').catch(() => ({ data: { data: { workspaces: [] } } })) : Promise.resolve({ data: { data: { workspaces: [] } } }),
        api.get(`/archive/dependencies${buildFilterQuery()}`).catch(() => ({ data: { data: { dependencies: [] } } })),
        api.get(`/archive/help-requests${buildFilterQuery()}`).catch(() => ({ data: { data: { helpRequests: [] } } })),
      ]);
      setBoards((boardsRes.data.boards || boardsRes.data || []).filter(b => b.isArchived));
      setTasks(tasksRes.data.tasks || tasksRes.data || []);
      const wsData = wsRes.data?.data || wsRes.data;
      setWorkspaces(wsData?.workspaces || []);
      setDependencies((depsRes.data?.data || depsRes.data)?.dependencies || []);
      setHelpRequests((helpRes.data?.data || helpRes.data)?.helpRequests || []);

      // Collect archived groups from all non-archived boards
      const allBoards = allBoardsRes.data.boards || allBoardsRes.data || [];
      const groups = [];
      allBoards.forEach(b => {
        if (b.archivedGroups && b.archivedGroups.length > 0) {
          b.archivedGroups.forEach(g => {
            groups.push({ ...g, boardId: b.id, boardName: b.name, boardColor: b.color });
          });
        }
      });
      setArchivedGroups(groups);
    } catch (err) {
      console.error('Failed to load archived items:', err);
    }
    setLoading(false);
  }

  function buildFilterQuery() {
    const params = [];
    if (search) params.push(`search=${encodeURIComponent(search)}`);
    if (dateFrom) params.push(`dateFrom=${dateFrom}`);
    if (dateTo) params.push(`dateTo=${dateTo}`);
    return params.length ? '?' + params.join('&') : '';
  }

  function clearFilters() { setDateFrom(''); setDateTo(''); setSearch(''); }

  async function restoreTask(id) {
    try { await api.put(`/tasks/${id}`, { isArchived: false }); setTasks(prev => prev.filter(t => t.id !== id)); toastSuccess('Task restored'); } catch (e) { console.error('Restore task failed:', e); toastError('Failed to restore task'); }
  }
  async function restoreBoard(id) {
    try { await api.put(`/boards/${id}`, { isArchived: false }); setBoards(prev => prev.filter(b => b.id !== id)); toastSuccess('Board restored'); } catch (e) { console.error('Restore board failed:', e); toastError('Failed to restore board'); }
  }
  async function restoreWorkspace(id) {
    try { await api.put(`/workspaces/${id}/restore`); setWorkspaces(prev => prev.filter(w => w.id !== id)); loadArchived(); toastSuccess('Workspace restored'); } catch (e) { console.error('Restore workspace failed:', e); toastError('Failed to restore workspace'); }
  }
  async function restoreDep(id) {
    try { await api.put(`/archive/dependencies/${id}/restore`); setDependencies(prev => prev.filter(d => d.id !== id)); toastSuccess('Dependency restored'); } catch (e) { console.error('Restore dependency failed:', e); toastError('Failed to restore dependency'); }
  }
  async function restoreHelp(id) {
    try { await api.put(`/archive/help-requests/${id}/restore`); setHelpRequests(prev => prev.filter(h => h.id !== id)); toastSuccess('Help request restored'); } catch (e) { console.error('Restore help request failed:', e); toastError('Failed to restore help request'); }
  }
  async function restoreGroup(group) {
    try {
      // Fetch the current board to get its groups and archivedGroups
      const boardRes = await api.get(`/boards/${group.boardId}`);
      const boardData = boardRes.data.board || boardRes.data.data?.board || boardRes.data;
      const currentGroups = boardData.groups || [];
      const currentArchivedGroups = boardData.archivedGroups || [];

      // Remove the group from archivedGroups and add it back to groups
      const { archivedAt, taskCount, boardId: _bid, boardName: _bn, boardColor: _bc, ...groupData } = group;
      const updatedGroups = [...currentGroups, groupData];
      const updatedArchivedGroups = currentArchivedGroups.filter(g => g.id !== group.id);

      await api.put(`/boards/${group.boardId}`, { groups: updatedGroups, archivedGroups: updatedArchivedGroups });

      // Un-archive tasks that belonged to this group
      const archivedTasksRes = await api.get(`/tasks?archived=true&limit=200`);
      const archivedTasks = archivedTasksRes.data.tasks || archivedTasksRes.data || [];
      const groupTasks = archivedTasks.filter(t => t.groupId === group.id && t.boardId === group.boardId);
      await Promise.all(groupTasks.map(t => api.put(`/tasks/${t.id}`, { isArchived: false })));

      // Update local state
      setArchivedGroups(prev => prev.filter(g => !(g.id === group.id && g.boardId === group.boardId)));
      setTasks(prev => prev.filter(t => !(t.groupId === group.id && t.boardId === group.boardId)));
      toastSuccess('Group restored successfully');
    } catch (e) {
      console.error('Restore group failed:', e);
      toastError('Failed to restore group');
    }
  }

  async function handleDelete() {
    if (!deleteItem) return;
    try {
      if (deleteType === 'workspace') {
        await api.delete(`/workspaces/${deleteItem.id}`);
        setWorkspaces(prev => prev.filter(w => w.id !== deleteItem.id));
      } else if (deleteType === 'board') {
        await api.delete(`/boards/${deleteItem.id}`);
        setBoards(prev => prev.filter(b => b.id !== deleteItem.id));
      } else if (deleteType === 'dependency') {
        await api.delete(`/archive/dependencies/${deleteItem.id}`);
        setDependencies(prev => prev.filter(d => d.id !== deleteItem.id));
      } else if (deleteType === 'helpRequest') {
        await api.delete(`/archive/help-requests/${deleteItem.id}`);
        setHelpRequests(prev => prev.filter(h => h.id !== deleteItem.id));
      } else {
        await api.delete(`/tasks/${deleteItem.id}`);
        setTasks(prev => prev.filter(t => t.id !== deleteItem.id));
      }
    } catch (err) {
      const msg = err?.response?.data?.message;
      if (msg) alert(msg);
    }
    setDeleteItem(null); setDeleteType('');
  }

  // Group tasks by board
  const tasksByBoard = {};
  tasks.forEach(t => {
    const boardName = t.Board?.name || t.board?.name || 'Unknown Board';
    if (!tasksByBoard[boardName]) tasksByBoard[boardName] = [];
    tasksByBoard[boardName].push(t);
  });

  const filteredBoards = search ? boards.filter(b => b.name.toLowerCase().includes(search.toLowerCase())) : boards;
  const filteredWorkspaces = search ? workspaces.filter(w => w.name.toLowerCase().includes(search.toLowerCase())) : workspaces;

  const tabs = [
    { id: 'tasks', label: 'Tasks', icon: ListTodo, count: tasks.length },
    { id: 'boards', label: 'Boards', icon: FolderKanban, count: boards.length },
    { id: 'workspaces', label: 'Workspaces', icon: Building2, count: workspaces.length },
    { id: 'dependencies', label: 'Dependencies', icon: Link2, count: dependencies.length },
    { id: 'helpRequests', label: 'Help Requests', icon: HelpCircle, count: helpRequests.length },
  ];

  if (loading) return (
    <div className="p-8 max-w-[1000px] mx-auto space-y-4">
      <div className="h-8 w-40 bg-gray-100 rounded animate-pulse" />
      <div className="h-48 bg-gray-50 rounded-xl animate-pulse" />
    </div>
  );

  return (
    <div className="p-8 max-w-[1000px] mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
          <Archive size={20} className="text-gray-400" /> Archive
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">View, restore, or permanently delete archived items</p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-5 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-all whitespace-nowrap ${
              tab === t.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}>
            <t.icon size={15} /> {t.label}
            {t.count > 0 && <span className="text-[10px] bg-gray-100 text-gray-500 rounded-full px-1.5 py-0.5 ml-1">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Search + Filters */}
      <div className="flex items-center gap-2 mb-5">
        <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2 flex-1 max-w-md">
          <Search size={15} className="text-gray-400" />
          <input type="text" placeholder={`Search archived ${tab}...`} value={search} onChange={e => setSearch(e.target.value)}
            className="bg-transparent border-none outline-none text-sm w-full placeholder:text-gray-300" />
          {search && <button onClick={() => setSearch('')}><X size={14} className="text-gray-300" /></button>}
        </div>
        <button onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-xl border transition-colors ${showFilters ? 'bg-blue-50 border-blue-200 text-blue-600' : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
          <Filter size={13} /> Filters
        </button>
        {(dateFrom || dateTo) && (
          <button onClick={clearFilters} className="text-[10px] text-red-500 hover:underline">Clear</button>
        )}
      </div>

      {/* Filter bar */}
      {showFilters && (
        <div className="flex items-center gap-3 mb-5 bg-gray-50 rounded-xl p-3 border border-gray-100">
          <div className="flex items-center gap-2">
            <CalIcon size={13} className="text-gray-400" />
            <span className="text-[11px] text-gray-500 font-medium">Archived between:</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="text-[11px] border border-gray-200 rounded-lg px-2 py-1 bg-white" />
            <span className="text-gray-400">–</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="text-[11px] border border-gray-200 rounded-lg px-2 py-1 bg-white" />
          </div>
          <button onClick={loadArchived} className="text-[11px] font-medium text-blue-600 bg-blue-50 px-3 py-1 rounded-lg hover:bg-blue-100">Apply</button>
        </div>
      )}

      {/* ═══ TASKS TAB ═══ */}
      {tab === 'tasks' && (
        tasks.length === 0 && archivedGroups.length === 0 ? (
          <EmptyState icon={ListTodo} title="No archived tasks" subtitle="Tasks you archive will appear here." />
        ) : (
          <div className="space-y-4">
            {/* Archived Groups */}
            {archivedGroups.length > 0 && (
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2 px-1">
                  <Layers size={13} className="text-gray-400" />
                  <span className="text-[12px] font-semibold text-gray-500 uppercase tracking-wide">Archived Groups</span>
                  <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">{archivedGroups.length}</span>
                </div>
                <div className="space-y-1.5">
                  {archivedGroups.map(group => (
                    <div key={`${group.boardId}-${group.id}`} className="bg-white rounded-lg border border-gray-100 p-3 hover:shadow-sm transition-shadow flex items-center gap-3">
                      <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: group.color || '#579bfc' }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-gray-800 truncate">{group.title || group.name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-gray-400">Board: {group.boardName}</span>
                          {group.taskCount != null && <span className="text-[10px] text-gray-400">{group.taskCount} task{group.taskCount !== 1 ? 's' : ''}</span>}
                          {group.archivedAt && <span className="text-[10px] text-gray-400">Archived {formatDistanceToNow(parseISO(group.archivedAt), { addSuffix: true })}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button onClick={() => restoreGroup(group)} className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-blue-600 hover:bg-blue-50 rounded-md border border-blue-200 transition-colors">
                          <RotateCcw size={11} /> Restore
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Object.entries(tasksByBoard).map(([boardName, boardTasks]) => {
              const filtered = search ? boardTasks.filter(t => t.title.toLowerCase().includes(search.toLowerCase())) : boardTasks;
              if (filtered.length === 0) return null;
              return (
                <div key={boardName}>
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <FolderKanban size={13} className="text-gray-400" />
                    <span className="text-[12px] font-semibold text-gray-500 uppercase tracking-wide">{boardName}</span>
                    <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">{filtered.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    {filtered.map(task => {
                      const statusCfg = STATUS_CONFIG[task.status] || {};
                      const priorityCfg = PRIORITY_CONFIG[task.priority] || {};
                      const deletable = canDeleteItem(user, task.archivedAt);
                      return (
                        <div key={task.id} className="bg-white rounded-lg border border-gray-100 p-3 hover:shadow-sm transition-shadow flex items-center gap-3">
                          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: statusCfg.color || '#94a3b8' }} />
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-medium text-gray-800 truncate">{task.title}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium" style={{ backgroundColor: `${statusCfg.color || '#94a3b8'}15`, color: statusCfg.color }}>{statusCfg.label || task.status}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium" style={{ backgroundColor: `${priorityCfg.color || '#94a3b8'}15`, color: priorityCfg.color }}>{priorityCfg.label || task.priority}</span>
                              <ProtectionBadge archivedAt={task.archivedAt} />
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <button onClick={() => restoreTask(task.id)} className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-blue-600 hover:bg-blue-50 rounded-md border border-blue-200 transition-colors">
                              <RotateCcw size={11} /> Restore
                            </button>
                            {canManage && (
                              <button onClick={() => { setDeleteItem(task); setDeleteType('task'); }}
                                disabled={!deletable && !user?.isSuperAdmin}
                                className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors ${deletable || user?.isSuperAdmin ? 'text-red-500 hover:bg-red-50 border-red-200' : 'text-gray-300 border-gray-200 cursor-not-allowed'}`}
                                title={!deletable && !user?.isSuperAdmin ? 'Protected for 90 days' : ''}>
                                <Trash2 size={11} /> Delete
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ═══ BOARDS TAB ═══ */}
      {tab === 'boards' && (
        filteredBoards.length === 0 ? (
          <EmptyState icon={FolderKanban} title="No archived boards" subtitle="Boards you archive will appear here." />
        ) : (
          <div className="space-y-2">
            {filteredBoards.map(board => {
              const deletable = canDeleteItem(user, board.archivedAt);
              return (
                <div key={board.id} className="bg-white rounded-lg border border-gray-100 p-4 hover:shadow-sm transition-shadow flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${board.color || '#4f46e5'}12` }}>
                    <FolderKanban size={18} style={{ color: board.color || '#4f46e5' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-800">{board.name}</p>
                    <p className="text-xs text-gray-400">{board.description || 'No description'}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {board.updatedAt && <span className="text-[10px] text-gray-400">Archived {formatDistanceToNow(parseISO(board.updatedAt), { addSuffix: true })}</span>}
                      <ProtectionBadge archivedAt={board.archivedAt} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => restoreBoard(board.id)} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded-lg border border-blue-200 transition-colors">
                      <RotateCcw size={12} /> Restore
                    </button>
                    {canManage && (
                      <button onClick={() => { setDeleteItem(board); setDeleteType('board'); }}
                        disabled={!deletable && !user?.isSuperAdmin}
                        className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${deletable || user?.isSuperAdmin ? 'text-red-500 hover:bg-red-50 border-red-200' : 'text-gray-300 border-gray-200 cursor-not-allowed'}`}>
                        <Trash2 size={12} /> Delete
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ═══ WORKSPACES TAB ═══ */}
      {tab === 'workspaces' && (
        filteredWorkspaces.length === 0 ? (
          <EmptyState icon={Building2} title="No archived workspaces" subtitle="Workspaces you archive will appear here." />
        ) : (
          <div className="space-y-2">
            {filteredWorkspaces.map(ws => {
              const deletable = canDeleteItem(user, ws.archivedAt);
              return (
                <div key={ws.id} className="bg-white rounded-lg border border-gray-100 p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 text-white text-sm font-bold" style={{ backgroundColor: ws.color || '#6366f1' }}>
                      {ws.name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-800">{ws.name}</p>
                      <p className="text-xs text-gray-400">{ws.description || 'No description'}</p>
                      <div className="flex items-center gap-3 mt-1">
                        {ws.boards?.length > 0 && <span className="text-[10px] text-gray-400">{ws.boards.length} board{ws.boards.length !== 1 ? 's' : ''}</span>}
                        {ws.creator && <span className="text-[10px] text-gray-400">by {ws.creator.name}</span>}
                        <ProtectionBadge archivedAt={ws.archivedAt} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button onClick={() => restoreWorkspace(ws.id)} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded-lg border border-blue-200 transition-colors">
                        <RotateCcw size={12} /> Restore All
                      </button>
                      {isAdmin && (
                        <button onClick={() => { setDeleteItem(ws); setDeleteType('workspace'); }}
                          disabled={!deletable && !user?.isSuperAdmin}
                          className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${deletable || user?.isSuperAdmin ? 'text-red-500 hover:bg-red-50 border-red-200' : 'text-gray-300 border-gray-200 cursor-not-allowed'}`}>
                          <Trash2 size={12} /> Delete
                        </button>
                      )}
                    </div>
                  </div>
                  {ws.boards?.length > 0 && (
                    <div className="mt-3 pl-14 space-y-1">
                      {ws.boards.map(b => (
                        <div key={b.id} className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 rounded-md text-[11px]">
                          <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: b.color || '#0073ea' }} />
                          <span className="text-gray-600">{b.name}</span>
                          {b.isArchived && <span className="text-[9px] text-orange-500 bg-orange-50 px-1 rounded">archived</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ═══ DEPENDENCIES TAB ═══ */}
      {tab === 'dependencies' && (
        dependencies.length === 0 ? (
          <EmptyState icon={Link2} title="No archived dependencies" subtitle="Archived dependencies will appear here." />
        ) : (
          <div className="space-y-2">
            {dependencies.map(dep => {
              const deletable = canDeleteItem(user, dep.archivedAt);
              return (
                <div key={dep.id} className="bg-white rounded-lg border border-gray-100 p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-center gap-3 mb-2">
                    <Link2 size={14} className="text-purple-400 flex-shrink-0" />
                    <div className="flex-1 flex items-center gap-2 min-w-0">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          {dep.task?.board && <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dep.task.board.color || '#0073ea' }} />}
                          <span className="text-[10px] text-gray-400 truncate">{dep.task?.board?.name}</span>
                        </div>
                        <p className="text-[12px] font-medium text-gray-800 truncate">{dep.task?.title || 'Unknown task'}</p>
                      </div>
                      <div className="flex flex-col items-center flex-shrink-0 px-2">
                        <span className="text-[8px] text-gray-400 uppercase">needs</span>
                        <ArrowRight size={12} className="text-purple-300" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          {dep.dependsOnTask?.board && <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dep.dependsOnTask.board.color || '#0073ea' }} />}
                          <span className="text-[10px] text-gray-400 truncate">{dep.dependsOnTask?.board?.name}</span>
                        </div>
                        <p className="text-[12px] font-medium text-gray-800 truncate">{dep.dependsOnTask?.title || 'Unknown task'}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-6">
                    <span className="text-[9px] px-1.5 py-0.5 bg-purple-50 text-purple-500 rounded font-medium capitalize">{dep.dependencyType?.replace('_', ' ')}</span>
                    {dep.createdBy && <span className="text-[9px] text-gray-400">by {dep.createdBy.name}</span>}
                    {dep.archiver && <span className="text-[9px] text-gray-400">archived by {dep.archiver.name}</span>}
                    <ProtectionBadge archivedAt={dep.archivedAt} />
                  </div>
                  <div className="flex items-center justify-end gap-1.5 mt-2">
                    <button onClick={() => restoreDep(dep.id)} className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-blue-600 hover:bg-blue-50 rounded-md border border-blue-200 transition-colors">
                      <RotateCcw size={11} /> Restore
                    </button>
                    <button onClick={() => { setDeleteItem(dep); setDeleteType('dependency'); }}
                      disabled={!deletable && !user?.isSuperAdmin}
                      className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors ${deletable || user?.isSuperAdmin ? 'text-red-500 hover:bg-red-50 border-red-200' : 'text-gray-300 border-gray-200 cursor-not-allowed'}`}>
                      <Trash2 size={11} /> Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ═══ HELP REQUESTS TAB ═══ */}
      {tab === 'helpRequests' && (
        helpRequests.length === 0 ? (
          <EmptyState icon={HelpCircle} title="No archived help requests" subtitle="Archived help requests will appear here." />
        ) : (
          <div className="space-y-2">
            {helpRequests.map(hr => {
              const deletable = canDeleteItem(user, hr.archivedAt);
              const urgencyColors = { critical: 'text-red-600 bg-red-50', high: 'text-orange-600 bg-orange-50', medium: 'text-yellow-600 bg-yellow-50', low: 'text-gray-500 bg-gray-50' };
              return (
                <div key={hr.id} className="bg-white rounded-lg border border-gray-100 p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-yellow-50 flex items-center justify-center flex-shrink-0">
                      <HelpCircle size={14} className="text-yellow-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-gray-800 truncate">{hr.task?.title || 'Task'}</p>
                      <p className="text-[10px] text-gray-400 truncate">{hr.description}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[9px] text-gray-400">From: {hr.requester?.name}</span>
                        <span className="text-[9px] text-gray-400">Helper: {hr.helper?.name}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${urgencyColors[hr.urgency] || ''}`}>{hr.urgency}</span>
                        {hr.archiver && <span className="text-[9px] text-gray-400">archived by {hr.archiver.name}</span>}
                        <ProtectionBadge archivedAt={hr.archivedAt} />
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button onClick={() => restoreHelp(hr.id)} className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-blue-600 hover:bg-blue-50 rounded-md border border-blue-200 transition-colors">
                        <RotateCcw size={11} /> Restore
                      </button>
                      <button onClick={() => { setDeleteItem(hr); setDeleteType('helpRequest'); }}
                        disabled={!deletable && !user?.isSuperAdmin}
                        className={`flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors ${deletable || user?.isSuperAdmin ? 'text-red-500 hover:bg-red-50 border-red-200' : 'text-gray-300 border-gray-200 cursor-not-allowed'}`}>
                        <Trash2 size={11} /> Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* Delete Confirmation */}
      {deleteItem && (
        <ConfirmDeleteModal
          item={deleteItem}
          type={deleteType}
          onConfirm={handleDelete}
          onCancel={() => { setDeleteItem(null); setDeleteType(''); }}
          canDelete={canDeleteItem(user, deleteItem.archivedAt)}
        />
      )}
    </div>
  );
}

function EmptyState({ icon: Icon, title, subtitle }) {
  return (
    <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
      <Icon size={36} className="mx-auto text-gray-200 mb-3" />
      <p className="text-sm text-gray-500 font-medium">{title}</p>
      <p className="text-xs text-gray-400 mt-1">{subtitle}</p>
    </div>
  );
}
