import React, { useState, useEffect, useRef } from 'react';
import { X, Trash2, MessageSquare, Paperclip, Activity, Clock, Tag, Link2, Zap, Copy, Shield, HelpCircle, Calendar, Archive, Search, Eye, Users, Check, Lock, Settings, Plus, Pencil, ChevronDown, ChevronRight } from 'lucide-react';
import { format, parseISO, formatDistanceToNow } from 'date-fns';
import { useAuth } from '../../context/AuthContext';
import { STATUS_CONFIG, PRIORITY_CONFIG, DEFAULT_STATUSES, buildStatusLookup, getTaskStatuses, getBoardStatuses, STATUS_PRESET_COLORS } from '../../utils/constants';
import api from '../../services/api';
import Avatar from '../common/Avatar';
import TaskComments from './TaskComments';
import TaskFiles from './TaskFiles';
import SubtaskList from './SubtaskList';
import WorkLogSection from './WorkLogSection';
import ActivityFeed from './ActivityFeed';
import DependencyBadge from '../dependencies/DependencyBadge';
import DependencySelector from '../dependencies/DependencySelector';

import ApprovalSection from './ApprovalSection';
import WatcherSection from './WatcherSection';
import RecurrenceSection from './RecurrenceSection';
import DueDateExtensionModal from './DueDateExtensionModal';
import HelpRequestModal from './HelpRequestModal';
import ConflictWarning from './ConflictWarning';
import useGrammarCorrection from '../../hooks/useGrammarCorrection';
import GrammarSuggestion from '../common/GrammarSuggestion';
import useSocket from '../../hooks/useSocket';

