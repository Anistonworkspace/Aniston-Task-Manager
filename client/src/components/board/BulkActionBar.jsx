import React, { useState } from 'react';
import { X, CheckSquare, Archive, UserPlus, ArrowRight } from 'lucide-react';
import { STATUS_CONFIG, PRIORITY_CONFIG, DEFAULT_STATUSES, buildStatusLookup } from '../../utils/constants';
import api from '../../services/api';
import Avatar from '../common/Avatar';

export default function BulkActionBar({ selectedIds, members = [], boardStatuses, onDone, onClear }) {
  const [saving, setSaving] = useState(false);
  const count = selectedIds.length;

  async function bulkUpdate(updates) {
    setSaving(true);
    try {
      await api.put('/tasks/bulk', { taskIds: selectedIds, updates });
      onDone();
    } catch (err) { console.error('Bulk update failed:', err); }
    finally { setSaving(false); }
  }

  async function bulkDelete() {
    if (!confirm(`Delete ${count} task(s)? This cannot be undone.`)) return;
    setSaving(true);
    try {
      for (const id of selectedIds) { await api.delete(`/tasks/${id}`); }
      onDone();
    } catch (err) { console.error('Bulk delete failed:', err); }
    finally { setSaving(false); }
  }

  if (count === 0) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-zinc-900 text-white rounded-xl shadow-2xl px-5 py-3 flex items-center gap-4 animate-slide-in" style={{ animation: 'toastIn 0.2s ease-out' }}>
      <div className="flex items-center gap-2">
        <CheckSquare size={16} className="text-primary" />
        <span className="text-sm font-semibold">{count} selected</span>
      </div>

      <div className="w-px h-6 bg-zinc-700" />

      {/* Status */}
      <div className="relative group">
        <button className="text-xs px-2.5 py-1.5 rounded-md hover:bg-zinc-800 transition-colors">Status</button>
        <div className="absolute bottom-full left-0 mb-2 bg-white rounded-lg shadow-dropdown border border-border p-1.5 min-w-[130px] hidden group-hover:block">
          {(boardStatuses && boardStatuses.length > 0 ? boardStatuses : DEFAULT_STATUSES).map(s => {
            const cfg = buildStatusLookup([s])[s.key];
            return (
              <button key={s.key} onClick={() => bulkUpdate({ status: s.key })}
                className="status-pill w-full mb-1 last:mb-0 text-[11px]" style={{ backgroundColor: cfg.bgColor }}>{cfg.label}</button>
            );
          })}
        </div>
      </div>

      {/* Priority */}
      <div className="relative group">
        <button className="text-xs px-2.5 py-1.5 rounded-md hover:bg-zinc-800 transition-colors">Priority</button>
        <div className="absolute bottom-full left-0 mb-2 bg-white rounded-lg shadow-dropdown border border-border p-1.5 min-w-[120px] hidden group-hover:block">
          {Object.entries(PRIORITY_CONFIG).map(([k, c]) => (
            <button key={k} onClick={() => bulkUpdate({ priority: k })}
              className="status-pill w-full mb-1 last:mb-0 text-[11px]" style={{ backgroundColor: c.bgColor }}>{c.label}</button>
          ))}
        </div>
      </div>

      {/* Assign */}
      <div className="relative group">
        <button className="text-xs px-2.5 py-1.5 rounded-md hover:bg-zinc-800 transition-colors flex items-center gap-1"><UserPlus size={12} /> Assign</button>
        <div className="absolute bottom-full left-0 mb-2 bg-white rounded-lg shadow-dropdown border border-border py-1 min-w-[180px] max-h-[200px] overflow-y-auto hidden group-hover:block">
          {members.map(m => (
            <button key={m.id} onClick={() => bulkUpdate({ assignedTo: m.id })}
              className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-surface w-full text-text-primary">
              <Avatar name={m.name} size="xs" /> {m.name}
            </button>
          ))}
        </div>
      </div>

      {/* Archive */}
      <button onClick={() => bulkUpdate({ isArchived: true })} disabled={saving}
        className="text-xs px-2.5 py-1.5 rounded-md hover:bg-zinc-800 transition-colors flex items-center gap-1">
        <ArrowRight size={12} /> Archive
      </button>

      {/* Archive */}
      <button onClick={() => bulkUpdate({ isArchived: true })} disabled={saving}
        className="text-xs px-2.5 py-1.5 rounded-md hover:bg-yellow-900 text-yellow-400 transition-colors flex items-center gap-1">
        <Archive size={12} /> Archive
      </button>

      <div className="w-px h-6 bg-zinc-700" />

      <button onClick={onClear} className="text-xs text-zinc-400 hover:text-white px-1.5 py-1 rounded hover:bg-zinc-800">
        <X size={14} />
      </button>
    </div>
  );
}
