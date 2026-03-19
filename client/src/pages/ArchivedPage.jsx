import React, { useState, useEffect } from 'react';
import { Archive, RotateCcw, Trash2, Search, FolderKanban, ListTodo, AlertTriangle, X, Building2, Layers } from 'lucide-react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../utils/constants';

function ConfirmDeleteModal({ item, type, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
        <div className="p-6 text-center">
          <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle size={28} className="text-red-500" />
          </div>
          <h3 className="text-lg font-bold text-gray-800 mb-2">Permanently Delete?</h3>
          <p className="text-sm text-gray-500 mb-1">Are you sure you want to permanently delete this {type}?</p>
          <p className="text-sm font-semibold text-gray-800 mb-3">"{item?.name || item?.title}"</p>
          <p className="text-xs text-red-500 font-medium bg-red-50 rounded-lg px-3 py-2 mb-5">
            This action cannot be undone. All associated data will be permanently removed.
          </p>
          <div className="flex gap-3">
            <button onClick={onCancel} className="flex-1 py-2.5 border border-gray-200 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors">Cancel</button>
            <button onClick={onConfirm} className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 transition-colors flex items-center justify-center gap-2">
              <Trash2 size={14} /> Delete Permanently
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ArchivedPage() {
  const { canManage, isAdmin } = useAuth();
  const [boards, setBoards] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('tasks');
  const [search, setSearch] = useState('');
  const [deleteItem, setDeleteItem] = useState(null);
  const [deleteType, setDeleteType] = useState('');

  useEffect(() => { loadArchived(); }, []);

  async function loadArchived() {
    setLoading(true);
    try {
      const [boardsRes, tasksRes, wsRes] = await Promise.all([
        api.get('/boards?archived=true'),
        api.get('/tasks?archived=true&limit=200'),
        canManage ? api.get('/workspaces/archived').catch(() => ({ data: { data: { workspaces: [] } } })) : Promise.resolve({ data: { data: { workspaces: [] } } }),
      ]);
      setBoards((boardsRes.data.boards || boardsRes.data || []).filter(b => b.isArchived));
      setTasks(tasksRes.data.tasks || tasksRes.data || []);
      const wsData = wsRes.data?.data || wsRes.data;
      setWorkspaces(wsData?.workspaces || []);
    } catch (err) {
      console.error('Failed to load archived items:', err);
    }
    setLoading(false);
  }

  async function restoreTask(id) {
    try { await api.put(`/tasks/${id}`, { isArchived: false }); setTasks(prev => prev.filter(t => t.id !== id)); } catch {}
  }
  async function restoreBoard(id) {
    try { await api.put(`/boards/${id}`, { isArchived: false }); setBoards(prev => prev.filter(b => b.id !== id)); } catch {}
  }
  async function restoreWorkspace(id) {
    try { await api.put(`/workspaces/${id}/restore`); setWorkspaces(prev => prev.filter(w => w.id !== id)); loadArchived(); } catch {}
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
      } else {
        await api.delete(`/tasks/${deleteItem.id}`);
        setTasks(prev => prev.filter(t => t.id !== deleteItem.id));
      }
    } catch {}
    setDeleteItem(null); setDeleteType('');
  }

  // Group tasks by board for structured view
  const tasksByBoard = {};
  tasks.forEach(t => {
    const boardName = t.Board?.name || t.board?.name || 'Unknown Board';
    if (!tasksByBoard[boardName]) tasksByBoard[boardName] = [];
    tasksByBoard[boardName].push(t);
  });

  const filteredBoards = search ? boards.filter(b => b.name.toLowerCase().includes(search.toLowerCase())) : boards;
  const filteredWorkspaces = search ? workspaces.filter(w => w.name.toLowerCase().includes(search.toLowerCase())) : workspaces;

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
      <div className="flex items-center gap-1 border-b border-gray-200 mb-5">
        {[
          { id: 'tasks', label: 'Tasks', icon: ListTodo, count: tasks.length },
          { id: 'boards', label: 'Boards', icon: FolderKanban, count: boards.length },
          { id: 'workspaces', label: 'Workspaces', icon: Building2, count: workspaces.length },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-all ${
              tab === t.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}>
            <t.icon size={15} /> {t.label}
            {t.count > 0 && <span className="text-[10px] bg-gray-100 text-gray-500 rounded-full px-1.5 py-0.5 ml-1">{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2 mb-5 max-w-md">
        <Search size={15} className="text-gray-400" />
        <input type="text" placeholder={`Search archived ${tab}...`} value={search} onChange={e => setSearch(e.target.value)}
          className="bg-transparent border-none outline-none text-sm w-full placeholder:text-gray-300" />
        {search && <button onClick={() => setSearch('')}><X size={14} className="text-gray-300" /></button>}
      </div>

      {/* ═══ TASKS TAB ═══ */}
      {tab === 'tasks' && (
        tasks.length === 0 ? (
          <EmptyState icon={ListTodo} title="No archived tasks" subtitle="Tasks you archive will appear here." />
        ) : (
          <div className="space-y-4">
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
                      return (
                        <div key={task.id} className="bg-white rounded-lg border border-gray-100 p-3 hover:shadow-sm transition-shadow flex items-center gap-3">
                          <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: statusCfg.color || '#94a3b8' }} />
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-medium text-gray-800 truncate">{task.title}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium" style={{ backgroundColor: `${statusCfg.color || '#94a3b8'}15`, color: statusCfg.color }}>{statusCfg.label || task.status}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded-md font-medium" style={{ backgroundColor: `${priorityCfg.color || '#94a3b8'}15`, color: priorityCfg.color }}>{priorityCfg.label || task.priority}</span>
                              {task.updatedAt && <span className="text-[9px] text-gray-400">{formatDistanceToNow(parseISO(task.updatedAt), { addSuffix: true })}</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <button onClick={() => restoreTask(task.id)} className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-blue-600 hover:bg-blue-50 rounded-md border border-blue-200 transition-colors">
                              <RotateCcw size={11} /> Restore
                            </button>
                            {canManage && (
                              <button onClick={() => { setDeleteItem(task); setDeleteType('task'); }} className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-red-500 hover:bg-red-50 rounded-md border border-red-200 transition-colors">
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
            {filteredBoards.map(board => (
              <div key={board.id} className="bg-white rounded-lg border border-gray-100 p-4 hover:shadow-sm transition-shadow flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${board.color || '#4f46e5'}12` }}>
                  <FolderKanban size={18} style={{ color: board.color || '#4f46e5' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800">{board.name}</p>
                  <p className="text-xs text-gray-400">{board.description || 'No description'}</p>
                  {board.updatedAt && <p className="text-[10px] text-gray-400 mt-0.5">Archived {formatDistanceToNow(parseISO(board.updatedAt), { addSuffix: true })}</p>}
                  {/* Show archived groups if any */}
                  {board.archivedGroups?.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <Layers size={10} className="text-gray-400" />
                      <span className="text-[10px] text-gray-400">{board.archivedGroups.length} archived group{board.archivedGroups.length !== 1 ? 's' : ''}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button onClick={() => restoreBoard(board.id)} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded-lg border border-blue-200 transition-colors">
                    <RotateCcw size={12} /> Restore
                  </button>
                  {canManage && (
                    <button onClick={() => { setDeleteItem(board); setDeleteType('board'); }} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 rounded-lg border border-red-200 transition-colors">
                      <Trash2 size={12} /> Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* ═══ WORKSPACES TAB ═══ */}
      {tab === 'workspaces' && (
        filteredWorkspaces.length === 0 ? (
          <EmptyState icon={Building2} title="No archived workspaces" subtitle="Workspaces you archive will appear here." />
        ) : (
          <div className="space-y-2">
            {filteredWorkspaces.map(ws => (
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
                      {ws.updatedAt && <span className="text-[10px] text-gray-400">Archived {formatDistanceToNow(parseISO(ws.updatedAt), { addSuffix: true })}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => restoreWorkspace(ws.id)} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded-lg border border-blue-200 transition-colors">
                      <RotateCcw size={12} /> Restore All
                    </button>
                    {isAdmin && (
                      <button onClick={() => { setDeleteItem(ws); setDeleteType('workspace'); }} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 rounded-lg border border-red-200 transition-colors">
                        <Trash2 size={12} /> Delete
                      </button>
                    )}
                  </div>
                </div>
                {/* Show boards inside this workspace */}
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
            ))}
          </div>
        )
      )}

      {/* Delete Confirmation */}
      {deleteItem && (
        <ConfirmDeleteModal item={deleteItem} type={deleteType} onConfirm={handleDelete} onCancel={() => { setDeleteItem(null); setDeleteType(''); }} />
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