export default function TaskModal({ task, boardId, members = [], boardStatuses, onClose, onUpdate, onDelete }) {
  const { user, canManage, isMember, isManager, isAdmin } = useAuth();
  const isApproved = task?.approvalStatus === 'approved';
  // Approved tasks are fully read-only for members. Admin/manager can still edit.
  const canEditAllFields = !isApproved && (isAdmin || (canManage && !!task?.creator && task.creator.role !== 'admin'));
  const canEditTitle = !isApproved && (canEditAllFields || (isMember && task?.assignedTo === user?.id));
  const isBlockedByDependency = !!task?.customFields?.blockedByDependency;
  const canEditStatus = !isApproved && !isBlockedByDependency;
  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [status, setStatus] = useState(task?.status || 'not_started');
  const [priority, setPriority] = useState(task?.priority || 'medium');
  const [assignee, setAssignee] = useState(task?.assignedTo || null);
  // Multi-assignee + supervisor state from task_assignees
  const taskAssignees = task?.taskAssignees || [];
  const [selectedAssignees, setSelectedAssignees] = useState(() => {
    const assigneeIds = taskAssignees.filter(ta => ta.role === 'assignee').map(ta => ta.userId || ta.user?.id);
    // Fallback to legacy assignedTo if no task_assignees
    if (assigneeIds.length === 0 && task?.assignedTo) return [typeof task.assignedTo === 'string' ? task.assignedTo : task.assignedTo?.id].filter(Boolean);
    return assigneeIds;
  });
  const [selectedSupervisors, setSelectedSupervisors] = useState(() => {
    return taskAssignees.filter(ta => ta.role === 'supervisor').map(ta => ta.userId || ta.user?.id);
  });
  const [showAssigneesPicker, setShowAssigneesPicker] = useState(false);
  const [showSupervisorsPicker, setShowSupervisorsPicker] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState('');
  const [supervisorSearch, setSupervisorSearch] = useState('');
  const [dueDate, setDueDate] = useState(task?.dueDate ? task.dueDate.slice(0, 10) : '');
  const [startDate, setStartDate] = useState(task?.startDate ? task.startDate.slice(0, 10) : '');
  const [tags, setTags] = useState(task?.tags || []);
  const [newTag, setNewTag] = useState('');
  const [comments, setComments] = useState([]);
  const [files, setFiles] = useState([]);
  const [activeTab, setActiveTab] = useState('comments');
  const [showStatusDrop, setShowStatusDrop] = useState(false);
  const [showPriorityDrop, setShowPriorityDrop] = useState(false);

  // Task-level status configuration
  const [taskStatusConfig, setTaskStatusConfig] = useState(task?.statusConfig || null);
  const [showStatusConfig, setShowStatusConfig] = useState(false);
  const [newStatusLabel, setNewStatusLabel] = useState('');
  const [newStatusColor, setNewStatusColor] = useState('#3b82f6');
  const [editingStatusKey, setEditingStatusKey] = useState(null);
  const [editStatusLabel, setEditStatusLabel] = useState('');

  const [showDepSelector, setShowDepSelector] = useState(false);
  const [depKey, setDepKey] = useState(0);
  const [showExtension, setShowExtension] = useState(false);
  const [showHelpRequest, setShowHelpRequest] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'error'
  const saveTimerRef = useRef(null);
  const [conflicts, setConflicts] = useState([]);
  const [showConflicts, setShowConflicts] = useState(false);
  const [isDependencyReceiver, setIsDependencyReceiver] = useState(false);
  const { checkGrammar: checkDescGrammar, suggestion: descGrammarSuggestion, isChecking: isCheckingDescGrammar, applySuggestion: applyDescGrammar, dismissSuggestion: dismissDescGrammar } = useGrammarCorrection();

  useEffect(() => {
    if (task?.id) {
      loadComments();
      loadFiles();
      loadDependencyRole();
    }
  }, [task?.id]);

  // Acknowledge "seen" when the assignee actually opens the task detail view.
  // The server enforces that only assignees can write this state and is
  // idempotent, so it's safe to call unconditionally. A 403 for non-assignees
  // (like the creator) is expected and silently ignored.
  useEffect(() => {
    if (!task?.id || !user?.id) return;
    api.post(`/tasks/${task.id}/receipt`, { event: 'seen' }).catch(() => { /* expected for non-assignees */ });
  }, [task?.id, user?.id]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Realtime: listen for new comments on this task
  useSocket('comment:created', (data) => {
    if (data?.taskId === task?.id) {
      setComments(prev => {
        // Prevent duplicates (from optimistic local add + server broadcast)
        if (prev.some(c => c.id === data.comment?.id)) return prev;
        return [data.comment, ...prev];
      });
    }
  });

  // Realtime: listen for deleted comments on this task
  useSocket('comment:deleted', (data) => {
    if (data?.taskId === task?.id) {
      setComments(prev => prev.filter(c => c.id !== data.commentId));
    }
  });

  async function loadComments() {
    try {
      const res = await api.get(`/comments?taskId=${task.id}`);
      setComments(res.data.comments || res.data || []);
    } catch {}
  }

  async function loadFiles() {
    try {
      const res = await api.get(`/files?taskId=${task.id}`);
      setFiles(res.data.files || res.data || []);
    } catch {}
  }

  async function loadDependencyRole() {
    try {
      const res = await api.get(`/tasks/${task.id}/dependencies`);
      const depData = res.data?.data || res.data;
      // "blocking" = tasks that depend on this task (this task is dependsOnTaskId)
      const blockingOthers = (depData.blocking || []).length > 0;
      setIsDependencyReceiver(blockingOthers);
    } catch {
      setIsDependencyReceiver(false);
    }
  }

  async function save(updates) {
    setSaveStatus('saving');
    try {
      await api.put(`/tasks/${task.id}`, updates);
      if (onUpdate) onUpdate({ ...task, ...updates });
      setSaveStatus('saved');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      console.error('Failed to update task:', err);
      const msg = err.response?.data?.message;
      setSaveStatus('error');
      // If blocked by dependency, revert status to 'stuck'
      if (msg && msg.includes('blocked by')) {
        setStatus('stuck');
      }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus(null), 3000);
    }
  }

  function handleTitleBlur() {
    if (!title.trim()) { setTitle(task.title); return; } // Prevent empty titles
    if (title !== task.title) save({ title });
  }
  function handleDescBlur() { if (description !== task.description) save({ description }); }
  async function handleStatusChange(val) {
    setStatus(val);
    setShowStatusDrop(false);
    // Auto-fill startDate locally when moving to an active status (mirrors backend logic)
    const ACTIVE_STATUSES = ['working_on_it', 'stuck', 'review', 'done'];
    if (ACTIVE_STATUSES.includes(val) && !startDate) {
      const today = new Date().toISOString().slice(0, 10);
      setStartDate(today);
    }
    save({ status: val });
  }
  function handlePriorityChange(val) { setPriority(val); setShowPriorityDrop(false); save({ priority: val }); }
  async function saveTaskMembers(assignees, supervisors) {
    setSaveStatus('saving');
    try {
      await api.put(`/tasks/${task.id}/members`, { assignees, supervisors });
      if (onUpdate) onUpdate({ ...task, assignedTo: assignees[0] || null });
      setSaveStatus('saved');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      console.error('Failed to update task members:', err);
      setSaveStatus('error');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus(null), 3000);
    }
  }

  function toggleAssignee(uid) {
    setSelectedAssignees(prev => {
      const next = prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid];
      saveTaskMembers(next, selectedSupervisors);
      return next;
    });
  }

  function toggleSupervisor(uid) {
    setSelectedSupervisors(prev => {
      const next = prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid];
      saveTaskMembers(selectedAssignees, next);
      return next;
    });
  }

  function handleDateChange(field, val) {
    if (field === 'dueDate') {
      setDueDate(val);
      save({ dueDate: val || null });
      // Check for scheduling conflicts when due date changes
      if (val && (assignee || task?.assignedTo)) {
        const userId = assignee || task?.assignedTo;
        const startTime = new Date(val);
        const endTime = new Date(startTime.getTime() + (task?.estimatedHours || 1) * 60 * 60 * 1000);
        api.post('/tasks/check-conflicts', {
          userId,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          excludeTaskId: task?.id,
        }, { _silent: true }).then(res => {
          const data = res.data || res;
          if (data.hasConflicts) {
            setConflicts(data.conflicts);
            setShowConflicts(true);
          } else {
            setConflicts([]);
            setShowConflicts(false);
          }
        }).catch(() => {
          setConflicts([]);
          setShowConflicts(false);
        });
      }
    } else {
      setStartDate(val);
      save({ startDate: val || null });
    }
  }

  function handleAddTag(e) {
    if (e.key === 'Enter' && newTag.trim()) {
      const updated = [...tags, newTag.trim()];
      setTags(updated); setNewTag(''); save({ tags: updated });
    }
  }

  function removeTag(idx) { const updated = tags.filter((_, i) => i !== idx); setTags(updated); save({ tags: updated }); }

  async function handleAddComment(text) {
    const res = await api.post('/comments', { taskId: task.id, content: text });
    const newComment = res.data.comment || res.data;
    setComments(prev => {
      // Prevent duplicate if socket already added this comment
      if (newComment?.id && prev.some(c => c.id === newComment.id)) return prev;
      return [newComment, ...prev];
    });
  }

  async function handleDeleteComment(id) { await api.delete(`/comments/${id}`); setComments(prev => prev.filter(c => c.id !== id)); }

  async function handleUploadFile(file) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('taskId', task.id);
      const res = await api.post('/files', formData);
      setFiles(prev => [...prev, res.data.file || res.data.data?.file || res.data]);
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to upload file.';
      alert(msg);
    }
  }

  async function handleDeleteFile(id) {
    try {
      await api.delete(`/files/${id}`);
      setFiles(prev => prev.filter(f => f.id !== id));
    } catch (err) {
      console.error('Failed to delete file:', err);
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this task?')) return;
    try { await api.delete(`/tasks/${task.id}`); if (onDelete) onDelete(task.id); onClose(); }
    catch (err) { console.error('Failed to delete:', err); }
  }

  async function handleDuplicate() {
    try {
      const res = await api.post(`/tasks/${task.id}/duplicate`, { includeSubtasks: true });
      const newTask = res.data?.task || res.data?.data?.task;
      if (onUpdate && newTask) onUpdate(newTask);
      onClose();
    } catch (err) { console.error('Failed to duplicate:', err); }
  }

  // Resolve statuses: task-level → board-level → global defaults
  const activeStatuses = (taskStatusConfig && Array.isArray(taskStatusConfig) && taskStatusConfig.length > 0)
    ? taskStatusConfig
    : (boardStatuses && boardStatuses.length > 0 ? boardStatuses : DEFAULT_STATUSES);
  const statusLookup = buildStatusLookup(activeStatuses);
  const statusCfg = statusLookup[status] || STATUS_CONFIG[status] || { label: status || 'Unknown', color: '#c4c4c4', bgColor: '#c4c4c4', textColor: '#fff' };
  // The full palette for the status config editor (board-level or defaults)
  const availableStatusPalette = boardStatuses && boardStatuses.length > 0 ? boardStatuses : DEFAULT_STATUSES;
  const priorityCfg = PRIORITY_CONFIG[priority];
  const isMyTask = task?.assignedTo === user?.id || selectedAssignees.includes(user?.id);
  // Start date editable for the dependency SETTER side (the task that added the dependency, even if blocked).
  // NOT editable for the dependency RECEIVER side (the task others depend on — isDependencyReceiver).
  const canEditStartDate = !isApproved && !isDependencyReceiver && (canEditAllFields || isMyTask);

  const tabs = [
    { id: 'comments', label: 'Comments', icon: MessageSquare, count: comments.length },
    { id: 'files', label: 'Files', icon: Paperclip, count: files.length },
    { id: 'updates', label: 'Updates', icon: Clock },
    { id: 'activity', label: 'Activity', icon: Activity },
  ];

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1" />
      <div className="w-full max-w-[600px] bg-white shadow-2xl h-full flex flex-col animate-slide-in-right" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-secondary">Task</span>
            {saveStatus === 'saving' && <span className="text-[10px] text-blue-500 font-medium animate-pulse">Saving...</span>}
            {saveStatus === 'saved' && <span className="text-[10px] text-green-500 font-medium">Saved</span>}
            {saveStatus === 'error' && <span className="text-[10px] text-red-500 font-medium">Save failed</span>}
            {task?.autoAssigned && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-purple/10 text-purple">
                <Zap size={9} /> Auto-assigned
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowHelpRequest(true)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/10 transition-colors" title="Request help">
              <HelpCircle size={13} /> Help
            </button>
            {task?.dueDate && (
              <button onClick={() => setShowExtension(true)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-colors" title="Request due date extension">
                <Calendar size={13} /> Extend
              </button>
            )}
            <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface text-text-secondary"><X size={18} /></button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* Title */}
          {canEditTitle ? (
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={handleTitleBlur}
              className="text-xl font-bold text-text-primary border-none outline-none w-full mb-4 placeholder:text-text-tertiary" placeholder="Task title" />
          ) : (
            <h2 className="text-xl font-bold text-text-primary mb-4">{title}</h2>
          )}

          {/* Watcher + Approval + Recurrence */}
          <WatcherSection taskId={task?.id} />
          <ApprovalSection task={task} onUpdate={(updated) => { if (onUpdate) onUpdate({ ...task, ...updated }); }} />
          <RecurrenceSection taskId={task?.id} recurrence={task?.recurrence} onUpdate={(updated) => { if (onUpdate) onUpdate({ ...task, ...updated }); }} />

          {/* Approval Status Badge */}
          {task?.approvalStatus && (
            <div className={`mb-3 px-3 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 ${
              task.approvalStatus === 'approved' ? 'bg-green-50 text-green-700 border border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800' :
              task.approvalStatus === 'pending_approval' ? 'bg-yellow-50 text-yellow-700 border border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-400 dark:border-yellow-800' :
              'bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800'
            }`}>
              <Shield size={11} />
              {task.approvalStatus === 'approved' ? 'Approved' :
               task.approvalStatus === 'pending_approval' ? 'Pending Approval' : 'Changes Requested'}
            </div>
          )}

          {/* Dependency Badge + Add button */}
          <DependencyBadge key={depKey} taskId={task?.id} boardId={boardId || task?.boardId} onRefresh={async () => {
            setDepKey(k => k + 1);
            // Refresh task data since dependency removal may unblock the task
            try {
              const res = await api.get(`/tasks/${task.id}`);
              const updated = res.data?.data?.task || res.data?.task || res.data;
              if (updated) {
                setStatus(updated.status || status);
                if (onUpdate) onUpdate(updated);
              }
            } catch {}
            // Refresh dependency role (task may no longer be a receiver after removal)
            loadDependencyRole();
          }} />
          <button onClick={() => setShowDepSelector(true)}
            className="flex items-center gap-1.5 text-xs font-medium text-primary hover:bg-primary/5 px-2.5 py-1.5 rounded-md transition-colors mb-3">
            <Link2 size={13} /> Add Dependency
          </button>

          {/* Fields Grid */}
          <div className="grid grid-cols-[100px_1fr] gap-y-3 gap-x-4 mb-6">
            {/* Status */}
            <span className="text-sm text-text-secondary flex items-center">Status</span>
            <div className="relative">
              {isApproved && <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-green-100 text-green-700 border border-green-200 mr-2">Approved</span>}
              {isBlockedByDependency && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-red-50 text-red-600 border border-red-200 mr-2">
                  <Lock size={10} /> Blocked by dependency
                </span>
              )}
              <button onClick={() => canEditStatus && setShowStatusDrop(!showStatusDrop)} className={`status-pill ${(!canEditStatus) ? 'opacity-60 cursor-not-allowed' : ''}`} style={{ backgroundColor: statusCfg.bgColor }}
                title={isBlockedByDependency ? 'Blocked by dependency — complete the blocking task first' : ''}>
                {isBlockedByDependency && <Lock size={10} className="inline mr-1" />}{statusCfg.label}
              </button>
              {showStatusDrop && canEditStatus && (
                <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border border-border p-1.5 z-50 min-w-[140px] dropdown-enter">
                  {activeStatuses.map(s => {
                    const sCfg = statusLookup[s.key] || { label: s.label, bgColor: s.color };
                    return (
                      <button key={s.key} onClick={() => handleStatusChange(s.key)} className="status-pill w-full mb-1 last:mb-0" style={{ backgroundColor: sCfg.bgColor }}>{sCfg.label}</button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Priority */}
            <span className="text-sm text-text-secondary flex items-center">Priority</span>
            <div className="relative">
              {canEditAllFields ? (
                <>
                  <button onClick={() => setShowPriorityDrop(!showPriorityDrop)} className="status-pill" style={{ backgroundColor: priorityCfg ? priorityCfg.bgColor : '#c4c4c4' }}>
                    {priorityCfg ? priorityCfg.label : 'None'}
                  </button>
                  {showPriorityDrop && (
                    <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border border-border p-1.5 z-50 min-w-[130px] dropdown-enter">
                      {Object.entries(PRIORITY_CONFIG).map(([k, c]) => (
                        <button key={k} onClick={() => handlePriorityChange(k)} className="status-pill w-full mb-1 last:mb-0" style={{ backgroundColor: c.bgColor }}>{c.label}</button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <span className="status-pill" style={{ backgroundColor: priorityCfg ? priorityCfg.bgColor : '#c4c4c4' }}>{priorityCfg ? priorityCfg.label : 'None'}</span>
              )}
            </div>

            {/* Assignees (multi-select) */}
            <span className="text-sm text-text-secondary flex items-center gap-1"><Users size={14} /> Assign To</span>
            <div className="relative">
              {canEditAllFields ? (
                <>
                  <button onClick={() => { setShowAssigneesPicker(!showAssigneesPicker); setShowSupervisorsPicker(false); setAssigneeSearch(''); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border hover:border-primary/30 transition-colors flex-wrap min-h-[34px]">
                    {selectedAssignees.length > 0 ? (
                      selectedAssignees.map(uid => {
                        const m = members.find(mm => (mm.id || mm.user?.id) === uid);
                        const n = m?.name || m?.user?.name || 'Unknown';
                        return (
                          <span key={uid} className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs px-2 py-0.5 rounded-full">
                            <Avatar name={n} size="xs" />
                            <span className="max-w-[80px] truncate">{n}</span>
                            <button onClick={(e) => { e.stopPropagation(); toggleAssignee(uid); }} className="hover:text-danger"><X size={10} /></button>
                          </span>
                        );
                      })
                    ) : (
                      <span className="text-sm text-text-tertiary">Select assignees...</span>
                    )}
                  </button>
                  {showAssigneesPicker && (
                    <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border border-border z-50 min-w-[240px] max-h-[260px] overflow-hidden dropdown-enter">
                      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                        <Search size={13} className="text-text-tertiary" />
                        <input type="text" value={assigneeSearch} onChange={e => setAssigneeSearch(e.target.value)}
                          placeholder="Search people..." className="bg-transparent border-none outline-none text-xs w-full" onClick={e => e.stopPropagation()} autoFocus />
                      </div>
                      <div className="max-h-[200px] overflow-y-auto py-1">
                        {members.filter(m => (m.name || m.user?.name || '').toLowerCase().includes(assigneeSearch.toLowerCase())).map(m => {
                          const mId = m.id || m.user?.id;
                          const mName = m.name || m.user?.name || 'Unknown';
                          const isChecked = selectedAssignees.includes(mId);
                          return (
                            <button key={mId} onClick={(e) => { e.stopPropagation(); toggleAssignee(mId); }}
                              className={`flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-50 w-full transition-colors ${isChecked ? 'bg-primary/5' : ''}`}>
                              <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${isChecked ? 'bg-primary border-primary' : 'border-[#c4c4c4]'}`}>
                                {isChecked && <Check size={10} className="text-white" />}
                              </div>
                              <Avatar name={mName} size="xs" />
                              <span className="truncate text-text-primary">{mName}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-1.5 px-3 py-1.5 flex-wrap">
                  {selectedAssignees.length > 0 ? selectedAssignees.map(uid => {
                    const m = members.find(mm => (mm.id || mm.user?.id) === uid);
                    const n = m?.name || m?.user?.name || 'Unknown';
                    return <span key={uid} className="inline-flex items-center gap-1 text-xs"><Avatar name={n} size="xs" /><span>{n}</span></span>;
                  }) : <span className="text-sm text-text-tertiary">Unassigned</span>}
                </div>
              )}
            </div>

            {/* Supervisors (multi-select) */}
            <span className="text-sm text-text-secondary flex items-center gap-1"><Eye size={14} /> Supervisors</span>
            <div className="relative">
              {canEditAllFields ? (
                <>
                  <button onClick={() => { setShowSupervisorsPicker(!showSupervisorsPicker); setShowAssigneesPicker(false); setSupervisorSearch(''); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border hover:border-primary/30 transition-colors flex-wrap min-h-[34px]">
                    {selectedSupervisors.length > 0 ? (
                      selectedSupervisors.map(uid => {
                        const m = members.find(mm => (mm.id || mm.user?.id) === uid);
                        const n = m?.name || m?.user?.name || 'Unknown';
                        return (
                          <span key={uid} className="inline-flex items-center gap-1 bg-yellow-100 text-yellow-700 text-xs px-2 py-0.5 rounded-full">
                            <Avatar name={n} size="xs" />
                            <span className="max-w-[80px] truncate">{n}</span>
                            <button onClick={(e) => { e.stopPropagation(); toggleSupervisor(uid); }} className="hover:text-danger"><X size={10} /></button>
                          </span>
                        );
                      })
                    ) : (
                      <span className="text-sm text-text-tertiary">No supervisors</span>
                    )}
                  </button>
                  {showSupervisorsPicker && (
                    <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border border-border z-50 min-w-[240px] max-h-[260px] overflow-hidden dropdown-enter">
                      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                        <Search size={13} className="text-text-tertiary" />
                        <input type="text" value={supervisorSearch} onChange={e => setSupervisorSearch(e.target.value)}
                          placeholder="Search people..." className="bg-transparent border-none outline-none text-xs w-full" onClick={e => e.stopPropagation()} autoFocus />
                      </div>
                      <div className="max-h-[200px] overflow-y-auto py-1">
                        {members.filter(m => (m.name || m.user?.name || '').toLowerCase().includes(supervisorSearch.toLowerCase())).map(m => {
                          const mId = m.id || m.user?.id;
                          const mName = m.name || m.user?.name || 'Unknown';
                          const isChecked = selectedSupervisors.includes(mId);
                          return (
                            <button key={mId} onClick={(e) => { e.stopPropagation(); toggleSupervisor(mId); }}
                              className={`flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-50 w-full transition-colors ${isChecked ? 'bg-yellow-50' : ''}`}>
                              <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${isChecked ? 'bg-yellow-500 border-yellow-500' : 'border-[#c4c4c4]'}`}>
                                {isChecked && <Check size={10} className="text-white" />}
                              </div>
                              <Avatar name={mName} size="xs" />
                              <span className="truncate text-text-primary">{mName}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-1.5 px-3 py-1.5 flex-wrap">
                  {selectedSupervisors.length > 0 ? selectedSupervisors.map(uid => {
                    const m = members.find(mm => (mm.id || mm.user?.id) === uid);
                    const n = m?.name || m?.user?.name || 'Unknown';
                    return <span key={uid} className="inline-flex items-center gap-1 text-xs"><Avatar name={n} size="xs" /><span>{n}</span></span>;
                  }) : <span className="text-sm text-text-tertiary">None</span>}
                </div>
              )}
            </div>

            {/* Due Date */}
            <span className="text-sm text-text-secondary flex items-center">Due date</span>
            {canEditAllFields ? (
              <input type="date" value={dueDate} onChange={(e) => handleDateChange('dueDate', e.target.value)}
                className="text-sm px-3 py-1.5 border border-border rounded-md focus:outline-none focus:border-primary w-fit" />
            ) : (
              <span className="text-sm px-3 py-1.5">{dueDate || '—'}</span>
            )}

            {/* Conflict Warning */}
            {showConflicts && conflicts.length > 0 && (
              <>
                <span></span>
                <ConflictWarning
                  conflicts={conflicts}
                  taskId={task?.id}
                  dueDate={dueDate}
                  estimatedHours={task?.estimatedHours || 1}
                  onRescheduled={(result) => {
                    setConflicts(prev => prev.filter(c => c.taskId !== result.taskId));
                    if (conflicts.length <= 1) setShowConflicts(false);
                    if (onUpdate) onUpdate({ ...task });
                  }}
                  onDismiss={() => setShowConflicts(false)}
                />
              </>
            )}

            {/* Start Date — editable only for primary owner on non-blocked tasks */}
            <span className="text-sm text-text-secondary flex items-center">Start date</span>
            {canEditStartDate ? (
              <input type="date" value={startDate} onChange={(e) => handleDateChange('startDate', e.target.value)}
                className="text-sm px-3 py-1.5 border border-border rounded-md focus:outline-none focus:border-primary w-fit" />
            ) : (
              <span className="text-sm px-3 py-1.5">{startDate || '—'}</span>
            )}

            {/* Tags */}
            <span className="text-sm text-text-secondary flex items-center"><Tag size={14} className="mr-1" /> Tags</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {tags.map((tag, i) => (
                <span key={tag} className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs px-2 py-0.5 rounded-full">
                  {tag}
                  {canEditAllFields && <button onClick={() => removeTag(i)} className="hover:text-danger"><X size={10} /></button>}
                </span>
              ))}
              {canEditAllFields && (
                <input type="text" value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={handleAddTag}
                  placeholder="Add tag..." className="text-xs border-none outline-none bg-transparent min-w-[70px]" />
              )}
            </div>
          </div>

          {/* Task-Level Status Configuration — visible to creators/managers/admins */}
          {canEditAllFields && (
            <div className="mb-6 border border-border/60 rounded-lg overflow-hidden">
              <button
                onClick={() => setShowStatusConfig(!showStatusConfig)}
                className="flex items-center gap-2 w-full px-3 py-2.5 text-sm font-medium text-text-primary hover:bg-surface/40 transition-colors"
              >
                <Settings size={14} className="text-text-tertiary" />
                <span className="flex-1 text-left">Configure Task Statuses</span>
                {taskStatusConfig && taskStatusConfig.length > 0 && (
                  <span className="text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                    {taskStatusConfig.length} custom
                  </span>
                )}
                {showStatusConfig ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronRight size={14} className="text-text-tertiary" />}
              </button>

              {showStatusConfig && (
                <div className="px-3 pb-3 border-t border-border/40 space-y-2 pt-2">
                  <p className="text-[11px] text-text-tertiary mb-2">
                    Select which statuses are available for this task. Members will only see these options. Leave empty to use board defaults.
                  </p>

                  {/* Current task statuses */}
                  {(taskStatusConfig || []).map((s, i) => (
                    <div key={s.key} className="flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-surface/20 group/status">
                      <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                      {editingStatusKey === s.key ? (
                        <div className="flex items-center gap-1.5 flex-1">
                          <input
                            value={editStatusLabel}
                            onChange={e => setEditStatusLabel(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                if (!editStatusLabel.trim()) return;
                                const updated = (taskStatusConfig || []).map(st =>
                                  st.key === s.key ? { ...st, label: editStatusLabel.trim() } : st
                                );
                                setTaskStatusConfig(updated);
                                save({ statusConfig: updated });
                                setEditingStatusKey(null);
                              }
                            }}
                            className="flex-1 px-2 py-1 border border-primary rounded text-xs focus:outline-none"
                            autoFocus
                            onClick={e => e.stopPropagation()}
                          />
                          <button onClick={() => {
                            if (!editStatusLabel.trim()) return;
                            const updated = (taskStatusConfig || []).map(st =>
                              st.key === s.key ? { ...st, label: editStatusLabel.trim() } : st
                            );
                            setTaskStatusConfig(updated);
                            save({ statusConfig: updated });
                            setEditingStatusKey(null);
                          }} className="p-0.5 text-green-600 hover:bg-green-50 rounded"><Check size={12} /></button>
                          <button onClick={() => setEditingStatusKey(null)} className="p-0.5 text-text-tertiary hover:bg-surface rounded"><X size={12} /></button>
                        </div>
                      ) : (
                        <>
                          <span className="text-xs font-medium text-text-primary flex-1">{s.label}</span>
                          <div className="flex items-center gap-0.5 opacity-0 group-hover/status:opacity-100 transition-opacity">
                            {STATUS_PRESET_COLORS.slice(0, 6).map(c => (
                              <button key={c} onClick={() => {
                                const updated = (taskStatusConfig || []).map(st =>
                                  st.key === s.key ? { ...st, color: c } : st
                                );
                                setTaskStatusConfig(updated);
                                save({ statusConfig: updated });
                              }}
                                className={`w-3 h-3 rounded-full transition-all ${s.color === c ? 'ring-1 ring-offset-1 ring-primary' : 'hover:scale-110'}`}
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </div>
                          <button onClick={() => { setEditingStatusKey(s.key); setEditStatusLabel(s.label); }}
                            className="p-0.5 text-text-tertiary hover:text-primary opacity-0 group-hover/status:opacity-100 transition-opacity rounded">
                            <Pencil size={11} />
                          </button>
                          <button onClick={() => {
                            const updated = (taskStatusConfig || []).filter(st => st.key !== s.key);
                            const result = updated.length > 0 ? updated : null;
                            setTaskStatusConfig(result);
                            save({ statusConfig: result });
                          }}
                            className="p-0.5 text-text-tertiary hover:text-red-500 opacity-0 group-hover/status:opacity-100 transition-opacity rounded">
                            <X size={11} />
                          </button>
                        </>
                      )}
                    </div>
                  ))}

                  {/* Quick-add from available palette (board or defaults) */}
                  <div className="pt-1">
                    <p className="text-[10px] text-text-tertiary mb-1.5 font-medium uppercase tracking-wider">Add from available statuses</p>
                    <div className="flex flex-wrap gap-1">
                      {availableStatusPalette
                        .filter(s => !(taskStatusConfig || []).some(ts => ts.key === s.key))
                        .map(s => (
                          <button key={s.key} onClick={() => {
                            const updated = [...(taskStatusConfig || []), { key: s.key, label: s.label, color: s.color }];
                            setTaskStatusConfig(updated);
                            save({ statusConfig: updated });
                          }}
                            className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border/60 hover:border-primary/40 hover:bg-primary/5 transition-colors"
                          >
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                            {s.label}
                            <Plus size={10} className="text-text-tertiary" />
                          </button>
                        ))
                      }
                    </div>
                  </div>

                  {/* Add custom status */}
                  <div className="pt-1 border-t border-border/30">
                    <p className="text-[10px] text-text-tertiary mb-1.5 font-medium uppercase tracking-wider">Or create custom</p>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={newStatusLabel}
                        onChange={e => setNewStatusLabel(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && newStatusLabel.trim()) {
                            const key = newStatusLabel.trim().toLowerCase().replace(/\s+/g, '_');
                            if ((taskStatusConfig || []).some(s => s.key === key)) return;
                            const updated = [...(taskStatusConfig || []), { key, label: newStatusLabel.trim(), color: newStatusColor }];
                            setTaskStatusConfig(updated);
                            save({ statusConfig: updated });
                            setNewStatusLabel('');
                          }
                        }}
                        placeholder="Custom status name..."
                        className="flex-1 px-2 py-1.5 border border-border rounded-md text-xs focus:outline-none focus:border-primary"
                        onClick={e => e.stopPropagation()}
                      />
                      <div className="flex gap-0.5">
                        {STATUS_PRESET_COLORS.slice(0, 6).map(c => (
                          <button key={c} onClick={() => setNewStatusColor(c)}
                            className={`w-4 h-4 rounded-full transition-all ${newStatusColor === c ? 'ring-2 ring-offset-1 ring-primary scale-110' : 'hover:scale-105'}`}
                            style={{ backgroundColor: c }} />
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          if (!newStatusLabel.trim()) return;
                          const key = newStatusLabel.trim().toLowerCase().replace(/\s+/g, '_');
                          if ((taskStatusConfig || []).some(s => s.key === key)) return;
                          const updated = [...(taskStatusConfig || []), { key, label: newStatusLabel.trim(), color: newStatusColor }];
                          setTaskStatusConfig(updated);
                          save({ statusConfig: updated });
                          setNewStatusLabel('');
                        }}
                        disabled={!newStatusLabel.trim()}
                        className="px-2.5 py-1.5 text-[11px] font-medium bg-primary text-white rounded-md hover:bg-primary-dark transition-colors disabled:opacity-40"
                      >
                        Add
                      </button>
                    </div>
                  </div>

                  {/* Reset to defaults */}
                  {taskStatusConfig && taskStatusConfig.length > 0 && (
                    <button
                      onClick={() => { setTaskStatusConfig(null); save({ statusConfig: null }); }}
                      className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors mt-1"
                    >
                      Clear task statuses (use board defaults)
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Description */}
          <div className="mb-6">
            <label className="text-sm font-medium text-text-primary mb-1.5 block">Description</label>
            {canEditAllFields ? (
              <>
                <textarea value={description} onChange={(e) => { setDescription(e.target.value); checkDescGrammar(e.target.value); }} onBlur={handleDescBlur}
                  placeholder="Add a description..." className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:border-primary resize-none min-h-[80px]" />
                <GrammarSuggestion
                  suggestion={descGrammarSuggestion}
                  isChecking={isCheckingDescGrammar}
                  onApply={() => { const corrected = applyDescGrammar(); if (corrected) { setDescription(corrected); save({ description: corrected }); } }}
                  onDismiss={dismissDescGrammar}
                />
              </>
            ) : (
              <p className="text-sm text-text-secondary px-3 py-2 border border-border rounded-lg min-h-[80px] bg-surface/30">{description || 'No description'}</p>
            )}
          </div>

          {/* Subtasks */}
          <SubtaskList taskId={task.id} members={members} onSubtaskCountChange={(counts) => {
            if (onUpdate) onUpdate({ ...task, _subtaskCounts: counts });
          }} />

          {/* Tabs */}
          <div className="flex items-center gap-5 border-b border-border mb-4">
            {tabs.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)}
                className={`flex items-center gap-1.5 pb-2.5 text-sm font-medium border-b-2 transition-colors ${activeTab === t.id ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
                <t.icon size={14} />
                {t.label}{t.count !== undefined && ` (${t.count})`}
              </button>
            ))}
          </div>

          {activeTab === 'comments' && <TaskComments comments={comments} onAdd={handleAddComment} onDelete={handleDeleteComment} />}
          {activeTab === 'files' && <TaskFiles files={files} onUpload={handleUploadFile} onDelete={handleDeleteFile} />}
          {activeTab === 'updates' && <WorkLogSection taskId={task.id} />}
          {activeTab === 'activity' && <ActivityFeed taskId={task.id} />}
        </div>
      </div>

      {/* Dependency Selector */}
      {showDepSelector && (
        <DependencySelector
          taskId={task.id}
          taskTitle={task.title}
          boardId={boardId || task.boardId}
          onClose={() => setShowDepSelector(false)}
          onCreated={async () => {
            setDepKey(k => k + 1);
            // Refresh task data since dependency creation may have changed status to 'stuck' and auto-set startDate
            try {
              const res = await api.get(`/tasks/${task.id}`);
              const updated = res.data?.data?.task || res.data?.task || res.data;
              if (updated) {
                setStatus(updated.status || status);
                if (updated.startDate) setStartDate(updated.startDate.slice(0, 10));
                if (onUpdate) onUpdate(updated);
              }
            } catch {}
            // Refresh dependency role (this task may now be a receiver)
            loadDependencyRole();
          }}
        />
      )}

      {/* Due Date Extension */}
      {showExtension && (
        <DueDateExtensionModal task={task} onClose={() => setShowExtension(false)} onUpdated={() => { if (onUpdate) onUpdate({ ...task }); }} />
      )}

      {/* Help Request */}
      {showHelpRequest && (
        <HelpRequestModal task={task} onClose={() => setShowHelpRequest(false)} />
      )}
    </div>
  );
}
