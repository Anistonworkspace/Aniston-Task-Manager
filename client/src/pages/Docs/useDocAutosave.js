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
export default function useDocAutosave({ docId, debounceMs = 1200, onSaved, onError, enabled = true } = {}) {
  const [status, setStatus] = useState('idle');
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [error, setError] = useState('');

  const pendingPatchRef = useRef({}); // latest pending fields
  const inflightRef = useRef(false);
  const timerRef = useRef(null);
  const onSavedRef = useRef(onSaved);
  const onErrorRef = useRef(onError);

  // Keep latest onSaved / onError without retriggering effects.
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

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

  // `throwOnError` lets `flush()` (Ctrl+S) bubble the failure to its caller
  // so the doc-page toast layer can render a precise "Couldn't save: …"
  // message. Scheduled (debounced) saves still swallow errors — the
  // onError callback + SaveIndicator pill cover those.
  const send = useCallback(async (throwOnError = false) => {
    if (!docId) return;
    if (inflightRef.current) {
      // A save is already running — let it finish; the timer or the
      // next scheduleSave will pick up any newer changes. For an
      // explicit flush (Ctrl+S) we wait for the in-flight to settle so
      // the caller's toast lines up with the real save state.
      if (throwOnError) {
        const start = Date.now();
        while (inflightRef.current && Date.now() - start < 10000) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 25));
        }
        if (Object.keys(pendingPatchRef.current).length === 0) return;
      } else {
        return;
      }
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
      const msg = getErrorMessage(err);
      setError(msg);
      setStatus('error');
      // Restore the patch so the caller can retry/flush. We re-merge in the
      // original order so any newer keystrokes that landed while the
      // request was in flight still win.
      pendingPatchRef.current = { ...patch, ...pendingPatchRef.current };
      try { onErrorRef.current?.(msg, err); } catch (_) { /* listener swallowed */ }
      if (throwOnError) throw err;
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
    // Ctrl+S path: re-throw so DocPage's keyboard handler renders an
    // error toast instead of a misleading "Saved" confirmation.
    await send(true);
  }, [send]);

  return { status, lastSavedAt, error, scheduleSave, flush };
}
