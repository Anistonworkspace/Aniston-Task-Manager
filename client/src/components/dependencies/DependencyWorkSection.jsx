import React, { useState, useEffect, useCallback } from 'react';
import {
  Link2, ChevronDown, ChevronUp, ChevronRight, Calendar, Flag,
  Play, Check, X, Trash2, UserCheck, AlertCircle, FileText, Archive,
} from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';
import { useToast } from '../common/Toast';
import { useAuth } from '../../context/AuthContext';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';
import RejectDependencyDialog from './RejectDependencyDialog';
import ReassignDependencyDialog from './ReassignDependencyDialog';

const STATUS_BADGES = {
  pending:        { label: 'Pending',        bg: 'bg-amber-100',   text: 'text-amber-700' },
  accepted:       { label: 'Accepted',       bg: 'bg-blue-100',    text: 'text-blue-700' },
  working_on_it:  { label: 'Working',        bg: 'bg-orange-100',  text: 'text-orange-700' },
  done:           { label: 'Done',           bg: 'bg-emerald-100', text: 'text-emerald-700' },
  rejected:       { label: 'Rejected',       bg: 'bg-red-100',     text: 'text-red-700' },
  cancelled:      { label: 'Cancelled',      bg: 'bg-gray-100',    text: 'text-gray-600' },
};

const PRIORITY_COLORS = {
  low:      '#9aa6b8',
  medium:   '#fdab3d',
  high:     '#ff7575',
  critical: '#e2445c',
};

const ACTIVE_STATUSES = ['pending', 'accepted', 'working_on_it'];

/**
 * "🔗 Dependency Work" section inside the parent task modal.
 *
 * Shows DependencyRequest rows as compact subtask-style children. Distinct
 * styling (chain icon, slate background, "Dependency" label) so they aren't
 * confused with normal subtasks. Each row exposes status-aware actions
 * directly without leaving the modal.
 *
 * Permissions:
 * - Assignee can transition status (accept/start/done) and reject
 * - Requester can cancel and reassign
 * - Anyone with task access can view
 *
 * Props:
 *   - taskId
 *   - depKey      — bumped by the parent to force a refetch (matches the
 *                   pattern used by DependencyBadge)
 *   - onChanged   — called after any mutation so parent can refresh task data
 */
