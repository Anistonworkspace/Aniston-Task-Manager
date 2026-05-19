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
 * NotetakerPage — `/notetaker` landing surface.
 *
 * Always renders the populated layout (header + Recent recordings +
 * upcoming grid + tabs). Each sub-section owns its own empty state, so
 * a brand-new user with zero meetings still sees their saved voice
 * notes via RecentRecordings, and a compact orientation banner that
 * surfaces the "Record meeting" CTA + the calendar-coming-soon notice.
 *
 * Previously this page short-circuited into a full-screen hero when
 * there were no meetings and no calendar connection. That hid saved
 * voice notes from any user without a connected calendar (i.e. every
 * local-dev account) and made it look like recordings were being lost.
 * Both UIs (local + production) now match because the branchy hero is
 * gone.
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

  // First-time orientation banner: shown only when the page has no
  // meetings AND no calendar connected. Replaces the full-screen hero
  // (which hid RecentRecordings — a saved voice note would not appear
  // on this page until the user got at least one calendar meeting). The
  // banner sits inside the populated layout so saved recordings are
  // always visible below it. Note: doesn't gate on recordings count —
  // a brand-new user gets the orientation copy even after their first
  // recording, which is fine because the banner remains useful (it's
  // also where the calendar-coming-soon notice lives) until they have
  // at least one meeting on file.
  const showFirstRunBanner = !loading && !error && meetings.length === 0 && !calendarConnected;

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
        {/* First-run orientation banner — surfaces the "Record meeting"
            CTA and the calendar-coming-soon notice for users without
            any meetings or a connected calendar. Sits ABOVE the recent
            recordings list so saved notes are never hidden behind it. */}
        {showFirstRunBanner && (
          <section className="mb-6 rounded-lg border border-border bg-surface/60 px-4 py-4">
            <div className="flex items-start gap-3">
              <span
                className="w-10 h-10 rounded-lg inline-flex items-center justify-center text-white flex-shrink-0"
                style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
              >
                <Mic size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold text-text-primary">
                  Let AI take meeting notes for you
                </h2>
                <p className="mt-1 text-xs text-text-secondary">
                  Hit record now, or connect your calendar to automatically capture
                  meeting notes and action items.{' '}
                  <span className="text-text-tertiary">
                    Auto-record from calendar is coming in a future release — for now,
                    use <span className="font-semibold text-text-secondary">Record meeting</span> above
                    whenever you're in a meeting.
                  </span>
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleStartRecording}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-semibold hover:bg-primary-600 transition-colors"
                  >
                    <Mic size={13} /> Start recording now
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/meetings')}
                    className="text-xs text-primary hover:underline"
                  >
                    Open the classic Meetings view
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

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
