import React, { useState, useEffect, useRef } from 'react';
import { X, Trash2, MessageSquare, Paperclip, Activity, Clock, Tag, Send, Link2, Zap, Copy, Shield, HelpCircle, Calendar, Archive, Search, Eye, Users, Check } from 'lucide-react';
import { format, parseISO, formatDistanceToNow } from 'date-fns';
import { useAuth } from '../../context/AuthContext';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../../utils/constants';
import api from '../../services/api';
import Avatar from '../common/Avatar';
import TaskComments from './TaskComments';
import TaskFiles from './TaskFiles';
import SubtaskList from './SubtaskList';
import WorkLogSection from './WorkLogSection';
import ActivityFeed from './ActivityFeed';
import DependencyBadge from '../dependencies/DependencyBadge';
import DependencySelector from '../dependencies/DependencySelector';
import DelegateTaskModal from './DelegateTaskModal';
import ApprovalSection from './ApprovalSection';
import WatcherSection from './WatcherSection';
import RecurrenceSection from './RecurrenceSection';
import DueDateExtensionModal from './DueDateExtensionModal';
import HelpRequestModal from './HelpRequestModal';
import ConflictWarning from './ConflictWarning';
import useGrammarCorrection from '../../hooks/useGrammarCorrection';
import GrammarSuggestion from '../common/GrammarSuggestion';

export default function TaskModal({ task, boardId, members = [], onClose, onUpdate, onDelete }) {
  const { user, canManage, isMember, isManager, isAdmin } = useAuth();
  const isApproved = task?.approvalStatus === 'approved';
  // Approved tasks are fully read-only for members. Admin/manager can still edit.
  const canEditAllFields = !isApproved && (isAdmin || (canManage && !!task?.creator && task.creator.role !== 'admin'));
  const canEditTitle = !isApproved && (canEditAllFields || (isMember && task?.assignedTo === user?.id));
  const canEditStatus = !isApproved; // No one edits status on approved tasks (already done)
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
  const [showDelegate, setShowDelegate] = useState(false);
  const [showDepSelector, setShowDepSelector] = useState(false);
  const [depKey, setDepKey] = useState(0);
  const [showExtension, setShowExtension] = useState(false);
  const [showHelpRequest, setShowHelpRequest] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null); // null | 'saving' | 'saved' | 'error'
  const saveTimerRef = useRef(null);
  const [conflicts, setConflicts] = useState([]);
  const [showConflicts, setShowConflicts] = useState(false);
  const { checkGrammar: checkDescGrammar, suggestion: descGrammarSuggestion, isChecking: isCheckingDescGrammar, applySuggestion: applyDescGrammar, dismissSuggestion: dismissDescGrammar } = useGrammarCorrection();

  useEffect(() => {
    if (task?.id) {
      loadComments();
      loadFiles();
    }
  }, [task?.id]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

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
      setSaveStatus('error');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus(null), 3000);
    }
  }

  function handleTitleBlur() {
    if (!title.trim()) { setTitle(task.title); return; } // Prevent empty titles
    if (title !== task.title) save({ title });
  }
  function handleDescBlur() { if (description !== task.description) save({ description }); }
  function handleStatusChange(val) { setStatus(val); setShowStatusDrop(false); save({ status: val }); }
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
        }).then(res => {
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
    setComments(prev => [res.data.comment || res.data, ...prev]);
  }

  async function handleDeleteComment(id) { await api.delete(`/comments/${id}`); setComments(prev => prev.filter(c => c.id !== id)); }

  async function handleUploadFile(file) {
    const formData = new FormData();
    formData.append('file', file); formData.append('taskId', task.id);
    const res = await api.post('/files', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
    setFiles(prev => [...prev, res.data.file || res.data]);
  }

  async function handleDeleteFile(id) { await api.delete(`/files/${id}`); setFiles(prev => prev.filter(f => f.id !== id)); }

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

  const statusCfg = STATUS_CONFIG[status] || STATUS_CONFIG.not_started;
  const priorityCfg = PRIORITY_CONFIG[priority];
  const isMyTask = task?.assignedTo === user?.id || selectedAssignees.includes(user?.id);

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
            {/* Delegate button — visible to assignee */}
            {isMyTask && (
              <button onClick={() => setShowDelegate(true)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-primary hover:bg-primary/5 transition-colors" title="Delegate to teammate">
                <Send size={13} /> Delegate
              </button>
            )}
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
          <DependencyBadge key={depKey} taskId={task?.id} boardId={boardId || task?.boardId} onRefresh={() => setDepKey(k => k + 1)} />
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
              <button onClick={() => canEditStatus && setShowStatusDrop(!showStatusDrop)} className={`status-pill ${isApproved ? 'opacity-60 cursor-not-allowed' : ''}`} style={{ backgroundColor: statusCfg.bgColor }}>{statusCfg.label}</button>
              {showStatusDrop && (
                <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border border-border p-1.5 z-50 min-w-[140px] dropdown-enter">
                  {Object.entries(STATUS_CONFIG).map(([k, c]) => (
                    <button key={k} onClick={() => handleStatusChange(k)} className="status-pill w-full mb-1 last:mb-0" style={{ backgroundColor: c.bgColor }}>{c.label}</button>
                  ))}
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

            {/* Start Date */}
            <span className="text-sm text-text-secondary flex items-center">Start date</span>
            {canEditAllFields ? (
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
                  onApply={() => { const corrected = applyDescGrammar(); setDescription(corrected); save({ description: corrected }); }}
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

      {/* Delegate Modal */}
      {showDelegate && (
        <DelegateTaskModal
          task={task}
          onClose={() => setShowDelegate(false)}
          onDelegated={(newAssigneeId) => {
            setAssignee(newAssigneeId);
            if (onUpdate) onUpdate({ ...task, assignedTo: newAssigneeId });
          }}
        />
      )}

      {/* Dependency Selector */}
      {showDepSelector && (
        <DependencySelector
          taskId={task.id}
          taskTitle={task.title}
          boardId={boardId || task.boardId}
          onClose={() => setShowDepSelector(false)}
          onCreated={() => setDepKey(k => k + 1)}
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
