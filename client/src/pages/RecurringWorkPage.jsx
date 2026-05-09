import React, { useEffect, useState } from 'react';
import {
  RefreshCw, Plus, Pause, Play, Archive as ArchiveIcon, Pencil, AlertCircle,
  ChevronDown, ChevronRight, Clock, Calendar, ShieldAlert, CheckCircle2,
  CalendarDays, FolderTree,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/common/Toast';
import RecurringTemplateModal from '../components/recurring/RecurringTemplateModal';
import Avatar from '../components/common/Avatar';
import useRealtimeQuery from '../realtime/useRealtimeQuery';
import {
  listTemplates,
  pauseTemplate,
  resumeTemplate,
  archiveTemplate,
  getTemplate,
  formatSchedule,
} from '../services/recurringTasks';

/**
 * RecurringWorkPage — manage recurring task templates ("Daily Work").
 *
 * Server-side filters visibility:
 *   - Members see only templates they created for themselves.
 *   - Assistant managers see their subtree + their own.
 *   - Manager / admin / super-admin see everything.
 *
 * The page shows two tabs: Active and Archived. Each row can be expanded to
 * reveal the last 30 generated instances (occurrence date, status, completed
 * at, missed-escalation flag) — that's the reporting view the spec asks for.
 */
export default function RecurringWorkPage() {
  const { user, isMember } = useAuth();
  const navigate = useNavigate();
  const { success: toastSuccess, error: toastError } = useToast();

  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('active');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [instancesById, setInstancesById] = useState({});
  const [instancesLoading, setInstancesLoading] = useState(false);

  useEffect(() => { load(); }, [tab]);

  // F-9: live refresh when ANY user creates / updates / pauses / archives a
  // template that's visible to the current viewer. The server-side recipient
  // resolution (emitTemplateEvent) already gates the event; the page just
  // needs to listen and refetch.
  useRealtimeQuery({
    queryKey: 'recurring.list',
    refetch: load,
  });

  async function load() {
    setLoading(true);
    try {
      const params = tab === 'archived' ? { includeArchived: true } : {};
      const all = await listTemplates(params);
      const filtered = tab === 'archived'
        ? all.filter(t => !!t.archivedAt)
        : all.filter(t => !t.archivedAt);
      setTemplates(filtered);
    } catch (err) {
      toastError(err?.response?.data?.message || 'Could not load recurring work.');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Apply an optimistic local update from the saved template returned by
   * `createTemplate` / `updateTemplate`. Belt-and-braces refresh: the
   * subsequent `load()` does an authoritative re-fetch, but if that hits a
   * stale read (proxy cache, slow socket, etc.) the optimistic patch keeps
   * the row in sync with what the server just confirmed it persisted.
   *
   * Idempotent — replacing a row by id is safe even if the server already
   * sent the realtime invalidation that triggered a load() in parallel.
   */
  function applyOptimisticTemplate(saved) {
    if (!saved || !saved.id) return;
    setTemplates((prev) => {
      const list = Array.isArray(prev) ? prev : [];
      const isArchivedRow = !!saved.archivedAt;
      const tabHidesRow = tab === 'archived' ? !isArchivedRow : isArchivedRow;
      const next = list.filter((t) => t && t.id !== saved.id);
      // Only insert when the row belongs in the current tab. An archive-then-
      // active toggle bumps the row out of view via the filter; load() will
      // confirm.
      if (!tabHidesRow) next.unshift(saved);
      return next;
    });
  }

  function handleNew() {
    setEditing(null);
    setShowModal(true);
  }

  function handleEdit(tpl) {
    setEditing(tpl);
    setShowModal(true);
  }

  async function handleTogglePause(tpl) {
    try {
      if (tpl.isActive) {
        await pauseTemplate(tpl.id);
        toastSuccess('Paused.');
      } else {
        await resumeTemplate(tpl.id);
        toastSuccess('Resumed.');
      }
      load();
    } catch (err) {
      toastError(err?.response?.data?.message || 'Could not update template.');
    }
  }

  async function handleArchive(tpl) {
    if (!confirm(`Archive "${tpl.title}"?\nIt will stop generating new tasks. Existing instances will remain in history.`)) return;
    try {
      await archiveTemplate(tpl.id);
      toastSuccess('Archived.');
      load();
    } catch (err) {
      toastError(err?.response?.data?.message || 'Could not archive.');
    }
  }

  async function toggleExpand(tpl) {
    if (expandedId === tpl.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(tpl.id);
    if (instancesById[tpl.id]) return;
    setInstancesLoading(true);
    try {
      const { instances } = await getTemplate(tpl.id);
      setInstancesById((m) => ({ ...m, [tpl.id]: instances || [] }));
    } catch (err) {
      toastError('Could not load history.');
    } finally {
      setInstancesLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-[1100px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-text-primary">
            <RefreshCw size={20} className="text-primary" />
            Recurring Work
          </h1>
          <p className="text-sm text-text-secondary mt-0.5">
            Daily / weekly / monthly tasks that auto-generate so you don't have to recreate them every time.
          </p>
        </div>
        <button
          onClick={handleNew}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover transition-colors shadow-sm"
        >
          <Plus size={16} /> New Daily Work
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-border">
        {[
          { id: 'active', label: 'Active' },
          { id: 'archived', label: 'Archived' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              `px-3 py-2 text-sm font-medium border-b-2 transition-colors -mb-px `
              + (tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="py-20 flex items-center justify-center">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary" />
        </div>
      ) : templates.length === 0 ? (
        <EmptyState onNew={handleNew} tab={tab} isMember={isMember} />
      ) : (
        <div className="space-y-2">
          {templates.map(tpl => (
            <TemplateRow
              key={tpl.id}
              tpl={tpl}
              expanded={expandedId === tpl.id}
              instances={instancesById[tpl.id]}
              instancesLoading={instancesLoading && expandedId === tpl.id}
              onToggleExpand={() => toggleExpand(tpl)}
              onEdit={() => handleEdit(tpl)}
              onTogglePause={() => handleTogglePause(tpl)}
              onArchive={() => handleArchive(tpl)}
              onOpenInstance={(inst) => navigate(`/boards/${tpl.boardId}?taskId=${inst.id}`)}
            />
          ))}
        </div>
      )}

      <RecurringTemplateModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        template={editing}
        onSaved={(saved) => {
          // Apply the saved row immediately (covers stale-read edge cases),
          // then re-fetch the list authoritatively.
          applyOptimisticTemplate(saved);
          load();
        }}
      />
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

function TemplateRow({ tpl, expanded, instances, instancesLoading, onToggleExpand, onEdit, onTogglePause, onArchive, onOpenInstance }) {
  const isArchived = !!tpl.archivedAt;
  const assignee = tpl.assignee;
  const board = tpl.board;

  // Resolve the human-readable group label by matching template.groupId
  // against the eager-loaded board.groups JSONB. Falls back to the raw
  // groupId so the row always shows *something*.
  const groupLabel = React.useMemo(() => {
    if (!tpl.groupId) return null;
    if (tpl.groupId === 'new') return 'New (default)';
    const groups = Array.isArray(board?.groups) ? board.groups : [];
    const match = groups.find((g) => g && g.id === tpl.groupId);
    return match?.title || tpl.groupId;
  }, [tpl.groupId, board]);

  return (
    <div className={
      `border rounded-lg transition-colors `
      + (isArchived ? 'bg-surface-100 dark:bg-[#1c1d20] border-border opacity-75' : 'bg-white dark:bg-[#1E1F23] border-border')
    }>
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={onToggleExpand}
          className="p-1 rounded hover:bg-surface-200 transition-colors text-text-tertiary"
          aria-label="Show history"
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm text-text-primary truncate">{tpl.title}</span>
            <StateBadge tpl={tpl} />
            <PriorityBadge priority={tpl.priority} />
            {tpl.escalateIfMissed && (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300" title="Escalates to manager / admin if missed">
                <ShieldAlert size={10} /> Escalates
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-3 flex-wrap text-[11px] text-text-tertiary">
            <span className="inline-flex items-center gap-1">
              <Clock size={11} /> {formatSchedule(tpl)}
            </span>
            {board && (
              <span className="inline-flex items-center gap-1 truncate" title={board.name}>
                <span className="w-2 h-2 rounded-full" style={{ background: board.color || '#0073ea' }} />
                {board.name}
              </span>
            )}
            {groupLabel && (
              <span className="inline-flex items-center gap-1 truncate" title={`Group: ${groupLabel}`}>
                <FolderTree size={11} /> {groupLabel}
              </span>
            )}
            {(tpl.startDate || tpl.endDate) && (
              <span className="inline-flex items-center gap-1" title="Active window">
                <CalendarDays size={11} />
                {tpl.startDate || '—'}{tpl.endDate ? ` → ${tpl.endDate}` : ' → no end'}
              </span>
            )}
            {tpl.lastGeneratedDate && (
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 size={11} /> last generated {tpl.lastGeneratedDate}
              </span>
            )}
            {tpl.nextRunAt && !isArchived && tpl.isActive && (
              <span className="inline-flex items-center gap-1" title="Next scheduled generation (UTC)">
                <Calendar size={11} /> next at {new Date(tpl.nextRunAt).toLocaleString()}
              </span>
            )}
          </div>
        </div>

        {assignee && (
          <div className="flex items-center gap-2 px-2">
            <Avatar user={assignee} size="xs" />
            <span className="text-xs text-text-secondary truncate max-w-[120px]" title={assignee.name}>{assignee.name}</span>
          </div>
        )}

        {!isArchived && (
          <div className="flex items-center gap-1">
            <IconButton onClick={onTogglePause} title={tpl.isActive ? 'Pause' : 'Resume'}>
              {tpl.isActive ? <Pause size={14} /> : <Play size={14} />}
            </IconButton>
            <IconButton onClick={onEdit} title="Edit">
              <Pencil size={14} />
            </IconButton>
            <IconButton onClick={onArchive} title="Archive" danger>
              <ArchiveIcon size={14} />
            </IconButton>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-border px-3 py-2 bg-surface-50 dark:bg-[#1a1b1e]">
          <InstancesList
            instances={instances}
            loading={instancesLoading}
            onOpen={onOpenInstance}
          />
        </div>
      )}
    </div>
  );
}

function StateBadge({ tpl }) {
  if (tpl.archivedAt) {
    return <Pill color="gray">Archived</Pill>;
  }
  if (!tpl.isActive) {
    return <Pill color="amber">Paused</Pill>;
  }
  return <Pill color="green">Active</Pill>;
}

const PRIORITY_COLORS = {
  low: 'gray',
  medium: 'gray',
  high: 'amber',
  critical: 'red',
};
function PriorityBadge({ priority }) {
  if (!priority) return null;
  const color = PRIORITY_COLORS[priority] || 'gray';
  // Don't render a pill for the default "medium" priority — keeps rows
  // visually quiet for the common case while still surfacing high/critical.
  if (priority === 'medium') return null;
  return <Pill color={color}>{priority}</Pill>;
}

function Pill({ color, children }) {
  const map = {
    green: 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300',
    amber: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300',
    red: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300',
    gray: 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-300',
  };
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${map[color] || map.gray}`}>
      {children}
    </span>
  );
}

function IconButton({ onClick, title, danger, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={
        `p-1.5 rounded-md transition-colors `
        + (danger
          ? 'text-text-tertiary hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20'
          : 'text-text-secondary hover:bg-surface-100')
      }
    >
      {children}
    </button>
  );
}

function InstancesList({ instances, loading, onOpen }) {
  if (loading && !instances) {
    return <div className="text-xs text-text-tertiary py-2">Loading history…</div>;
  }
  if (!instances || instances.length === 0) {
    return <div className="text-xs text-text-tertiary py-2">No instances generated yet.</div>;
  }
  return (
    <div className="overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-text-tertiary">
            <th className="py-1.5 font-medium">Date</th>
            <th className="py-1.5 font-medium">Status</th>
            <th className="py-1.5 font-medium">Progress</th>
            <th className="py-1.5 font-medium">Completed</th>
            <th className="py-1.5 font-medium">Missed</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {instances.map(inst => (
            <tr key={inst.id} className="border-t border-border/60 hover:bg-surface-100 transition-colors">
              <td className="py-1.5 text-text-primary font-medium">{inst.occurrenceDate || inst.dueDate}</td>
              <td className="py-1.5">
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-200 dark:bg-[#2a2c30] text-text-secondary">
                  {(inst.status || '').replace(/_/g, ' ')}
                </span>
              </td>
              <td className="py-1.5 text-text-secondary">{inst.progress != null ? `${inst.progress}%` : '—'}</td>
              <td className="py-1.5 text-text-secondary">{inst.completedAt ? new Date(inst.completedAt).toLocaleString() : '—'}</td>
              <td className="py-1.5">
                {inst.missedEscalationSent ? (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-300">
                    <AlertCircle size={11} /> escalated
                  </span>
                ) : <span className="text-text-tertiary">—</span>}
              </td>
              <td className="py-1.5 text-right">
                <button onClick={() => onOpen(inst)} className="text-primary hover:underline text-[11px] font-medium">
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ onNew, tab, isMember }) {
  if (tab === 'archived') {
    return (
      <div className="py-16 text-center">
        <ArchiveIcon size={36} className="mx-auto text-text-tertiary mb-3" />
        <p className="text-sm text-text-secondary">No archived recurring work.</p>
      </div>
    );
  }
  return (
    <div className="py-16 text-center">
      <RefreshCw size={36} className="mx-auto text-text-tertiary mb-3" />
      <h3 className="text-base font-semibold text-text-primary mb-1">No Daily Work yet</h3>
      <p className="text-sm text-text-secondary max-w-md mx-auto mb-5">
        {isMember
          ? 'Create a recurring template for tasks you do every day, like a daily report or stand-up update.'
          : 'Create a recurring template for tasks the team does every day, like a daily report or stand-up update.'}
      </p>
      <button
        onClick={onNew}
        className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover transition-colors"
      >
        <Plus size={16} /> Create your first
      </button>
    </div>
  );
}
