import React, { useState, useEffect, useCallback } from 'react';
import { Link2, Lock, Unlock, ChevronDown, ChevronUp, FolderKanban, Zap, Trash2 } from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';
import { useAuth } from '../../context/AuthContext';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';

export default function DependencyBadge({ taskId, boardId, compact = false, onRefresh }) {
  const { canManage } = useAuth();
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (taskId) loadDeps();
  }, [taskId]);

  async function loadDeps() {
    try {
      const res = await api.get(`/tasks/${taskId}/dependencies`);
      setData(res.data?.data || res.data);
    } catch {}
  }

  // Phase 9: keep the lock-badge counts live when another user transitions
  // a dep on this same parent. Filter by parentTaskId so unrelated traffic
  // doesn't waste a fetch.
  const onDepEvent = useCallback((p) => {
    if (p?.parentTaskId === taskId) loadDeps();
  // taskId is captured in the closure; loadDeps is stable per render. We
  // intentionally skip a deps array — useSocket handles re-attach on its
  // own tick. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
  useRealtimeEvent('dependency:requested',  onDepEvent);
  useRealtimeEvent('dependency:accepted',   onDepEvent);
  useRealtimeEvent('dependency:started',    onDepEvent);
  useRealtimeEvent('dependency:done',       onDepEvent);
  useRealtimeEvent('dependency:rejected',   onDepEvent);
  useRealtimeEvent('dependency:cancelled',  onDepEvent);
  useRealtimeEvent('dependency:reassigned', onDepEvent);

  async function handleRemoveDep(depId) {
    try {
      await api.delete(`/tasks/${taskId}/dependencies/${depId}`);
      loadDeps();
      if (onRefresh) onRefresh();
    } catch {}
  }

  if (!data) return null;

  // Legacy task-to-task links: a "blocker" is the dependsOnTask side that
  // hasn't completed yet. Counts only blocking/required_for type.
  const legacyBlockedByCount = (data.blockedBy || []).filter(d =>
    d.dependsOnTask && d.dependsOnTask.status !== 'done' && ['blocks', 'required_for'].includes(d.dependencyType)
  ).length;
  const blockingCount = (data.blocking || []).length;

  // New DependencyRequest rows. "Blocking" = anything in pending/accepted/
  // working_on_it. Rejected is shown as a separate "action needed" signal.
  const requests = data.dependencyRequests || [];
  const requestBlockingCount = requests.filter(r =>
    ['pending', 'accepted', 'working_on_it'].includes(r.status)
  ).length;
  const requestRejectedCount = requests.filter(r => r.status === 'rejected').length;

  // The unified "blocked by N dependencies" count — combines legacy task
  // blockers and active requests. Rejected requests still keep the parent
  // blocked per Phase 5 spec, so include them.
  const blockedByCount = legacyBlockedByCount + requestBlockingCount + requestRejectedCount;

  const totalDeps = (data.blockedBy || []).length + blockingCount + requests.length;

  if (totalDeps === 0) return null;

  if (compact) {
    return (
      <div className="flex items-center gap-1">
        {blockedByCount > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-danger/10 text-danger" title={`Blocked by ${blockedByCount} dependenc${blockedByCount === 1 ? 'y' : 'ies'}`}>
            <Lock size={9} /> {blockedByCount}
          </span>
        )}
        {requestRejectedCount > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-600" title={`${requestRejectedCount} dependency rejected — action needed`}>
            ! {requestRejectedCount}
          </span>
        )}
        {blockingCount > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-warning/10 text-warning" title={`Blocking ${blockingCount} task(s)`}>
            <Link2 size={9} /> {blockingCount}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mb-4">
      <button onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
          blockedByCount > 0
            ? 'bg-danger/5 border-danger/20 text-danger'
            : 'bg-surface/50 border-border text-text-secondary'
        }`}>
        {blockedByCount > 0 ? <Lock size={14} /> : <Link2 size={14} />}
        <span className="flex-1 text-left">
          {blockedByCount > 0
            ? `Blocked by ${blockedByCount} dependenc${blockedByCount === 1 ? 'y' : 'ies'}`
            : `${totalDeps} dependency link${totalDeps > 1 ? 's' : ''}`
          }
        </span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {/* Phase 5: rejected dependencies need explicit "action needed" surface
          because they keep the parent blocked even though they aren't an
          assignee-side blocker the requester can passively wait on. */}
      {requestRejectedCount > 0 && (
        <div className="mt-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-orange-500/10 text-orange-700 border border-orange-500/20 flex items-center gap-2">
          <span className="font-bold">!</span>
          <span>
            {requestRejectedCount} dependency {requestRejectedCount === 1 ? 'was' : 'were'} rejected — action needed (remove, reassign, or replace)
          </span>
        </div>
      )}

      {expanded && (
        <div className="mt-2 space-y-1.5">
          {/* Blocked By */}
          {(data.blockedBy || []).length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-text-tertiary mb-1 px-1">Blocked By</p>
              {data.blockedBy.map(dep => {
                const t = dep.dependsOnTask;
                if (!t) return null;
                const isDone = t.status === 'done';
                const isCrossBoard = t.boardId && boardId && t.boardId !== boardId;
                return (
                  <div key={dep.id} className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs ${isDone ? 'bg-success/5' : 'bg-danger/5'}`}>
                    {isDone ? <Unlock size={12} className="text-success" /> : <Lock size={12} className="text-danger" />}
                    <div className="flex-1 min-w-0">
                      <span className={`truncate block ${isDone ? 'line-through text-text-tertiary' : 'text-text-primary font-medium'}`}>{t.title}</span>
                      {isCrossBoard && t.board && (
                        <span className="flex items-center gap-1 text-[9px] text-text-tertiary mt-0.5">
                          <FolderKanban size={8} />
                          <span className="w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: t.board.color || '#0073ea' }} />
                          {t.board.name}
                        </span>
                      )}
                    </div>
                    {t.assignee && <Avatar name={t.assignee.name} size="xs" />}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${isDone ? 'bg-success/10 text-success' : 'bg-gray-100 text-text-tertiary'}`}>
                      {isDone ? 'Done' : t.status?.replace('_', ' ')}
                    </span>
                    {canManage && (
                      <button onClick={() => handleRemoveDep(dep.id)} className="text-text-tertiary hover:text-danger p-0.5" title="Remove dependency">
                        <Trash2 size={10} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Blocking */}
          {(data.blocking || []).length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wider font-semibold text-text-tertiary mb-1 px-1 mt-2">Blocking</p>
              {data.blocking.map(dep => {
                const t = dep.task;
                if (!t) return null;
                const isCrossBoard = t.boardId && boardId && t.boardId !== boardId;
                return (
                  <div key={dep.id} className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-warning/5 text-xs">
                    <Link2 size={12} className="text-warning" />
                    <div className="flex-1 min-w-0">
                      <span className="truncate block text-text-primary font-medium">{t.title}</span>
                      {isCrossBoard && t.board && (
                        <span className="flex items-center gap-1 text-[9px] text-text-tertiary mt-0.5">
                          <FolderKanban size={8} />
                          <span className="w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: t.board.color || '#0073ea' }} />
                          {t.board.name}
                        </span>
                      )}
                    </div>
                    {t.assignee && <Avatar name={t.assignee.name} size="xs" />}
                    {dep.autoAssignOnComplete && dep.autoAssignTo && (
                      <span className="flex items-center gap-0.5 text-[9px] text-purple">
                        <Zap size={8} /> → {dep.autoAssignTo.name}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
