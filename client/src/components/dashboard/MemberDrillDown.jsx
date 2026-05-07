import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, CheckCircle2, Clock, AlertTriangle, ListChecks, MessageSquare } from 'lucide-react';
import api from '../../services/api';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../../utils/constants';
import Avatar from '../common/Avatar';
import DetailModalShell from '../common/DetailModalShell';
import { resolveTier, tierLabel } from '../../utils/tiers';

export default function MemberDrillDown({ userId, boardId, onClose }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('all');
  const [commentTaskId, setCommentTaskId] = useState(null);
  const [commentText, setCommentText] = useState('');
  // Ref the shell populates with its animated `requestClose` so the X button
  // plays the slide-down exit before the parent unmounts us — same pattern
  // used by the Board's TaskModal.
  const shellCloseRef = useRef(null);
  const handleClose = () => (shellCloseRef.current ? shellCloseRef.current() : onClose());

  useEffect(() => {
    loadMemberData();
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
      <DetailModalShell onClose={onClose} closeRef={shellCloseRef} ariaLabel="Member tasks" size="sheet" placement="bottom-sheet">
        <div className="flex items-center justify-center min-h-[260px]">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" />
        </div>
      </DetailModalShell>
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

  const memberTitleId = `member-drilldown-title-${userId}`;

  // Navigate to a task by jumping to its board with ?taskId=... — BoardPage
  // consumes that param and opens the TaskModal (matches RecurringWorkPage).
  const openTask = (task) => {
    const targetBoardId = task.boardId || task.board?.id;
    if (!targetBoardId) return;
    handleClose();
    navigate(`/boards/${targetBoardId}?taskId=${task.id}`);
  };

  return (
    <DetailModalShell onClose={onClose} closeRef={shellCloseRef} ariaLabelledBy={memberTitleId} size="sheet" placement="bottom-sheet">
        {/* Header — compact two-row band: profile, stat boxes, progress */}
        <div className="px-4 pt-3 pb-2.5 border-b border-border flex-shrink-0">
          {/* Row 1: profile */}
          <div className="flex items-center gap-3">
            <Avatar name={member.name} size="md" />
            <div className="min-w-0 flex-1">
              <h2 id={memberTitleId} className="text-base font-bold text-text-primary leading-tight truncate">{member.name}</h2>
              <p className="text-[11px] text-text-tertiary leading-tight truncate">
                {member.designation || tierLabel(resolveTier(member))}{member.department ? ` · ${member.department}` : ''}{member.email ? ` · ${member.email}` : ''}
              </p>
            </div>
            <button onClick={handleClose} aria-label="Close member details" className="p-1.5 rounded-md hover:bg-surface text-text-secondary flex-shrink-0"><X size={18} /></button>
          </div>

          {/* Row 2: compact stat boxes — 4 cols on desktop, wraps to 2 on narrow widths */}
          <div className="mt-2.5 grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'Total', value: summary.total, color: '#0073ea', icon: ListChecks },
              { label: 'Done', value: summary.done, color: '#00c875', icon: CheckCircle2 },
              { label: 'Working', value: summary.working, color: '#fdab3d', icon: Clock },
              { label: 'Stuck', value: summary.stuck, color: '#e2445c', icon: AlertTriangle },
            ].map(s => {
              const Icon = s.icon;
              return (
                <div key={s.label} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface/60 border border-border/50">
                  <Icon size={16} style={{ color: s.color }} className="flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-base font-bold leading-none" style={{ color: s.color }}>{s.value}</p>
                    <p className="text-[10px] text-text-tertiary uppercase tracking-wider mt-0.5">{s.label}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Row 3: progress bar */}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all" style={{ width: `${completionRate}%`, backgroundColor: completionRate === 100 ? '#00c875' : '#0073ea' }} />
            </div>
            <span className="text-[11px] font-semibold text-text-secondary">{completionRate}%</span>
          </div>
        </div>

        {/* Filter Chips */}
        <div className="px-4 py-1.5 border-b border-border flex items-center gap-1.5 overflow-x-auto flex-shrink-0">
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

        {/* Task List — 2-column responsive grid */}
        <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
          {filteredTasks.length === 0 ? (
            <div className="text-center py-12">
              <ListChecks size={36} className="mx-auto text-text-tertiary mb-2" />
              <p className="text-sm text-text-secondary">No tasks found</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
              {filteredTasks.map(task => {
                const statusCfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.not_started;
                const priorityCfg = PRIORITY_CONFIG[task.priority];
                const isOverdue = task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10) && task.status !== 'done';
                const subtasksDone = task.subtasks ? task.subtasks.filter(s => s.status === 'done').length : 0;
                const subtasksTotal = task.subtasks ? task.subtasks.length : 0;
                const canNavigate = !!(task.boardId || task.board?.id);

                // Assignment metadata — popup is filtered by assignedTo=userId
                // so the assignee is `member` for every row. `task.creator`
                // is supplied by the dashboardController include block.
                const creatorName = task.creator?.name || 'Unknown';
                return (
                  <div key={task.id} className={`p-2.5 rounded-lg border transition-colors ${isOverdue ? 'border-danger/30 bg-danger/5' : 'border-border hover:border-primary/30'}`}>
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        {/* Clickable title — opens TaskModal on its board */}
                        <button
                          type="button"
                          onClick={() => canNavigate && openTask(task)}
                          disabled={!canNavigate}
                          title={canNavigate ? 'Open task' : task.title}
                          className={`block w-full text-left text-sm font-medium text-text-primary mb-1 truncate ${
                            canNavigate ? 'cursor-pointer hover:text-primary hover:underline' : 'cursor-default'
                          }`}
                        >
                          {task.title}
                        </button>

                        {/* "Assigned by" only — the popup is already scoped to
                            `member`, so showing "To <member>" on every card is
                            redundant noise. Assignee chips are still rendered
                            in TaskModal and any non-user-scoped view. */}
                        <div className="flex items-center gap-1 flex-wrap text-[10px] text-text-tertiary mb-1.5">
                          <span>By</span>
                          <Avatar name={creatorName} size="xs" />
                          <span className="text-text-secondary font-medium truncate max-w-[160px]">{creatorName}</span>
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap">
                          {/* Status — compact chip with hover dropdown */}
                          <div className="relative group/status">
                            <span
                              className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium text-white cursor-pointer"
                              style={{ backgroundColor: statusCfg.bgColor }}
                            >
                              {statusCfg.label}
                            </span>
                            <div className="hidden group-hover/status:block absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border border-border p-1 z-50 min-w-[120px]">
                              {Object.entries(STATUS_CONFIG).map(([k, c]) => (
                                <button key={k} onClick={() => handleStatusChange(task.id, k)}
                                  className="block w-full mb-0.5 last:mb-0 px-2 py-1 rounded text-[11px] font-medium text-white text-left hover:brightness-110"
                                  style={{ backgroundColor: c.bgColor }}>{c.label}</button>
                              ))}
                            </div>
                          </div>

                          {/* Priority — compact badge (no full-width bar) */}
                          {priorityCfg && (
                            <span
                              className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium text-white"
                              style={{ backgroundColor: priorityCfg.bgColor }}
                            >
                              {priorityCfg.label}
                            </span>
                          )}

                          {task.board && (
                            <span className="text-[10px] text-text-tertiary bg-surface px-1.5 py-0.5 rounded truncate max-w-[100px]">{task.board.name}</span>
                          )}
                          {task.dueDate && (
                            <span className={`text-[10px] ${isOverdue ? 'text-danger font-semibold' : 'text-text-tertiary'}`}>
                              Due {task.dueDate.slice(0, 10)}
                            </span>
                          )}
                          {subtasksTotal > 0 && (
                            <span className="text-[10px] text-text-tertiary">{subtasksDone}/{subtasksTotal} sub</span>
                          )}
                        </div>
                      </div>

                      <button onClick={() => setCommentTaskId(commentTaskId === task.id ? null : task.id)}
                        className="p-1 rounded hover:bg-surface text-text-tertiary hover:text-primary flex-shrink-0" title="Comment">
                        <MessageSquare size={14} />
                      </button>
                    </div>

                    {commentTaskId === task.id && (
                      <div className="mt-2 flex gap-2">
                        <input type="text" value={commentText} onChange={e => setCommentText(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleAddComment(task.id)}
                          placeholder="Write a comment..." className="flex-1 text-xs border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:border-primary min-w-0" autoFocus />
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
    </DetailModalShell>
  );
}