export default function DependencyWorkSection({ taskId, depKey, onChanged }) {
  const toast = useToast();
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [expanded, setExpanded] = useState(true);
  const [openRowId, setOpenRowId] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const [reassignTarget, setReassignTarget] = useState(null);

  const load = useCallback(async () => {
    if (!taskId) return;
    try {
      const res = await api.get(`/tasks/${taskId}/dependencies`);
      const data = res.data?.data || res.data;
      setRows(data?.dependencyRequests || []);
    } catch {
      setRows([]);
    }
  }, [taskId]);

  useEffect(() => { load(); }, [load, depKey]);

  // Phase 9: live updates. Server emits dependency:<event> per-user (when
  // the viewer is a party) AND to the parent's board room. Either path is
  // enough to trigger a refetch — useSocket attaches once and the latest
  // taskId is used inside the closure via the ref dance inside the hook.
  // Filter by parentTaskId so a transition on some OTHER task doesn't
  // pointlessly refetch this section.
  useRealtimeEvent('dependency:requested', (p) => { if (p?.parentTaskId === taskId) load(); });
  useRealtimeEvent('dependency:accepted',  (p) => { if (p?.parentTaskId === taskId) load(); });
  useRealtimeEvent('dependency:started',   (p) => { if (p?.parentTaskId === taskId) load(); });
  useRealtimeEvent('dependency:done',      (p) => { if (p?.parentTaskId === taskId) { load(); onChanged?.(); } });
  useRealtimeEvent('dependency:rejected',  (p) => { if (p?.parentTaskId === taskId) load(); });
  useRealtimeEvent('dependency:cancelled', (p) => { if (p?.parentTaskId === taskId) { load(); onChanged?.(); } });
  useRealtimeEvent('dependency:reassigned',(p) => { if (p?.parentTaskId === taskId) load(); });

  // ─── Mutations ────────────────────────────────────────────────
  async function transitionTo(dep, newStatus, extra = {}) {
    try {
      await api.patch(`/dependencies/${dep.id}/status`, { status: newStatus, ...extra });
      toast.success(`Marked as ${newStatus.replace(/_/g, ' ')}.`);
      load();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Update failed.');
    }
  }

  async function cancelRow(dep) {
    if (!window.confirm(`Cancel dependency "${dep.title}"?`)) return;
    try {
      await api.delete(`/dependencies/${dep.id}`);
      toast.success('Dependency cancelled.');
      load();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Cancel failed.');
    }
  }

  async function archiveRow(dep) {
    try {
      await api.put(`/dependencies/${dep.id}/archive`);
      toast.success('Archived.');
      load();
      onChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Archive failed.');
    }
  }

  if (!rows || rows.length === 0) return null;

  // Count active vs closed for the header badge.
  const activeCount = rows.filter(r => ACTIVE_STATUSES.includes(r.status)).length;
  const rejectedCount = rows.filter(r => r.status === 'rejected').length;
  const closedCount = rows.filter(r => ['done', 'cancelled'].includes(r.status)).length;

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50/40">
      {/* Header */}
      <button onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <Link2 size={14} className="text-slate-500" />
        <span className="text-sm font-semibold text-slate-700">Dependency Work</span>
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-200 text-slate-600">
          {rows.length}
        </span>
        {activeCount > 0 && (
          <span className="text-[10px] font-medium text-amber-700">
            · {activeCount} active
          </span>
        )}
        {rejectedCount > 0 && (
          <span className="text-[10px] font-bold text-red-600">
            · {rejectedCount} rejected
          </span>
        )}
        {closedCount > 0 && (
          <span className="text-[10px] text-emerald-600">
            · {closedCount} closed
          </span>
        )}
        <span className="ml-auto text-slate-400">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {/* Rows */}
      {expanded && (
        <div className="border-t border-slate-200 divide-y divide-slate-100 bg-white rounded-b-lg">
          {rows.map(dep => (
            <DependencyRow
              key={dep.id}
              dep={dep}
              viewerId={user?.id}
              isOpen={openRowId === dep.id}
              onToggle={() => setOpenRowId(openRowId === dep.id ? null : dep.id)}
              onTransition={transitionTo}
              onCancel={cancelRow}
              onArchive={archiveRow}
              onReject={() => setRejectTarget(dep)}
              onReassign={() => setReassignTarget(dep)}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      {rejectTarget && (
        <RejectDependencyDialog
          dep={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onSubmitted={() => { setRejectTarget(null); load(); onChanged?.(); }}
        />
      )}
      {reassignTarget && (
        <ReassignDependencyDialog
          dep={reassignTarget}
          onClose={() => setReassignTarget(null)}
          onSubmitted={() => { setReassignTarget(null); load(); onChanged?.(); }}
        />
      )}
    </div>
  );
}

// ─── Row ──────────────────────────────────────────────────────────
function DependencyRow({
  dep, viewerId, isOpen, onToggle,
  onTransition, onCancel, onArchive, onReject, onReassign,
}) {
  const status = STATUS_BADGES[dep.status] || STATUS_BADGES.pending;
  const priorityColor = PRIORITY_COLORS[dep.priority] || PRIORITY_COLORS.medium;
  const isAssignee  = dep.assignedToUserId === viewerId;
  const isRequester = dep.requestedByUserId === viewerId;

  const overdue = dep.dueDate && new Date(dep.dueDate) < new Date() && ACTIVE_STATUSES.includes(dep.status);

  const isClosed = ['done', 'cancelled'].includes(dep.status);
  const isRejected = dep.status === 'rejected';

  // Inline action buttons (compact, primary-only)
  const inlineButtons = [];
  if (isAssignee && dep.status === 'pending') {
    inlineButtons.push({ key: 'accept', icon: Check, label: 'Accept', onClick: () => onTransition(dep, 'accepted') });
    inlineButtons.push({ key: 'start',  icon: Play,  label: 'Start',  onClick: () => onTransition(dep, 'working_on_it'), primary: true });
  } else if (isAssignee && dep.status === 'accepted') {
    inlineButtons.push({ key: 'start', icon: Play,  label: 'Start', onClick: () => onTransition(dep, 'working_on_it'), primary: true });
    inlineButtons.push({ key: 'done',  icon: Check, label: 'Done',  onClick: () => onTransition(dep, 'done') });
  } else if (isAssignee && dep.status === 'working_on_it') {
    inlineButtons.push({ key: 'done', icon: Check, label: 'Done', onClick: () => onTransition(dep, 'done'), primary: true });
  }

  return (
    <div className={`px-3 py-2 ${isRejected ? 'bg-red-50/40' : isClosed ? 'opacity-70' : ''}`}>
      {/* Compact row */}
      <div className="flex items-center gap-2">
        <button onClick={onToggle} className="text-slate-400 hover:text-slate-600 flex-shrink-0">
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <Link2 size={11} className="text-slate-400 flex-shrink-0" />

        {/* Title */}
        <span className={`text-xs font-medium truncate flex-1 min-w-0 ${
          dep.status === 'done' ? 'line-through text-slate-400' : 'text-slate-700'
        }`} title={dep.title}>
          {dep.title}
        </span>

        {/* Status pill */}
        <span className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${status.bg} ${status.text} flex-shrink-0`}>
          {status.label}
        </span>

        {/* Assignee — fallback when the user was deleted (FK SET NULL).
            Phase 10 spec: show "Assignee unavailable" so requester can reassign. */}
        {dep.assignedTo ? (
          <span className="flex items-center gap-1 flex-shrink-0">
            <Avatar name={dep.assignedTo.name} size="xs" />
            <span className="text-[10px] text-slate-500 hidden sm:inline">{dep.assignedTo.name.split(' ')[0]}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1 flex-shrink-0 text-[10px] text-amber-600 italic"
            title="The user assigned to this dependency is no longer available. Reassign or cancel.">
            Assignee unavailable
          </span>
        )}

        {/* Due date */}
        {dep.dueDate && (
          <span className={`flex items-center gap-0.5 text-[10px] flex-shrink-0 ${
            overdue ? 'text-red-600 font-bold' : 'text-slate-500'
          }`} title={overdue ? 'Overdue' : 'Due date'}>
            <Calendar size={9} />
            {String(dep.dueDate).slice(5, 10)}
          </span>
        )}

        {/* Priority dot */}
        <span title={`Priority: ${dep.priority}`}
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: priorityColor }} />

        {/* Inline action buttons */}
        {inlineButtons.length > 0 && (
          <div className="flex items-center gap-1 flex-shrink-0">
            {inlineButtons.map(b => {
              const Icon = b.icon;
              return (
                <button key={b.key} onClick={b.onClick}
                  className={`flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                    b.primary
                      ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                      : 'bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-100'
                  }`}>
                  <Icon size={10} /> {b.label}
                </button>
              );
            })}
            {isAssignee && ACTIVE_STATUSES.includes(dep.status) && (
              <button onClick={onReject}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-red-50 text-red-600 hover:bg-red-100 border border-red-100">
                <X size={10} /> Reject
              </button>
            )}
          </div>
        )}
      </div>

      {/* Expanded details */}
      {isOpen && (
        <div className="mt-2 pl-6 pr-2 pb-1 space-y-2 text-xs">
          {/* Blocking reason */}
          {dep.blockingReason && (
            <div className="flex gap-1.5 items-start">
              <FileText size={11} className="mt-0.5 flex-shrink-0 text-slate-400" />
              <p className="text-slate-600 italic leading-relaxed">{dep.blockingReason}</p>
            </div>
          )}

          {/* Rejection reason */}
          {isRejected && dep.rejectionReason && (
            <div className="flex gap-1.5 items-start px-2 py-1.5 rounded-md bg-red-50 border border-red-200 text-red-700">
              <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">Rejected</p>
                <p className="leading-relaxed">{dep.rejectionReason}</p>
              </div>
            </div>
          )}

          {/* People meta */}
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
            {dep.requestedBy && (
              <span>Requested by <span className="font-medium text-slate-700">{dep.requestedBy.name}</span></span>
            )}
            {dep.originalAssigner && dep.originalAssigner.id !== dep.requestedBy?.id && (
              <span>Originally assigned by <span className="font-medium text-slate-700">{dep.originalAssigner.name}</span></span>
            )}
            <span className="flex items-center gap-1">
              <Flag size={9} /> Priority: <span className="capitalize text-slate-700">{dep.priority}</span>
            </span>
          </div>

          {/* Secondary actions row (Reassign, Cancel, Archive) — collapsed-by-default features */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {isRequester && ACTIVE_STATUSES.concat(['rejected']).includes(dep.status) && (
              <>
                <button onClick={onReassign}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-100">
                  <UserCheck size={10} /> Reassign
                </button>
                <button onClick={() => onCancel(dep)}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-red-50 text-red-600 hover:bg-red-100 border border-red-100">
                  <Trash2 size={10} /> Cancel
                </button>
              </>
            )}
            {isClosed && !dep.archivedAt && (
              <button onClick={() => onArchive(dep)}
                className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-gray-100 text-gray-500 hover:bg-gray-200">
                <Archive size={10} /> Archive
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
