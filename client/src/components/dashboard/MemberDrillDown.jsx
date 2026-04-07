import React, { useState, useEffect } from 'react';
import { X, Plus, CheckCircle2, Clock, AlertTriangle, ListChecks, MessageSquare, ChevronRight } from 'lucide-react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import api from '../../services/api';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../../utils/constants';
import Avatar from '../common/Avatar';

export default function MemberDrillDown({ userId, boardId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('all');
  const [addingTask, setAddingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskBoardId, setNewTaskBoardId] = useState(boardId || '');
  const [boards, setBoards] = useState([]);
  const [commentTaskId, setCommentTaskId] = useState(null);
  const [commentText, setCommentText] = useState('');

  useEffect(() => {
    loadMemberData();
    if (!boardId) loadBoards();
  }, [userId, boardId]);

  async function loadMemberData() {
    try {
      setLoading(true);
      const params = boardId ? `?boardId=${boardId}` : '';
      const res = await api.get(`/dashboard/member/${userId}/tasks${params}`);
      setData(res.data.data || res.data);
    } catch (err) {
      console.error('Failed to load member data:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadBoards() {
    try {
      const res = await api.get('/boards');
      setBoards(res.data.boards || res.data || []);
    } catch {}
  }

  async function handleAddTask(e) {
    if (e.key === 'Escape') { setAddingTask(false); setNewTaskTitle(''); return; }
    if (e.key !== 'Enter' || !newTaskTitle.trim()) return;
    const targetBoard = newTaskBoardId || boardId;
    if (!targetBoard) return;
    try {
      await api.post('/tasks', {
        title: newTaskTitle.trim(),
        boardId: targetBoard,
        assignedTo: userId,
        status: 'not_started',
        priority: 'medium',
      });
      setNewTaskTitle('');
      setAddingTask(false);
      loadMemberData();
    } catch (err) {
      console.error('Failed to add task:', err);
    }
  }

  async function handleAddComment(taskId) {
    if (!commentText.trim()) return;
    try {
      await api.post('/comments', { taskId, content: commentText.trim() });
      setCommentText('');
      setCommentTaskId(null);
    } catch (err) {
      console.error('Failed to add comment:', err);
    }
  }

  async function handleStatusChange(taskId, newStatus) {
    try {
      await api.put(`/tasks/${taskId}`, { status: newStatus });
      loadMemberData();
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }

  if (loading || !data) {
    return (
      <div className="fixed inset-0 z-50 flex" onClick={onClose}>
        <div className="flex-1" />
        <div className="w-full max-w-[550px] bg-white shadow-2xl h-full flex items-center justify-center animate-slide-in-right" onClick={e => e.stopPropagation()}>
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" />
        </div>
      </div>
    );
  }

  const { member, tasks, summary } = data;
  const completionRate = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;

  const filteredTasks = activeFilter === 'all'
    ? tasks
    : activeFilter === 'overdue'
      ? tasks.filter(t => t.dueDate && t.dueDate < new Date().toISOString().slice(0, 10) && t.status !== 'done')
      : tasks.filter(t => t.status === activeFilter);

  const statusFilters = [
    { id: 'all', label: 'All', count: summary.total },
    { id: 'not_started', label: 'Not Started', count: summary.notStarted, color: '#c4c4c4' },
    { id: 'working_on_it', label: 'Working', count: summary.working, color: '#fdab3d' },
    { id: 'stuck', label: 'Stuck', count: summary.stuck, color: '#e2445c' },
    { id: 'done', label: 'Done', count: summary.done, color: '#00c875' },
    { id: 'overdue', label: 'Overdue', count: summary.overdue, color: '#e2445c' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/20" />
      <div className="w-full max-w-[550px] bg-white shadow-2xl h-full flex flex-col animate-slide-in-right" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <Avatar name={member.name} size="lg" />
              <div>
                <h2 className="text-lg font-bold text-text-primary">{member.name}</h2>
                <p className="text-xs text-text-tertiary">{member.designation || member.role} {member.department ? `- ${member.department}` : ''}</p>
                <p className="text-xs text-text-tertiary">{member.email}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface text-text-secondary"><X size={18} /></button>
          </div>

          {/* Mini Stats */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'Total', value: summary.total, color: '#0073ea', icon: ListChecks },
              { label: 'Done', value: summary.done, color: '#00c875', icon: CheckCircle2 },
              { label: 'Working', value: summary.working, color: '#fdab3d', icon: Clock },
              { label: 'Stuck', value: summary.stuck, color: '#e2445c', icon: AlertTriangle },
            ].map(s => {
              const Icon = s.icon;
              return (
                <div key={s.label} className="text-center p-2 rounded-lg bg-surface/50">
                  <Icon size={14} className="mx-auto mb-1" style={{ color: s.color }} />
                  <p className="text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
                  <p className="text-[10px] text-text-tertiary uppercase tracking-wider">{s.label}</p>
                </div>
              );
            })}
          </div>

          {/* Progress bar */}
          <div className="mt-3 flex items-center gap-2">
            <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{ width: `${completionRate}%`, backgroundColor: completionRate === 100 ? '#00c875' : '#0073ea' }} />
            </div>
            <span className="text-xs font-semibold text-text-secondary">{completionRate}%</span>
          </div>
        </div>

        {/* Filter Chips */}
        <div className="px-5 py-2 border-b border-border flex items-center gap-1.5 overflow-x-auto">
          {statusFilters.map(f => (
            <button key={f.id} onClick={() => setActiveFilter(f.id)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                activeFilter === f.id ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface/80'
              }`}>
              {f.color && <div className="w-2 h-2 rounded-full" style={{ backgroundColor: activeFilter === f.id ? '#fff' : f.color }} />}
              {f.label} ({f.count})
            </button>
          ))}
        </div>

        {/* Add Task */}
        <div className="px-5 py-2 border-b border-border">
          {addingTask ? (
            <div className="flex items-center gap-2">
              {!boardId && (
                <select value={newTaskBoardId} onChange={e => setNewTaskBoardId(e.target.value)}
                  className="text-xs border border-border rounded-md px-2 py-1.5 bg-white w-[120px]">
                  <option value="">Board...</option>
                  {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              )}
              <input type="text" value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)} onKeyDown={handleAddTask}
                onBlur={() => { if (!newTaskTitle) setAddingTask(false); }}
                placeholder="Task name (Enter to add, Esc to cancel)" className="flex-1 text-sm border border-border rounded-md px-3 py-1.5 focus:outline-none focus:border-primary" autoFocus />
            </div>
          ) : (
            <button onClick={() => setAddingTask(true)} className="flex items-center gap-1.5 text-sm text-primary hover:text-primary-600 font-medium">
              <Plus size={14} /> Add task for {member.name.split(' ')[0]}
            </button>
          )}
        </div>

        {/* Task List */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {filteredTasks.length === 0 ? (
            <div className="text-center py-12">
              <ListChecks size={36} className="mx-auto text-text-tertiary mb-2" />
              <p className="text-sm text-text-secondary">No tasks found</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredTasks.map(task => {
                const statusCfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.not_started;
                const priorityCfg = PRIORITY_CONFIG[task.priority];
                const isOverdue = task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10) && task.status !== 'done';
                const subtasksDone = task.subtasks ? task.subtasks.filter(s => s.status === 'done').length : 0;
                const subtasksTotal = task.subtasks ? task.subtasks.length : 0;

                return (
                  <div key={task.id} className={`p-3 rounded-lg border transition-colors ${isOverdue ? 'border-danger/30 bg-danger/5' : 'border-border hover:border-primary/20'}`}>
                    <div className="flex items-start gap-2.5">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary mb-1">{task.title}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Status dropdown */}
                          <div className="relative group/status">
                            <span className="status-pill text-[10px] cursor-pointer" style={{ backgroundColor: statusCfg.bgColor }}>{statusCfg.label}</span>
                            <div className="hidden group-hover/status:block absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border border-border p-1 z-50 min-w-[120px]">
                              {Object.entries(STATUS_CONFIG).map(([k, c]) => (
                                <button key={k} onClick={() => handleStatusChange(task.id, k)}
                                  className="status-pill w-full mb-0.5 last:mb-0 text-[10px]" style={{ backgroundColor: c.bgColor }}>{c.label}</button>
                              ))}
                            </div>
                          </div>
                          {priorityCfg && (
                            <span className="status-pill text-[10px]" style={{ backgroundColor: priorityCfg.bgColor }}>{priorityCfg.label}</span>
                          )}
                          {task.board && (
                            <span className="text-[10px] text-text-tertiary bg-surface px-1.5 py-0.5 rounded">{task.board.name}</span>
                          )}
                          {task.dueDate && (
                            <span className={`text-[10px] ${isOverdue ? 'text-danger font-semibold' : 'text-text-tertiary'}`}>
                              Due: {task.dueDate.slice(0, 10)}
                            </span>
                          )}
                          {subtasksTotal > 0 && (
                            <span className="text-[10px] text-text-tertiary">{subtasksDone}/{subtasksTotal} subtasks</span>
                          )}
                        </div>
                      </div>

                      {/* Quick comment */}
                      <button onClick={() => setCommentTaskId(commentTaskId === task.id ? null : task.id)}
                        className="p-1 rounded hover:bg-surface text-text-tertiary hover:text-primary flex-shrink-0" title="Comment">
                        <MessageSquare size={14} />
                      </button>
                    </div>

                    {/* Inline comment form */}
                    {commentTaskId === task.id && (
                      <div className="mt-2 flex gap-2">
                        <input type="text" value={commentText} onChange={e => setCommentText(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleAddComment(task.id)}
                          placeholder="Write a comment..." className="flex-1 text-xs border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:border-primary" autoFocus />
                        <button onClick={() => handleAddComment(task.id)}
                          className="px-3 py-1.5 bg-primary text-white text-xs rounded-md hover:bg-primary-600 font-medium">Send</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
