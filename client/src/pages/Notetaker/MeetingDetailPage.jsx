import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Calendar, Clock, Users, MessageSquare, Sparkles } from 'lucide-react';
import api from '../../services/api';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import Tabs from '../../components/common/Tabs';
import LetterAvatar from '../../components/common/LetterAvatar';
import EmptyState from '../../components/common/EmptyState';
import SidekickPanel from '../../components/sidekick/SidekickPanel';
import {
  formatAbsoluteMeeting, meetingDurationMinutes, formatDurationCompact,
} from './notetakerHelpers';
import OverviewTab from './OverviewTab';
import TranscriptTab from './TranscriptTab';
import ParticipantsTab from './ParticipantsTab';
import useMeetingTranscript from './useMeetingTranscript';

/**
 * MeetingDetailPage — `/notetaker/meetings/:id` (skill §6).
 *
 * Layout (≥1024px):
 *   ┌────────────────┬──────────────────┬─────────────────┐
 *   │  Overview /    │  (Reserved for   │   Scoped        │
 *   │  Transcript /  │   future video   │   Sidekick      │
 *   │  Participants  │   + topics)      │   panel         │
 *   └────────────────┴──────────────────┴─────────────────┘
 *
 * For now the MIDDLE column is intentionally minimal — the video player and
 * topic chips depend on data that doesn't exist yet (the meeting↔transcript
 * link is the blocker). The header carries date/duration/participants so the
 * page is informative even pre-transcript.
 *
 * Below 1024px the right column collapses behind a toggle ("Ask AI").
 */

export default function MeetingDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [meeting, setMeeting] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('overview');
  const [sidekickOpen, setSidekickOpen] = useState(false);

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    // GET /api/meetings/:id is the obvious endpoint, but the current router
    // only exposes /meetings/my and /meetings/team. We pull the user's
    // meeting list and find by id — a tiny inefficiency that lets the page
    // ship without a backend route addition. Easy swap later.
    api.get('/meetings/my')
      .then((res) => {
        if (cancelled) return;
        const list = res.data?.data?.meetings || res.data?.meetings || [];
        const found = list.find((m) => m.id === id);
        if (!found) {
          setError('Meeting not found or you do not have access.');
        } else {
          setMeeting(found);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        safeLog.error('[MeetingDetailPage] load error', err);
        setError(getErrorMessage(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const { segments, status: transcriptStatus } = useMeetingTranscript(id);

  const headerMeta = useMemo(() => {
    if (!meeting) return null;
    const duration = meetingDurationMinutes(meeting);
    const participantCount = Array.isArray(meeting.participants) ? meeting.participants.length : 0;
    return {
      whenLabel: formatAbsoluteMeeting(meeting) || '—',
      durationLabel: formatDurationCompact(duration),
      participantCount,
    };
  }, [meeting]);

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        <div className="h-8 w-72 bg-surface-100 rounded-md animate-pulse" />
        <div className="h-5 w-96 bg-surface-100 rounded-md animate-pulse" />
        <div className="h-40 bg-surface-100 rounded-md animate-pulse mt-6" />
      </div>
    );
  }

  if (error || !meeting) {
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load this meeting"
          description={error || 'The meeting may have been deleted or you may not have access.'}
          primaryAction={{ label: 'Back to Notetaker', onClick: () => navigate('/notetaker') }}
        />
      </div>
    );
  }

  const participants = Array.isArray(meeting.participants) ? meeting.participants : [];
  const visibleAvatars = participants.slice(0, 5);
  const overflowCount = Math.max(0, participants.length - visibleAvatars.length);

  return (
    <div className="flex flex-col h-full">
      <header
        className="px-6 pt-4 pb-3"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/notetaker')}
            aria-label="Back to Notetaker"
            className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100 hover:text-text-secondary"
          >
            <ArrowLeft size={16} />
          </button>
          <span
            className="w-7 h-7 rounded-md inline-flex items-center justify-center text-white flex-shrink-0"
            style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
          >
            <Sparkles size={13} />
          </span>
          <h1 className="text-lg font-bold text-text-primary truncate flex-1">
            {meeting.title || 'Untitled meeting'}
          </h1>
          <button
            type="button"
            onClick={() => setSidekickOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold bg-primary text-white hover:bg-primary-600 transition-colors"
          >
            <MessageSquare size={13} />
            Ask AI
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
          <span className="inline-flex items-center gap-1">
            <Calendar size={12} /> {headerMeta?.whenLabel}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock size={12} /> {headerMeta?.durationLabel}
          </span>
          {headerMeta?.participantCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <Users size={12} />
              {headerMeta.participantCount} {headerMeta.participantCount === 1 ? 'participant' : 'participants'}
            </span>
          )}
          <div className="flex items-center -space-x-1.5 ml-1">
            {visibleAvatars.map((p, i) => (
              <LetterAvatar
                key={p?.id || i}
                name={p?.name || p?.email || 'Unknown'}
                size="xs"
                shape="circle"
                className="ring-2 ring-white"
              />
            ))}
            {overflowCount > 0 && (
              <span className="w-5 h-5 rounded-full bg-surface-200 text-[9px] font-semibold text-text-secondary inline-flex items-center justify-center ring-2 ring-white">
                +{overflowCount}
              </span>
            )}
          </div>
        </div>

        <div className="mt-3">
          <Tabs.List ariaLabel="Meeting detail sections">
            <Tabs.Tab id="overview"     active={tab === 'overview'}     onSelect={setTab}>Overview</Tabs.Tab>
            <Tabs.Tab id="transcript"   active={tab === 'transcript'}   onSelect={setTab}>Transcript</Tabs.Tab>
            <Tabs.Tab id="participants" active={tab === 'participants'} onSelect={setTab}>Participants</Tabs.Tab>
          </Tabs.List>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {tab === 'overview' && (
          <OverviewTab meeting={meeting} transcriptStatus={transcriptStatus} />
        )}
        {tab === 'transcript' && (
          <TranscriptTab segments={segments} status={transcriptStatus} />
        )}
        {tab === 'participants' && (
          <ParticipantsTab meeting={meeting} segments={segments} transcriptStatus={transcriptStatus} />
        )}
      </div>

      {/* Scoped Sidekick — opens on demand from the "Ask AI" button. The
          scope prop tells useSidekickChat to attach `{scope:'meeting',scopeId}`
          to every send so the backend can rehydrate the right context once
          the per-meeting transcript endpoint exists. */}
      <SidekickPanel
        isOpen={sidekickOpen}
        onClose={() => setSidekickOpen(false)}
        scope="meeting"
        scopeId={meeting.id}
        scopeLabel="this meeting"
        pageContext={`Meeting: ${meeting.title || 'Untitled meeting'} on ${headerMeta?.whenLabel}`}
        pageState={{ route: `/notetaker/meetings/${meeting.id}`, meetingId: meeting.id }}
      />
    </div>
  );
}
