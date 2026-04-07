import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { format, addDays, subDays, startOfWeek, isToday } from 'date-fns';
import {
  Clock, ChevronLeft, ChevronRight, Calendar, LayoutGrid, Save, Trash2,
  Plus, GripVertical, Check, X, Briefcase, Edit2, RefreshCw, Download,
  Upload, Crown, Users, User
} from 'lucide-react';
import { STATUS_CONFIG } from '../utils/constants';

const HOURS = Array.from({ length: 13 }, (_, i) => i + 8); // 8am to 8pm

export default function WorkspaceTimePlannerPage() {
  const { user, canManage } = useAuth();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [workspaces, setWorkspaces] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [timeBlocks, setTimeBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('daily'); // daily | weekly
  const [showForm, setShowForm] = useState(false);
  const [editBlock, setEditBlock] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [allUsers, setAllUsers] = useState([]);

  // Form state
  const [formData, setFormData] = useState({
    startTime: '09:00', endTime: '10:00', description: '', taskId: '', workspaceId: '',
  });

  useEffect(() => { fetchData(); }, [currentDate, selectedEmployee]);

  useEffect(() => {
    const saved = localStorage.getItem('timePlanTemplates');
    if (saved) setTemplates(JSON.parse(saved));
  }, []);

  async function fetchData() {
    setLoading(true);
    try {
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      const userId = selectedEmployee || user?.id;

      const [wsRes, blockRes, usersRes] = await Promise.all([
        api.get('/workspaces'),
        selectedEmployee
          ? api.get(`/timeplans/employee/${userId}?date=${dateStr}`)
          : api.get(`/timeplans/my?date=${dateStr}`),
        canManage ? api.get('/auth/users') : Promise.resolve({ data: { users: [] } }),
      ]);

      setWorkspaces(wsRes.data.workspaces || []);
      setTimeBlocks(blockRes.data.timeBlocks || blockRes.data || []);
      setAllUsers((usersRes.data.users || usersRes.data || []).filter(u => u.isActive !== false));

      // Fetch all tasks for the user
      const taskRes = await api.get(`/tasks?assignedTo=me`);
      setTasks(taskRes.data.tasks || taskRes.data || []);
    } catch (err) {
      console.error('Workspace time planner error:', err);
    } finally {
      setLoading(false);
    }
  }

  function getBlocksForWorkspace(wsId) {
    return timeBlocks.filter(b => {
      if (wsId === 'unassigned') return !b.boardId && !getWorkspaceForBoard(b.boardId);
      const ws = getWorkspaceForBoard(b.boardId);
      return ws?.id === wsId;
    });
  }

  function getWorkspaceForBoard(boardId) {
    if (!boardId) return null;
    for (const ws of workspaces) {
      if (ws.boards?.some(b => b.id === boardId)) return ws;
    }
    return null;
  }

  function getTasksForWorkspace(wsId) {
    return tasks.filter(t => {
      if (wsId === 'unassigned') {
        return !workspaces.some(ws => ws.boards?.some(b => b.id === t.boardId));
      }
      const ws = workspaces.find(w => w.boards?.some(b => b.id === t.boardId));
      return ws?.id === wsId;
    });
  }

  async function handleCreateBlock() {
    try {
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      const payload = {
        date: dateStr,
        startTime: formData.startTime,
        endTime: formData.endTime,
        description: formData.description,
        taskId: formData.taskId || null,
        boardId: formData.boardId || null,
      };

      if (editBlock) {
        await api.put(`/timeplans/${editBlock.id}`, payload);
      } else {
        await api.post('/timeplans', payload);
      }

      setShowForm(false);
      setEditBlock(null);
      setFormData({ startTime: '09:00', endTime: '10:00', description: '', taskId: '', workspaceId: '' });
      fetchData();
    } catch (err) {
      console.error('Create block error:', err);
    }
  }

  async function handleDeleteBlock(id) {
    try {
      await api.delete(`/timeplans/${id}`);
      fetchData();
    } catch (err) {
      console.error('Delete block error:', err);
    }
  }

  function openEditBlock(block) {
    setEditBlock(block);
    setFormData({
      startTime: block.startTime,
      endTime: block.endTime,
      description: block.description || '',
      taskId: block.taskId || '',
      boardId: block.boardId || '',
      workspaceId: '',
    });
    setShowForm(true);
  }

  function saveTemplate() {
    if (!templateName.trim()) return;
    const template = {
      id: Date.now(),
      name: templateName,
      blocks: timeBlocks.map(b => ({
        startTime: b.startTime,
        endTime: b.endTime,
        description: b.description,
        taskId: b.taskId,
        boardId: b.boardId,
      })),
    };
    const updated = [...templates, template];
    setTemplates(updated);
    localStorage.setItem('timePlanTemplates', JSON.stringify(updated));
    setTemplateName('');
    setShowSaveTemplate(false);
  }

  async function applyTemplate(template) {
    const dateStr = format(currentDate, 'yyyy-MM-dd');
    try {
      for (const block of template.blocks) {
        await api.post('/timeplans', { ...block, date: dateStr });
      }
      fetchData();
      setShowTemplates(false);
    } catch (err) {
      console.error('Apply template error:', err);
    }
  }

  function deleteTemplate(id) {
    const updated = templates.filter(t => t.id !== id);
    setTemplates(updated);
    localStorage.setItem('timePlanTemplates', JSON.stringify(updated));
  }

  // Group workspaces with their time blocks
  const workspaceSchedule = [
    ...workspaces.map(ws => ({
      id: ws.id,
      name: ws.name,
      color: ws.color,
      icon: ws.icon,
      blocks: getBlocksForWorkspace(ws.id),
      tasks: getTasksForWorkspace(ws.id),
    })),
    {
      id: 'unassigned',
      name: 'Other Tasks',
      color: '#c4c4c4',
      icon: 'Briefcase',
      blocks: getBlocksForWorkspace('unassigned'),
      tasks: getTasksForWorkspace('unassigned'),
    },
  ].filter(ws => ws.blocks.length > 0 || ws.tasks.length > 0);

  // Calculate total hours
  const totalHours = timeBlocks.reduce((sum, b) => {
    const [sh, sm] = b.startTime.split(':').map(Number);
    const [eh, em] = b.endTime.split(':').map(Number);
    return sum + (eh + em / 60) - (sh + sm / 60);
  }, 0);

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        {[1, 2, 3].map(i => <div key={i} className="animate-pulse bg-gray-100 dark:bg-zinc-800 rounded-xl h-32" />)}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <LayoutGrid size={24} className="text-primary" />
            Workspace Time Planner
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {selectedEmployee ? `Viewing ${allUsers.find(u => u.id === selectedEmployee)?.name}'s schedule` : 'Plan your day by workspace'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Employee selector (managers only) */}
          {canManage && (
            <select value={selectedEmployee || ''} onChange={e => setSelectedEmployee(e.target.value || null)}
              className="text-xs border border-gray-200 dark:border-zinc-600 rounded-lg px-3 py-2 focus:outline-none focus:border-primary">
              <option value="">My Schedule</option>
              {allUsers.map(u => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
            </select>
          )}

          {/* Templates */}
          <div className="relative">
            <button onClick={() => setShowTemplates(!showTemplates)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-gray-200 dark:border-zinc-600 rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-700">
              <Download size={13} /> Templates
            </button>
            {showTemplates && (
              <div className="absolute right-0 top-full mt-1 w-56 bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-gray-200 dark:border-zinc-700 z-50 py-1">
                {templates.map(t => (
                  <div key={t.id} className="flex items-center justify-between px-3 py-2 hover:bg-gray-50 dark:hover:bg-zinc-700">
                    <button onClick={() => applyTemplate(t)} className="text-xs text-gray-700 dark:text-gray-300 flex-1 text-left truncate">{t.name}</button>
                    <button onClick={() => deleteTemplate(t.id)} className="text-gray-400 hover:text-red-500 ml-2"><X size={11} /></button>
                  </div>
                ))}
                {templates.length === 0 && <p className="text-xs text-gray-400 px-3 py-2">No saved templates</p>}
              </div>
            )}
          </div>

          {/* Save as template */}
          {showSaveTemplate ? (
            <div className="flex items-center gap-1">
              <input type="text" value={templateName} onChange={e => setTemplateName(e.target.value)}
                placeholder="Template name" className="text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 w-32 focus:outline-none focus:border-primary"
                onKeyDown={e => e.key === 'Enter' && saveTemplate()} autoFocus />
              <button onClick={saveTemplate} className="text-xs text-primary font-medium">Save</button>
              <button onClick={() => setShowSaveTemplate(false)} className="text-gray-400"><X size={12} /></button>
            </div>
          ) : (
            <button onClick={() => setShowSaveTemplate(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-gray-200 dark:border-zinc-600 rounded-lg hover:bg-gray-50 dark:hover:bg-zinc-700">
              <Save size={13} /> Save Day
            </button>
          )}

          <button onClick={() => { setShowForm(true); setEditBlock(null); setFormData({ startTime: '09:00', endTime: '10:00', description: '', taskId: '', workspaceId: '' }); }}
            className="flex items-center gap-1.5 px-3 py-2 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary/90">
            <Plus size={13} /> Add Block
          </button>
        </div>
      </motion.div>

      {/* Date Navigation */}
      <div className="flex items-center justify-between mb-6 bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-3">
        <button onClick={() => setCurrentDate(d => subDays(d, 1))} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-700">
          <ChevronLeft size={18} className="text-gray-500" />
        </button>
        <div className="flex items-center gap-3">
          <button onClick={() => setCurrentDate(new Date())}
            className={`px-3 py-1 text-xs font-medium rounded-md ${isToday(currentDate) ? 'bg-primary text-white' : 'text-primary hover:bg-primary/5'}`}>
            Today
          </button>
          <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">
            {format(currentDate, 'EEEE, MMMM d, yyyy')}
          </h2>
          <span className="text-xs text-gray-400 bg-gray-100 dark:bg-zinc-700 px-2 py-0.5 rounded-full">
            {totalHours.toFixed(1)}h planned
          </span>
        </div>
        <button onClick={() => setCurrentDate(d => addDays(d, 1))} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-700">
          <ChevronRight size={18} className="text-gray-500" />
        </button>
      </div>

      {/* Workspace Schedule View */}
      <div className="space-y-4">
        {workspaceSchedule.map(ws => (
          <motion.div key={ws.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
            {/* Workspace Header */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 dark:border-zinc-700"
              style={{ borderLeft: `4px solid ${ws.color}` }}>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${ws.color}15` }}>
                <Briefcase size={16} style={{ color: ws.color }} />
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{ws.name}</h3>
                <p className="text-[10px] text-gray-400">{ws.blocks.length} time block(s) · {ws.tasks.length} task(s)</p>
              </div>
              <span className="text-xs text-gray-400">
                {ws.blocks.reduce((sum, b) => {
                  const [sh, sm] = b.startTime.split(':').map(Number);
                  const [eh, em] = b.endTime.split(':').map(Number);
                  return sum + (eh + em / 60) - (sh + sm / 60);
                }, 0).toFixed(1)}h
              </span>
            </div>

            {/* Time Blocks */}
            <div className="p-4">
              {ws.blocks.length > 0 ? (
                <div className="space-y-2">
                  {ws.blocks.sort((a, b) => a.startTime.localeCompare(b.startTime)).map(block => (
                    <motion.div key={block.id} whileHover={{ scale: 1.01 }}
                      className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-700/50 cursor-pointer group"
                      onClick={() => openEditBlock(block)}>
                      <div className="flex items-center gap-1 min-w-[100px]">
                        <Clock size={12} className="text-gray-400" />
                        <span className="text-xs font-mono font-medium text-gray-700 dark:text-gray-300">
                          {block.startTime} - {block.endTime}
                        </span>
                      </div>
                      <div className="flex-1">
                        <p className="text-sm text-gray-800 dark:text-gray-200">{block.description || block.task?.title || 'Untitled'}</p>
                        {block.task && (
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: STATUS_CONFIG[block.task.status]?.bgColor }}>
                              {STATUS_CONFIG[block.task.status]?.label}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1">
                        <button onClick={(e) => { e.stopPropagation(); openEditBlock(block); }}
                          className="p-1 text-gray-400 hover:text-primary rounded"><Edit2 size={12} /></button>
                        <button onClick={(e) => { e.stopPropagation(); handleDeleteBlock(block.id); }}
                          className="p-1 text-gray-400 hover:text-red-500 rounded"><Trash2 size={12} /></button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-400 py-2">No time blocks for this workspace today</p>
              )}

              {/* Quick-add tasks from workspace */}
              {ws.tasks.filter(t => t.status !== 'done' && !ws.blocks.some(b => b.taskId === t.id)).length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-100 dark:border-zinc-700">
                  <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-2">Unscheduled Tasks</p>
                  <div className="flex flex-wrap gap-2">
                    {ws.tasks.filter(t => t.status !== 'done' && !ws.blocks.some(b => b.taskId === t.id)).slice(0, 5).map(t => (
                      <button key={t.id} onClick={() => {
                        setFormData({ startTime: '09:00', endTime: '10:00', description: t.title, taskId: t.id, boardId: t.boardId, workspaceId: ws.id });
                        setEditBlock(null);
                        setShowForm(true);
                      }}
                        className="flex items-center gap-1 px-2 py-1 text-[10px] bg-gray-50 dark:bg-zinc-700 rounded-md hover:bg-gray-100 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-zinc-600">
                        <Plus size={9} /> {t.title.length > 30 ? t.title.slice(0, 30) + '...' : t.title}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        ))}

        {workspaceSchedule.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <Calendar size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No scheduled work for this day</p>
            <p className="text-xs mt-1">Click "Add Block" to plan your workspace time</p>
          </div>
        )}
      </div>

      {/* Add/Edit Block Modal */}
      <AnimatePresence>
        {showForm && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowForm(false)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-bold text-gray-800 dark:text-gray-200 mb-4">
                {editBlock ? 'Edit Time Block' : 'Add Time Block'}
              </h3>

              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Start Time</label>
                    <input type="time" value={formData.startTime} onChange={e => setFormData({ ...formData, startTime: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">End Time</label>
                    <input type="time" value={formData.endTime} onChange={e => setFormData({ ...formData, endTime: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary" />
                  </div>
                </div>

                {/* Quick duration buttons */}
                <div className="flex gap-2">
                  {[{ label: '30m', mins: 30 }, { label: '1h', mins: 60 }, { label: '1.5h', mins: 90 }, { label: '2h', mins: 120 }, { label: '3h', mins: 180 }].map(d => (
                    <button key={d.label} onClick={() => {
                      const [h, m] = formData.startTime.split(':').map(Number);
                      const end = h * 60 + m + d.mins;
                      const eh = Math.floor(end / 60).toString().padStart(2, '0');
                      const em = (end % 60).toString().padStart(2, '0');
                      setFormData({ ...formData, endTime: `${eh}:${em}` });
                    }}
                      className="px-2.5 py-1 text-[10px] bg-gray-100 dark:bg-zinc-700 rounded-md hover:bg-gray-200 text-gray-600 dark:text-gray-400 font-medium">
                      {d.label}
                    </button>
                  ))}
                </div>

                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Workspace</label>
                  <select value={formData.workspaceId} onChange={e => setFormData({ ...formData, workspaceId: e.target.value, taskId: '' })}
                    className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
                    <option value="">All workspaces</option>
                    {workspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Link to Task (optional)</label>
                  <select value={formData.taskId} onChange={e => {
                    const t = tasks.find(t => t.id === e.target.value);
                    setFormData({ ...formData, taskId: e.target.value, description: t?.title || formData.description, boardId: t?.boardId || '' });
                  }}
                    className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
                    <option value="">No task</option>
                    {(formData.workspaceId
                      ? getTasksForWorkspace(formData.workspaceId)
                      : tasks
                    ).filter(t => t.status !== 'done').map(t => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Description</label>
                  <input type="text" value={formData.description} onChange={e => setFormData({ ...formData, description: e.target.value })}
                    placeholder="What will you work on?" className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary" />
                </div>

                <div className="flex gap-2 pt-2">
                  <button onClick={handleCreateBlock}
                    className="flex-1 py-2.5 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90">
                    {editBlock ? 'Update' : 'Add Block'}
                  </button>
                  <button onClick={() => { setShowForm(false); setEditBlock(null); }}
                    className="px-4 py-2.5 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
