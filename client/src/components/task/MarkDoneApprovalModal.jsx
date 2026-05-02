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
      {/* Header — compact: 28px chip, single-line title, smaller subtitle */}
      <div className="modal-header-compact">
        <div className="flex items-center gap-2 min-w-0">
          <div className="modal-title-chip bg-emerald-50 dark:bg-emerald-500/15">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="min-w-0">
            <h2 id={headlineId} className="modal-title-text">
              Submit for approval
            </h2>
            <p className="modal-title-sub max-w-[380px]">{task.title}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="modal-close-btn"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body — denser stack (space-y-3), capped textarea, inline attachment row */}
      <div className="modal-body-compact space-y-3">
        {/* Comment — required */}
        <div className="form-field-compact">
          <div className="flex items-center justify-between">
            <label className="form-label-compact">
              What did you complete? <span className="text-red-500">*</span>
            </label>
            <span className="form-helper-compact tabular-nums">
              {comment.length}/2000
            </span>
          </div>
          <textarea
            autoFocus
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={submitting}
            placeholder="Brief note for the reviewer — what was done, anything they should check…"
            rows={2}
            className="form-textarea-compact"
            maxLength={2000}
          />
        </div>

        {/* Attachment — optional. Single-row dashed button collapses into a
            file pill once selected; both states stay ~32px tall. */}
        <div className="form-field-compact">
          <label className="form-label-compact">
            Attachment <span className="text-zinc-400 font-normal normal-case">(optional)</span>
          </label>
          {!file ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
              className="compact-upload"
            >
              <Paperclip className="w-3.5 h-3.5" />
              Attach a file
            </button>
          ) : (
            <div className="compact-upload-row">
              <div className="flex items-center gap-2 min-w-0">
                <Paperclip className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                <span className="text-[12px] text-zinc-700 dark:text-zinc-200 truncate">{file.name}</span>
                <span className="form-helper-compact flex-shrink-0">
                  {(file.size / 1024).toFixed(0)} KB
                </span>
              </div>
              <button
                type="button"
                onClick={() => setFile(null)}
                disabled={submitting}
                className="p-0.5 rounded text-zinc-400 hover:text-red-500 disabled:opacity-50"
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

        {/* Approver preview — compact card, 24px avatar */}
        <div className="compact-card">
          <div className="flex items-center gap-1.5 form-label-compact mb-1.5">
            <ArrowRight className="w-3 h-3" />
            Next reviewer
          </div>
          {preview === null && !previewError && (
            <div className="flex items-center gap-1.5 text-[12px] text-zinc-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading…
            </div>
          )}
          {previewError && (
            <p className="text-[12px] text-amber-600 dark:text-amber-400">{previewError}</p>
          )}
          {preview?.autoApprove && (
            <div className="flex items-center gap-1.5 text-[12px] text-emerald-700 dark:text-emerald-400">
              <Sparkles className="w-3.5 h-3.5" />
              Will be auto-approved (no senior reviewer in your chain).
            </div>
          )}
          {preview?.nextStage?.isParallel && preview.nextStage.approvers?.length > 0 ? (
            // Parallel any-of stage (e.g. final stage = Manager + Admin + Super
            // Admin). Show every approver — any one of them can approve to
            // complete the chain.
            <div>
              <p className="form-helper-compact uppercase tracking-wide mb-1">
                Final stage · any one approves
              </p>
              <div className="flex flex-col gap-1">
                {preview.nextStage.approvers.map((a) => (
                  <div key={a.userId || a.userName} className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-semibold flex-shrink-0">
                      {a.userName?.[0]?.toUpperCase() || '?'}
                    </div>
                    <div className="min-w-0 flex-1 flex items-baseline gap-1.5">
                      <p className="text-[12px] font-medium text-zinc-900 dark:text-white truncate">
                        {a.userName}
                      </p>
                      <p className="form-helper-compact capitalize truncate">
                        {a.isSuperAdmin ? 'super admin' : (a.role?.replace('_', ' ') || 'reviewer')}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : preview?.nextApprover && (
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-semibold flex-shrink-0">
                {preview.nextApprover.userName?.[0]?.toUpperCase() || '?'}
              </div>
              <div className="min-w-0 flex items-baseline gap-1.5">
                <p className="text-[12px] font-medium text-zinc-900 dark:text-white truncate">
                  {preview.nextApprover.userName}
                </p>
                <p className="form-helper-compact capitalize truncate">
                  {preview.nextApprover.role?.replace('_', ' ') || 'reviewer'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer actions — compact buttons, no longer text-sm font-semibold */}
      <div className="modal-footer-compact">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="btn-compact-ghost"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || !comment.trim()}
          className="btn-compact-primary"
        >
          {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {submitting ? 'Submitting…' : 'Submit for approval'}
        </button>
      </div>
    </DetailModalShell>
  );
}
