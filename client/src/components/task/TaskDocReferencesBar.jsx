import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { getTaskDocReferences } from '../../services/docsService';
import safeLog from '../../utils/safeLog';

/**
 * TaskDocReferencesBar — Phase D Slice 2 bidirectional companion.
 *
 * "Where in the workspace docs is this task mentioned?" — shown as a slim
 * pill row inside the TaskModal, right under the description. Each pill
 * navigates to the doc that referenced this task.
 *
 * Backed by GET /api/tasks/:id/doc-references. The endpoint filters by
 * workspace visibility, so callers only see docs they can read.
 *
 * Self-hides when the task has zero references — no empty-state noise on
 * tasks that haven't been mentioned anywhere yet.
 */
export default function TaskDocReferencesBar({ taskId }) {
  const navigate = useNavigate();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!taskId) return undefined;
    let cancelled = false;
    setLoading(true);
    getTaskDocReferences(taskId)
      .then(({ docs: list }) => {
        if (cancelled) return;
        setDocs(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        // 403 (caller can't see the task's board) and other errors are
        // not user-actionable here — surface nothing, just empty state.
        safeLog.warn('[TaskDocReferencesBar] load error', err);
        if (!cancelled) setDocs([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId]);

  if (loading || docs.length === 0) return null;

  return (
    <div className="-mt-2 flex items-center flex-wrap gap-1.5 text-[11px]">
      <span className="inline-flex items-center gap-1 text-text-tertiary font-medium">
        <FileText size={11} />
        Referenced in {docs.length === 1 ? '1 doc' : `${docs.length} docs`}:
      </span>
      {docs.slice(0, 6).map((d) => (
        <button
          key={d.docId}
          type="button"
          onClick={() => navigate(`/docs/${d.docId}`)}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[#0073ea] bg-[#0073ea]/10 hover:bg-[#0073ea]/20 transition-colors max-w-[180px] truncate"
          title={d.title}
        >
          <FileText size={10} className="flex-shrink-0" />
          <span className="truncate">{d.title || 'Untitled doc'}</span>
        </button>
      ))}
      {docs.length > 6 && (
        <span className="text-text-tertiary">+{docs.length - 6} more</span>
      )}
    </div>
  );
}
