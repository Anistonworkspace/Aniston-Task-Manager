import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Clock, ChevronRight, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import api from '../../services/api';
import safeLog from '../../utils/safeLog';

/**
 * RecentRecordings — Notetaker companion list.
 *
 * Shows the user's own voice notes (transcripts) so a recording made from
 * this page has a visible home and you can re-open one to summarize /
 * extract actions again later. Today we reuse the existing /api/notes/my
 * endpoint (filter client-side for type='voice_note') because:
 *
 *   1. Voice notes ARE notes — Notes table already stores them with
 *      `type='voice_note'`, `content`, `duration`. No new schema needed.
 *   2. Listening on a new event ('notes:changed' dispatched by VoiceNotes
 *      on save) means the list auto-refreshes when the user finishes a
 *      recording from anywhere in the app.
 *
 * If the list is empty we render a compact zero-state with a tip rather
 * than the loud full-page hero in the parent — the parent already shows
 * its own primary CTA.
 */
export default function RecentRecordings({ limit = 6 }) {
  const navigate = useNavigate();
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/notes/my');
      const list = res?.data?.data?.notes || res?.data?.notes || [];
      // Filter to voice notes only (type default is 'voice_note' on the
      // backend but defensive in case of mixed types).
      const voiceNotes = list
        .filter((n) => !n.type || n.type === 'voice_note')
        .slice(0, limit);
      setNotes(voiceNotes);
    } catch (err) {
      safeLog.warn('[RecentRecordings] load error', err);
      setError('Could not load recordings.');
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { load(); }, [load]);

  // VoiceNotes dispatches `notes:changed` after a successful save so any
  // open list stays in sync without manual refresh. (Same hook NotesPage
  // and the VoiceNotes panel use to coordinate.)
  useEffect(() => {
    function onChanged() { load(); }
    window.addEventListener('notes:changed', onChanged);
    return () => window.removeEventListener('notes:changed', onChanged);
  }, [load]);

  if (loading) {
    return (
      <section className="mb-6">
        <div className="text-[11px] uppercase tracking-wide font-semibold text-text-tertiary mb-2">
          Recent recordings
        </div>
        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          <Loader2 size={12} className="animate-spin" /> Loading recordings…
        </div>
      </section>
    );
  }

  if (error) {
    return null; // Silent fail — primary page experience isn't gated on this.
  }

  if (notes.length === 0) {
    return (
      <section className="mb-6">
        <div className="text-[11px] uppercase tracking-wide font-semibold text-text-tertiary mb-2">
          Recent recordings
        </div>
        <div
          className="rounded-md border border-dashed border-border bg-surface/40 px-4 py-3 text-[12px] text-text-tertiary inline-flex items-center gap-2"
        >
          <Mic size={13} />
          No recordings yet. Hit <strong className="text-text-secondary">Record meeting</strong> above to make your first.
        </div>
      </section>
    );
  }

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wide font-semibold text-text-tertiary">
          Recent recordings
        </div>
        <button
          type="button"
          onClick={() => navigate('/notes')}
          className="text-[11px] text-primary hover:underline inline-flex items-center gap-0.5"
        >
          View all <ChevronRight size={11} />
        </button>
      </div>
      <ul className="space-y-1.5">
        {notes.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => navigate(`/notes?focus=${n.id}`)}
              className="w-full flex items-start gap-2.5 rounded-md border border-border bg-surface px-3 py-2 hover:border-primary-300 hover:bg-surface-50 transition-colors text-left"
            >
              <span
                className="w-7 h-7 rounded-md inline-flex items-center justify-center flex-shrink-0 text-white"
                style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
              >
                <Mic size={13} />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-text-primary truncate">
                  {n.title || 'Untitled recording'}
                </div>
                <div className="text-[11px] text-text-tertiary truncate">
                  {(n.content || '').slice(0, 140) || 'No transcript captured.'}
                </div>
              </div>
              <div className="flex flex-col items-end gap-0.5 flex-shrink-0 text-[10px] text-text-tertiary">
                <span>
                  {n.createdAt
                    ? formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })
                    : '—'}
                </span>
                {n.duration > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <Clock size={10} /> {formatDuration(n.duration)}
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
