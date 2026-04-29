import React, { useState, useEffect, useRef } from 'react';
import { CheckCircle2, X, Paperclip, ArrowRight, Loader2, Sparkles } from 'lucide-react';
import DetailModalShell from '../common/DetailModalShell';
import api from '../../services/api';
import { useToast } from '../common/Toast';

/**
 * Bottom-sheet modal that intercepts a "Done" status change and submits the
 * task for hierarchical approval instead of marking it complete directly.
 *
 * Props:
 *   task        — task being marked done. Required for {id, title, boardId}.
 *   onClose()   — close without submitting (caller should NOT change status).
 *   onSubmitted(updatedTask) — fires after the approval submission succeeds;
 *                 caller should refresh task data (status will still be the
 *                 pre-Done value, approvalStatus = 'pending_approval').
 */
export default function MarkDoneApprovalModal({ task, onClose, onSubmitted }) {
  const { success, error: toastError } = useToast();
  const [comment, setComment] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null); // { autoApprove, nextApprover }
  const [previewError, setPreviewError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef(null);

  // Load the next-approver preview as soon as the modal opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/task-extras/approval-preview');
        if (cancelled) return;
        setPreview(res.data?.data || res.data);
      } catch (err) {
        if (cancelled) return;
        setPreviewError('Could not load approver info — submission will still work.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function handleFileSelect(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) {
      toastError('Attachment must be 25MB or smaller.');
      return;
    }
    setFile(f);
  }

  async function uploadAttachment() {
    if (!file) return null;
    const formData = new FormData();
    formData.append('file', file);
    formData.append('taskId', task.id);
    const res = await api.post('/files', formData);
    // server returns either { file: {...} } or { data: { file: {...} } } depending on path
    const f = res.data?.file || res.data?.data?.file || res.data;
    return f?.url || f?.attachmentUrl || null;
  }

  async function handleSubmit() {
    const trimmed = comment.trim();
    if (!trimmed) {
      toastError('Please add a short note about what you completed.');
      return;
    }
    setSubmitting(true);
    try {
      let attachmentUrl = null;
      if (file) {
        try {
          attachmentUrl = await uploadAttachment();
        } catch (err) {
          // Non-fatal — continue with submission, surface toast.
          toastError('Attachment upload failed; submitting without it.');
        }
      }

      const res = await api.post(`/task-extras/${task.id}/submit-approval`, {
        comment: trimmed,
        attachmentUrl,
      });
      const data = res.data?.data || res.data;

      if (data?.task?.approvalStatus === 'approved') {
        success('Task auto-approved (no senior reviewer in chain).');
      } else {
        success('Submitted for approval.');
      }

      onSubmitted?.(data?.task || null);
      onClose?.();
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to submit for approval.';
      toastError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const headlineId = `mark-done-${task.id}-headline`;

  return (
    <DetailModalShell
      onClose={submitting ? () => {} : onClose}
      placement="bottom"
      size="narrow"
      ariaLabelledBy={headlineId}
      closeOnBackdrop={!submitting}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-emerald-50 dark:bg-emerald-500/15 flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h2 id={headlineId} className="text-sm font-semibold text-zinc-900 dark:text-white">
              Submit for approval
            </h2>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate max-w-[420px]">
              {task.title}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 transition-colors disabled:opacity-40"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-4 overflow-y-auto">
        {/* Comment — required */}
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1.5">
            What did you complete? <span className="text-red-500">*</span>
          </label>
          <textarea
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={submitting}
            placeholder="Brief note for the reviewer — what was done, anything they should check…"
            rows={3}
            className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 resize-none disabled:opacity-60"
            maxLength={2000}
          />
          <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-1 text-right">
            {comment.length}/2000
          </p>
        </div>

        {/* Attachment — optional */}
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1.5">
            Attachment <span className="text-zinc-400 font-normal normal-case">(optional)</span>
          </label>
          {!file ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-300 hover:border-emerald-500 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors disabled:opacity-50"
            >
              <Paperclip className="w-3.5 h-3.5" />
              Attach a file
            </button>
          ) : (
            <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700">
              <div className="flex items-center gap-2 min-w-0">
                <Paperclip className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                <span className="text-xs text-zinc-700 dark:text-zinc-200 truncate">{file.name}</span>
                <span className="text-[10px] text-zinc-400">
                  {(file.size / 1024).toFixed(0)} KB
                </span>
              </div>
              <button
                type="button"
                onClick={() => setFile(null)}
                disabled={submitting}
                className="p-1 rounded text-zinc-400 hover:text-red-500 disabled:opacity-50"
                aria-label="Remove attachment"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>

        {/* Approver preview */}
        <div className="rounded-md bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-700 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1.5">
            <ArrowRight className="w-3 h-3" />
            Next reviewer
          </div>
          {preview === null && !previewError && (
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading…
            </div>
          )}
          {previewError && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{previewError}</p>
          )}
          {preview?.autoApprove && (
            <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
              <Sparkles className="w-3.5 h-3.5" />
              Will be auto-approved (no senior reviewer in your chain).
            </div>
          )}
          {preview?.nextStage?.isParallel && preview.nextStage.approvers?.length > 0 ? (
            // Parallel any-of stage (e.g. final stage = Manager + Admin + Super
            // Admin). Show every approver — any one of them can approve to
            // complete the chain.
            <div>
              <p className="text-[10px] text-zinc-500 dark:text-zinc-400 mb-1.5 uppercase tracking-wide">
                Final stage · any one approves
              </p>
              <div className="flex flex-col gap-1.5">
                {preview.nextStage.approvers.map((a) => (
                  <div key={a.userId || a.userName} className="flex items-center gap-2.5">
                    <div className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-semibold flex-shrink-0">
                      {a.userName?.[0]?.toUpperCase() || '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-zinc-900 dark:text-white truncate">
                        {a.userName}
                      </p>
                      <p className="text-[10px] text-zinc-500 dark:text-zinc-400 capitalize">
                        {a.isSuperAdmin ? 'super admin' : (a.role?.replace('_', ' ') || 'reviewer')}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : preview?.nextApprover && (
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[11px] font-semibold">
                {preview.nextApprover.userName?.[0]?.toUpperCase() || '?'}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-900 dark:text-white truncate">
                  {preview.nextApprover.userName}
                </p>
                <p className="text-[10px] text-zinc-500 dark:text-zinc-400 capitalize">
                  {preview.nextApprover.role?.replace('_', ' ') || 'reviewer'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="px-3 py-1.5 rounded-md text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || !comment.trim()}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-semibold bg-emerald-500 text-white hover:bg-emerald-600 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed transition-colors"
        >
          {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {submitting ? 'Submitting…' : 'Submit for approval'}
        </button>
      </div>
    </DetailModalShell>
  );
}
