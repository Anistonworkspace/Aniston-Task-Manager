import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Settings, CalendarDays, Mic } from 'lucide-react';
import api from '../../services/api';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../components/common/Toast';
import Tabs from '../../components/common/Tabs';
import EmptyState from '../../components/common/EmptyState';
import UpcomingMeetingCard from './UpcomingMeetingCard';
import MeetingSummariesTable from './MeetingSummariesTable';
import NotetakerSettingsModal from './NotetakerSettingsModal';
import RecentRecordings from './RecentRecordings';
import { isUpcomingMeeting } from './notetakerHelpers';
import useRealtimeQuery from '../../realtime/useRealtimeQuery';

/**
 * NotetakerPage — `/notetaker` landing surface (skill §§1–4).
 *
 * Two states:
 *   - Empty: user has no connected calendar AND no meetings → hero CTA.
 *   - Populated: upcoming card grid + tabbed summaries table.
 *
 * Sits alongside the existing /meetings list view; both pull from
 * GET /api/meetings/my so they stay coherent. The new page adds:
 *   - The "Recorded" status column (data placeholder until backend ships)
 *   - The 4-up upcoming card grid
 *   - The Personal preferences + Connected calendars settings modal
 *
 * Calendar OAuth (Google + Outlook) is gated by a backend endpoint that
 * doesn't exist yet — the "Connect Google Calendar" / "Connect Outlook"
 * buttons in the empty state surface a Toast for now and skip the OAuth
 * round-trip. Wiring those endpoints is a separate slice.
 */

const CALENDAR_OAUTH_NOT_READY_MESSAGE = (
  'Calendar OAuth is not wired up in this build yet — the backend endpoint '
  + 'lands in the next slice. Until then, schedule meetings via the existing '
  + 'Meetings tab or your provider directly.'
);

