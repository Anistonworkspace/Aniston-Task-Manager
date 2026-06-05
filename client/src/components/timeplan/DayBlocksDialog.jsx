import React, { useEffect } from 'react';
import { X, Plus, Pencil, Trash2, Link2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { blockColor, blockTitle, statusStyle, TEAMS_HEX } from './plannerTheme';

/**
 * Month-view day dialog — lists every block (and Teams event) on a clicked day,
 * since a month cell only shows a few chips + "+N more". Mirrors the detail
 * popover's affordances: edit / delete per block, open linked task, add new.
 */
export default function DayBlocksDialog({ date, blocks, teamsEvents = [], canManage, onEdit, onDelete, onAdd, onOpenTask, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sorted = [...blocks].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const teams = [...teamsEvents].filter((e) => e.startTime).sort((a, b) => a.startTime.localeCompare(b.startTime));

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Day blocks"
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-t-2xl bg-white shadow-modal animate-slide-up sm:rounded-2xl sm:animate-scale-in"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h3 className="font-title text-base font-bold text-text-primary">{format(parseISO(date), 'EEEE, MMM d')}</h3>
          <div className="flex items-center gap-2">
            {canManage && (
              <button type="button" onClick={() => onAdd(date)} className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-600">
                <Plus size={13} /> Add
              </button>
            )}
            <button type="button" onClick={onClose} className="rounded-md p-1 text-text-secondary hover:bg-surface" aria-label="Close"><X size={16} /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {sorted.length === 0 && teams.length === 0 ? (
            <p className="py-10 text-center text-sm text-text-secondary">No blocks planned for this day.</p>
          ) : (
            <ul className="space-y-1.5">
              {sorted.map((b) => {
                const c = blockColor(b);
                const ss = statusStyle(b.status);
                return (
                  <li key={b.id} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2" style={{ borderLeftColor: c, borderLeftWidth: 3 }}>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[11px] font-semibold" style={{ color: c }}>{b.startTime}–{b.endTime}</span>
                        {b.taskId && <Link2 size={11} className="text-text-tertiary" />}
                        <span className="text-[10px] font-medium" style={{ color: ss.hex }}>{ss.label}</span>
                      </span>
                      <span className="block truncate text-sm text-text-primary">{blockTitle(b)}</span>
                    </span>
                    {b.taskId && onOpenTask && (
                      <button type="button" onClick={() => onOpenTask(b)} className="rounded-md p-1 text-text-tertiary hover:text-primary" aria-label="Open task"><Link2 size={14} /></button>
                    )}
                    {canManage && (
                      <>
                        <button type="button" onClick={() => onEdit(b)} className="rounded-md p-1 text-text-secondary hover:bg-surface" aria-label="Edit"><Pencil size={14} /></button>
                        <button type="button" onClick={() => onDelete(b)} className="rounded-md p-1 text-text-secondary hover:text-danger" aria-label="Delete"><Trash2 size={14} /></button>
                      </>
                    )}
                  </li>
                );
              })}
              {teams.map((e, i) => (
                <li key={`t-${e.id || i}`} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2" style={{ borderLeftColor: TEAMS_HEX, borderLeftWidth: 3 }}>
                  <span className="min-w-0 flex-1">
                    <span className="text-[11px] font-semibold" style={{ color: TEAMS_HEX }}>{e.startTime}–{e.endTime} · Teams</span>
                    <span className="block truncate text-sm text-text-primary">{e.subject || 'Microsoft 365 event'}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
