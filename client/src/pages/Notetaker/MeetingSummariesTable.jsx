import React, { useMemo, useState } from 'react';
import { Search, Bug, ChevronDown, MoreHorizontal } from 'lucide-react';
import LetterAvatar from '../../components/common/LetterAvatar';
import StatusPill from '../../components/common/StatusPill';
import EmptyState from '../../components/common/EmptyState';
import {
  formatAbsoluteMeeting, meetingDurationMinutes, formatDurationCompact,
  getRecordingStatus, recordingStatusLabel, recordingStatusColor, isPastMeeting,
} from './notetakerHelpers';

/**
 * MeetingSummariesTable — past meetings list (skill §4).
 *
 *   <MeetingSummariesTable
 *     meetings={meetings}
 *     loading={loading}
 *     onOpen={(meeting) => navigate(...)}
 *     showDebug={isAdmin}
 *   />
 *
 * The "Upcoming meetings" tab uses the same table with a different filter,
 * provided via the `view` prop.
 */
export default function MeetingSummariesTable({
  meetings = [],
  loading = false,
  onOpen,
  onOpenDebug,
  showDebug = false,
  view = 'past', // 'past' | 'upcoming'
  emptyTitle,
  emptyDescription,
}) {
  const [query, setQuery] = useState('');
  const [recordedFilter, setRecordedFilter] = useState('all'); // 'all' | 'recorded' | 'not_recorded'

  const rows = useMemo(() => {
    let list = meetings;
    if (view === 'past') {
      list = list.filter((m) => isPastMeeting(m));
    } else {
      list = list.filter((m) => !isPastMeeting(m));
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((m) => {
        const title = (m.title || '').toLowerCase();
        const participantsMatch = Array.isArray(m.participants)
          && m.participants.some((p) => (p?.name || '').toLowerCase().includes(q));
        return title.includes(q) || participantsMatch;
      });
    }
    if (recordedFilter !== 'all') {
      list = list.filter((m) => getRecordingStatus(m) === recordedFilter);
    }
    // Past: newest first. Upcoming: soonest first.
    return [...list].sort((a, b) => {
      const ta = new Date(`${a.date || 0}T${a.startTime || '00:00'}`).getTime();
      const tb = new Date(`${b.date || 0}T${b.startTime || '00:00'}`).getTime();
      return view === 'past' ? tb - ta : ta - tb;
    });
  }, [meetings, query, recordedFilter, view]);

  if (loading) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-12 rounded-md animate-pulse" style={{ backgroundColor: 'var(--surface-100, #f0f2f5)' }} />
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Filter row */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by meeting title or participant"
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
          />
        </div>
        <select
          value={recordedFilter}
          onChange={(e) => setRecordedFilter(e.target.value)}
          aria-label="Filter by recording status"
          className="px-2.5 py-1.5 text-sm border border-border rounded-md bg-surface text-text-secondary"
        >
          <option value="all">All meetings</option>
          <option value="recorded">Recorded only</option>
          <option value="not_recorded">Not recorded</option>
        </select>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          compact
          title={emptyTitle || (view === 'past' ? 'No meeting summaries yet' : 'No upcoming meetings')}
          description={emptyDescription || (view === 'past'
            ? 'Past meetings with recordings will appear here.'
            : 'When you have an upcoming meeting it will show up here.')}
        />
      ) : (
        <div className="rounded-md border border-border-light overflow-hidden">
          <div
            className={`grid items-center px-3 py-2 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary bg-surface-50 border-b border-border-light`}
            style={{ gridTemplateColumns: showDebug ? '1fr 32px 120px 160px 80px 120px' : '1fr 120px 160px 80px 120px' }}
          >
            <span>Meeting</span>
            {showDebug && <span className="text-center">Debug</span>}
            <span>Participants</span>
            <span>Date</span>
            <span>Duration</span>
            <span>Status</span>
          </div>

          {rows.map((m, i) => {
            const status = getRecordingStatus(m);
            const duration = meetingDurationMinutes(m);
            const participants = Array.isArray(m.participants) ? m.participants : [];
            const visible = participants.slice(0, 3);
            const overflow = Math.max(0, participants.length - visible.length);

            return (
              <button
                key={m.id || i}
                type="button"
                onClick={() => onOpen?.(m)}
                className={`w-full grid items-center px-3 py-2.5 text-left hover:bg-surface-50 transition-colors ${
                  i > 0 ? 'border-t border-border-light' : ''
                }`}
                style={{ gridTemplateColumns: showDebug ? '1fr 32px 120px 160px 80px 120px' : '1fr 120px 160px 80px 120px' }}
              >
                <div className="min-w-0 pr-3">
                  <div className="text-sm font-semibold text-text-primary truncate">{m.title || 'Untitled meeting'}</div>
                  {m.location && (
                    <div className="text-xs text-text-tertiary truncate">{m.location}</div>
                  )}
                </div>

                {showDebug && (
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); onOpenDebug?.(m); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        onOpenDebug?.(m);
                      }
                    }}
                    aria-label="Debug meeting"
                    className="justify-self-center w-7 h-7 inline-flex items-center justify-center rounded text-text-tertiary hover:bg-surface-100 cursor-pointer"
                  >
                    <Bug size={12} />
                  </div>
                )}

                <div className="flex items-center -space-x-1.5">
                  {visible.map((p, idx) => (
                    <LetterAvatar
                      key={p?.id || idx}
                      name={p?.name || p?.email || 'Unknown'}
                      size="xs"
                      shape="circle"
                      className="ring-2 ring-white"
                    />
                  ))}
                  {overflow > 0 && (
                    <span className="w-5 h-5 rounded-full bg-surface-200 text-[9px] font-semibold text-text-secondary inline-flex items-center justify-center ring-2 ring-white">
                      +{overflow}
                    </span>
                  )}
                </div>

                <div className="text-xs text-text-secondary truncate">
                  {formatAbsoluteMeeting(m) || '—'}
                </div>

                <div className="text-xs text-text-secondary">
                  {formatDurationCompact(duration)}
                </div>

                <div>
                  <StatusPill
                    color={recordingStatusColor(status)}
                    label={recordingStatusLabel(status)}
                    variant="outlined"
                    size="compact"
                  />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
