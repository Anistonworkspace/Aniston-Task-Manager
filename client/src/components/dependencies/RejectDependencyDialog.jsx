import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, RotateCcw } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../common/Toast';

/**
 * Reject-with-reason dialog for a DependencyRequest.
 * Shared between the Dependencies page (Phase 7) and the Dependency Work
 * section inside the task modal (Phase 8) so the reject UX is identical
 * everywhere.
 *
 * Props:
 *   - dep         — the DependencyRequest row to reject
 *   - onClose
 *   - onSubmitted — called with no args after a successful reject
 */
export default function RejectDependencyDialog({ dep, onClose, onSubmitted }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    const r = reason.trim();
    if (!r) return;
    setSaving(true);
    try {
      await api.patch(`/dependencies/${dep.id}/status`, { status: 'rejected', reason: r });
      toast.success('Dependency rejected. The requester has been notified.');
      onSubmitted?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to reject.');
    } finally {
      setSaving(false);
    }
  }

  // Portal to body so the dialog escapes any nested stacking context
  // (e.g. when launched from inside the task modal).
  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5"
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-gray-800 flex items-center gap-2">
            <RotateCcw size={16} className="text-red-500" /> Reject dependency
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Tell the requester why you can't take this on. They'll get a notification and the parent task will stay blocked until they cancel or reassign.
        </p>
        <p className="text-sm font-medium text-gray-700 mb-2">"{dep.title}"</p>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g., I don't have access to the design system, please assign to someone on the design team."
          rows={4}
          className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400 resize-none"
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 rounded-lg">
            Cancel
          </button>
          <button onClick={submit} disabled={!reason.trim() || saving}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50">
            {saving
              ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <X size={14} />
            }
            Reject
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
