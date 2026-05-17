import { useCallback, useEffect, useRef, useState } from 'react';
import { updateDoc } from '../../services/docsService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';

/**
 * useDocAutosave (Doc Editor Phase B) — debounced PATCH for doc edits.
 *
 *   const { status, lastSavedAt, error, scheduleSave, flush } = useDocAutosave({
 *     docId,
 *     debounceMs: 1200,
 *     onSaved: (doc) => setDoc(doc),
 *   });
 *
 *   // From the editor's onUpdate:
 *   scheduleSave({ contentJson });
 *   // Title rename — bypass debounce:
 *   flush({ title: newTitle });
 *
 * Status values:
 *   'idle'   — no save in flight, no pending changes
 *   'dirty'  — there are unsaved changes (debounce timer running)
 *   'saving' — request in flight
 *   'saved'  — last save succeeded
 *   'error'  — last save failed (callers should surface `error`)
 *
 * The hook coalesces consecutive scheduleSave({...}) calls — Tiptap fires
 * onUpdate on every keystroke, so without coalescing we'd hammer the
 * backend. The latest patch wins; intermediate patches are discarded.
 */
export default function useDocAutosave({ docId, debounceMs = 1200, onSaved, enabled = true } = {}) {
  const [status, setStatus] = useState('idle');
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [error, setError] = useState('');

  const pendingPatchRef = useRef({}); // latest pending fields
  const inflightRef = useRef(false);
  const timerRef = useRef(null);
  const onSavedRef = useRef(onSaved);

  // Keep latest onSaved without retriggering effects.
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  // Cancel any pending timer on unmount AND attempt one final flush so a
  // user navigating away mid-edit doesn't lose 1-2s of typing.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const hasPending = Object.keys(pendingPatchRef.current).length > 0;
      if (hasPending && docId) {
        // Fire-and-forget. The component is unmounting; we can't update
        // state but the network request still goes out.
        updateDoc(docId, pendingPatchRef.current).catch((e) => {
          safeLog.warn('[useDocAutosave] flush-on-unmount failed', e);
        });
      }
    };
  }, [docId]);

  const send = useCallback(async () => {
    if (!docId) return;
    if (inflightRef.current) {
      // A save is already running — let it finish; the timer or the
      // next scheduleSave will pick up any newer changes.
      return;
    }
    const patch = pendingPatchRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingPatchRef.current = {};
    inflightRef.current = true;
    setStatus('saving');
    setError('');
    try {
      const { doc } = await updateDoc(docId, patch);
      setStatus('saved');
      setLastSavedAt(new Date());
      onSavedRef.current?.(doc);
      // If more changes accumulated while the save was in flight, kick
      // another debounce cycle so we don't drop them.
      if (Object.keys(pendingPatchRef.current).length > 0) {
        timerRef.current = setTimeout(() => {
          if (Object.keys(pendingPatchRef.current).length > 0) {
            setStatus('dirty');
            send();
          }
        }, 50);
      }
    } catch (err) {
      safeLog.error('[useDocAutosave] save failed', err);
      setError(getErrorMessage(err));
      setStatus('error');
      // Restore the patch so the caller can retry/flush.
      pendingPatchRef.current = { ...patch, ...pendingPatchRef.current };
    } finally {
      inflightRef.current = false;
    }
  }, [docId]);

  const scheduleSave = useCallback((patch) => {
    if (!patch || typeof patch !== 'object') return;
    if (!docId) return;
    // Phase G — silently drop scheduled saves when collab owns the doc.
    // We don't even mark `dirty` because the collab pill is the source
    // of truth for "is my work being persisted" in that mode.
    if (!enabled) return;
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    setStatus('dirty');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(send, debounceMs);
  }, [docId, debounceMs, send, enabled]);

  const flush = useCallback(async (patch) => {
    if (patch) {
      pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await send();
  }, [send]);

  return { status, lastSavedAt, error, scheduleSave, flush };
}
