import { useEffect, useState } from 'react';
import api from '../../services/api';
import safeLog from '../../utils/safeLog';

/**
 * useMeetingTranscript — best-effort transcript loader for the meeting detail
 * page.
 *
 *   const { segments, status, error } = useMeetingTranscript(meetingId);
 *
 * Today the backend doesn't expose a per-meeting transcript endpoint — the
 * Deepgram pipeline writes TranscriptSegment rows keyed by `noteId`, not
 * `meetingId`. We probe a future-shape endpoint and gracefully fall back to
 * an "unavailable" status so the UI can render an empty state honestly.
 *
 * When the backend slice lands, this hook is the only thing that needs to
 * change — the rest of the meeting detail UI stays untouched.
 *
 * Possible future endpoints (tried in order):
 *   GET /api/meetings/:id/transcript           (preferred)
 *   GET /api/notetaker/meetings/:id/transcript (alt)
 */

const ENDPOINTS_TO_TRY = (id) => [
  `/meetings/${id}/transcript`,
  `/notetaker/meetings/${id}/transcript`,
];

export default function useMeetingTranscript(meetingId) {
  const [segments, setSegments] = useState([]);
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'unavailable' | 'error'
  const [error, setError] = useState('');

  useEffect(() => {
    if (!meetingId) {
      setStatus('idle');
      return undefined;
    }
    let cancelled = false;

    async function tryEndpoints() {
      setStatus('loading');
      setError('');
      for (const url of ENDPOINTS_TO_TRY(meetingId)) {
        try {
          const res = await api.get(url, { _silent: true });
          if (cancelled) return;
          const data = res.data?.data || res.data || {};
          const segs = data.segments || data.transcript || [];
          if (Array.isArray(segs)) {
            setSegments(segs);
            setStatus('ok');
            return;
          }
        } catch (err) {
          // 404 → try the next URL. Anything else → log and keep trying.
          if (err?.response?.status !== 404) {
            safeLog.warn('[useMeetingTranscript] non-404 error from endpoint', { url, err });
          }
        }
      }
      if (cancelled) return;
      setStatus('unavailable');
    }

    tryEndpoints();
    return () => { cancelled = true; };
  }, [meetingId]);

  return { segments, status, error };
}
