import React, { useState, useEffect } from 'react';
import { Plus, Trash2, CheckCircle2, Circle, Clock, AlertCircle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import Avatar from '../common/Avatar';

const SUBTASK_STATUS = {
  not_started: { label: 'Not Started', color: '#c4c4c4', icon: Circle },
  working_on_it: { label: 'Working', color: '#fdab3d', icon: Clock },
  stuck: { label: 'Stuck', color: '#e2445c', icon: AlertCircle },
  done: { label: 'Done', color: '#00c875', icon: CheckCircle2 },
};

export default function SubtaskList({ taskId, members = [], onSubtaskCountChange }) {
  const { user, canManage } = useAuth();
  const [subtasks, setSubtasks] = useState([]);
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [showStatusDrop, setShowStatusDrop] = useState(null);

  useEffect(() => {
    if (taskId) loadSubtasks();
  }, [taskId]);

  async function loadSubtasks() {
    try {
      const res = await api.get(`/subtasks?taskId=${taskId}`);
      const list = res.data.subtasks || res.data || [];
      setSubtasks(list);
      if (onSubtaskCountChange) {
        onSubtaskCountChange({ total: list.length, done: list.filter(s => s.status === 'done').length });
      }
    } catch (err) {
      console.error('Failed to load subtasks:', err);
    }
  }

  async function handleAdd() {
    if (!newTitle.trim()) return;
    try {
      const res = await api.post('/subtasks', { title: newTitle.trim(), taskId });
      const created = res.data.subtask || res.data;
      const updated = [...subtasks, created];
      setSubtasks(updated);
      setNewTitle('');
      setAdding(false);
      if (onSubtaskCountChange) {
        onSubtaskCountChange({ total: updated.length, done: updated.filter(s => s.status === 'done').length });
      }
    } catch (err) {
      console.error('Failed to create subtask:', err);
    }
  }

  async function handleStatusChange(subtaskId, newStatus) {
    try {
      const res = await api.put(`/subtasks/${subtaskId}`, { status: newStatus });
      const updatedSubtask = res.data.subtask || res.data;
      const updated = subtasks.map(s => s.id === subtaskId ? { ...s, ...updatedSubtask } : s);
      setSubtasks(updated);
      setShowStatusDrop(null);
      if (onSubtaskCountChange) {
        onSubtaskCountChange({ total: updated.length, done: updated.filter(s => s.status === 'done').length });
      }
    } catch (err) {
      console.error('Failed to update subtask:', err);
    }
  }

  async function handleDelete(subtaskId) {
    try {
      await api.delete(`/subtasks/${subtaskId}`);
      const updated = subtasks.filter(s => s.id !== subtaskId);
      setSubtasks(updated);
      if (onSubtaskCountChange) {
        onSubtaskCountChange({ total: updated.length, done: updated.filter(s => s.status === 'done').length });
      }
    } catch (err) {
      console.error('Failed to delete subtask:', err);
    }
  }

  const doneCount = subtasks.filter(s => s.status === 'done').length;
  const progress = subtasks.length > 0 ? Math.round((doneCount / subtasks.length) * 100) : 0;

  return (
    <div className="mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-text-primary">
          Subtasks {subtasks.length > 0 && <span className="text-text-tertiary font-normal">({doneCount}/{subtasks.length})</span>}
        </label>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark transition-colors"
          >
            <Plus size={14} /> Add subtask
          </button>
        )}
      </div>

      {/* Progress bar */}
      {subtasks.length > 0 && (
        <div className="w-full h-1.5 bg-gray-100 rounded-full mb-3 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{ width: `${progress}%`, backgroundColor: progress === 100 ? '#00c875' : '#0073ea' }}
          />
        </div>
      )}

      {/* Subtask list */}
      <div className="space-y-1">
        {subtasks.map(sub => {
          const cfg = SUBTASK_STATUS[sub.status] || SUBTASK_STATUS.not_started;
          const Icon = cfg.icon;
          const assigneeName = sub.assignee?.name;

          return (
            <div key={sub.id} className="flex items-center gap-2 group px-2 py-1.5 rounded-md hover:bg-surface/50 transition-colors">
              {/* Status icon / toggle */}
              <div className="relative">
                <button
                  onClick={() => setShowStatusDrop(showStatusDrop === sub.id ? null : sub.id)}
                  className="flex items-center justify-center w-5 h-5"
                  title={cfg.label}
                >
                  <Icon size={16} style={{ color: cfg.color }} />
                </button>
                {showStatusDrop === sub.id && (
                  <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border border-border p-1 z-50 min-w-[130px]">
                    {Object.entries(SUBTASK_STATUS).map(([k, c]) => {
                      const SIcon = c.icon;
                      return (
                        <button
                          key={k}
                          onClick={() => handleStatusChange(sub.id, k)}
                          className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-surface w-full rounded"
                        >
                          <SIcon size={14} style={{ color: c.color }} />
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Title */}
              <span className={`flex-1 text-sm ${sub.status === 'done' ? 'line-through text-text-tertiary' : 'text-text-primary'}`}>
                {sub.title}
              </span>

              {/* Assignee avatar */}
              {assigneeName && (
                <Avatar name={assigneeName} size="xs" />
              )}

              {/* Delete button - only manager/admin */}
              {canManage && (
                <button
                  onClick={() => handleDelete(sub.id)}
                  className="p-0.5 rounded hover:bg-red-50 text-text-tertiary hover:text-danger opacity-0 group-hover:opacity-100 transition-all"
                  title="Delete subtask"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Add subtask input */}
      {adding && (
        <div className="flex items-center gap-2 mt-2">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') { setAdding(false); setNewTitle(''); } }}
            placeholder="Subtask title..."
            className="flex-1 text-sm border border-border rounded-md px-3 py-1.5 focus:outline-none focus:border-primary"
            autoFocus
          />
          <button onClick={handleAdd} className="px-3 py-1.5 bg-primary text-white text-xs rounded-md hover:bg-primary-dark transition-colors">
            Add
          </button>
          <button onClick={() => { setAdding(false); setNewTitle(''); }} className="px-2 py-1.5 text-xs text-text-secondary hover:text-text-primary">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