export default function NotetakerPage() {
  // isSuperAdmin / isAdmin were previously passed down as `showDebug` to
  // UpcomingMeetingCard + MeetingSummariesTable, which added a Debug
  // column + icon for tier-1/2 users only. Users on other tiers
  // legitimately complained the Notetaker UI "looked different" between
  // roles. The debug surface was a dev affordance, not a real feature —
  // we now hide it everywhere so every tier sees the same UI.
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('summaries');
  const [showSettings, setShowSettings] = useState(false);
  const [calendarConnected, setCalendarConnected] = useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/meetings/my');
      const data = res.data?.data?.meetings || res.data?.meetings || [];
      setMeetings(Array.isArray(data) ? data : []);
    } catch (err) {
      safeLog.error('[NotetakerPage] load error', err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Keep in sync with realtime events emitted for the existing MeetingsPage.
  useRealtimeQuery({ queryKey: 'meetings.my', refetch: load });

  const upcoming = useMemo(() => meetings.filter(isUpcomingMeeting).slice(0, 6), [meetings]);

  function handleOpenMeeting(meeting) {
    if (!meeting?.id) return;
    navigate(`/notetaker/meetings/${meeting.id}`);
  }

  function handleInviteNotetaker() {
    // Real flow: POST to /api/notetaker/meetings/:id/invite. Until that
    // endpoint exists, surface the same advisory message the empty-state
    // CTAs use so we don't pretend the bot was actually invited.
    toast.info('Notetaker bot invite is part of the next slice — calendar OAuth + bot enrollment land together.');
  }

  function handleConnectCalendar(provider) {
    safeLog.info('[NotetakerPage] connect calendar requested', { provider });
    toast.info(CALENDAR_OAUTH_NOT_READY_MESSAGE);
  }

  // Open the existing floating VoiceNotes recorder pre-configured for
  // multi-speaker meeting capture. The Layout listens for this event and
  // flips highAccuracyMode on its own state so we don't have to lift the
  // panel into a context just for one affordance.
  function handleStartRecording() {
    window.dispatchEvent(new CustomEvent('open-voice-notes', {
      detail: { meetingMode: true },
    }));
  }

  // Empty state — only shown when there are absolutely no meetings AND
  // calendar isn't connected. Otherwise we show the regular populated layout.
  const isFullyEmpty = !loading && !error && meetings.length === 0 && !calendarConnected;

  if (isFullyEmpty) {
    return (
      <div className="h-full flex items-center justify-center px-6 py-12">
        <div className="max-w-xl w-full text-center">
          <div className="mx-auto w-20 h-20 rounded-2xl inline-flex items-center justify-center mb-5 text-white"
            style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
          >
            <Mic size={28} />
          </div>
          <h1 className="text-2xl font-bold text-text-primary">
            Let AI take meeting notes for you
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            Hit record now, or connect your calendar to automatically capture meeting
            notes and action items, seamlessly integrated into your workflow.
          </p>

          {/* Primary CTA — start recording immediately. Multi-speaker
              Deepgram pipeline is already configured; this just opens the
              floating recorder pre-flipped to Meeting Mode. */}
          <div className="mt-6">
            <button
              type="button"
              onClick={handleStartRecording}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-3 rounded-md bg-primary text-white text-sm font-semibold hover:bg-primary-600 transition-colors shadow"
            >
              <Mic size={16} /> Start recording now
            </button>
            <p className="mt-2 text-[11px] text-text-tertiary">
              Opens the recorder in multi-speaker meeting mode. Works on phone or laptop.
            </p>
          </div>

          {/* Calendar OAuth — flagged as theater in the May-17 audit:
              backend endpoints don't exist yet so clicks only fire a toast.
              Replaced with a clearly-labeled "coming soon" notice so users
              don't waste a click. When the OAuth slice lands, restore the
              buttons + delete this notice. The grid stays so the layout
              doesn't reflow when we add it back. */}
          <div className="mt-6 rounded-md border-2 border-dashed border-border bg-surface/40 px-4 py-3 text-[12px] text-text-tertiary text-center">
            <span className="font-semibold text-text-secondary">Auto-record from calendar</span>
            {' — '}coming in a future release.
            For now, use{' '}
            <span className="font-semibold text-text-secondary">Start recording now</span>
            {' '}above whenever you're in a meeting.
          </div>

          <p className="mt-6 text-xs text-text-tertiary">
            Already have meetings in Aniston?{' '}
            <button
              type="button"
              onClick={() => navigate('/meetings')}
              className="text-primary hover:underline"
            >
              Open the classic Meetings view
            </button>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-6 pt-5 pb-4"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <span
          className="w-9 h-9 rounded-lg inline-flex items-center justify-center text-white"
          style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
        >
          <Sparkles size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold text-text-primary truncate">AI Notetaker</h1>
          <p className="text-xs text-text-tertiary">
            Automatic notes, transcripts, and summaries from your calendar meetings.
          </p>
        </div>
        <button
          type="button"
          onClick={handleStartRecording}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold text-white bg-primary hover:bg-primary-600 transition-colors shadow-sm"
          title="Open the recorder in multi-speaker meeting mode"
        >
          <Mic size={14} /> Record meeting
        </button>
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-text-secondary border border-border bg-surface hover:border-primary-300 hover:text-primary"
        >
          <Settings size={14} /> Settings
        </button>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {/* Recordings the user has made from anywhere in the app. Auto-
            refreshes via the 'notes:changed' event VoiceNotes dispatches. */}
        <RecentRecordings />

        {/* Upcoming card grid */}
        {upcoming.length > 0 && (
          <section className="mb-6">
            <div className="text-[11px] uppercase tracking-wide font-semibold text-text-tertiary mb-2">
              Upcoming
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {upcoming.map((m) => (
                <UpcomingMeetingCard
                  key={m.id}
                  meeting={m}
                  onClick={() => handleOpenMeeting(m)}
                  onInviteNotetaker={handleInviteNotetaker}
                  showDebug={false}
                />
              ))}
            </div>
          </section>
        )}

        {/* Tabs + table */}
        <section>
          <div
            className="flex items-center gap-2 mb-3"
            style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
          >
            <Tabs.List ariaLabel="Notetaker views">
              <Tabs.Tab id="summaries" active={tab === 'summaries'} onSelect={setTab}>
                Meeting summaries
              </Tabs.Tab>
              <Tabs.Tab id="upcoming" active={tab === 'upcoming'} onSelect={setTab}>
                Upcoming meetings
              </Tabs.Tab>
            </Tabs.List>
          </div>

          {error && (
            <div className="mb-3 p-3 rounded-md bg-red-50 text-red-700 text-sm">
              {error}
            </div>
          )}

          <MeetingSummariesTable
            meetings={meetings}
            loading={loading}
            onOpen={handleOpenMeeting}
            showDebug={false}
            view={tab === 'upcoming' ? 'upcoming' : 'past'}
          />
        </section>
      </div>

      <NotetakerSettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        calendarConnected={calendarConnected}
        onConnectCalendar={handleConnectCalendar}
        onDisconnectCalendar={(p) => {
          safeLog.info('[NotetakerPage] disconnect calendar', { provider: p });
          toast.info('Calendar disconnect ships with the OAuth slice.');
        }}
      />
    </div>
  );
}
