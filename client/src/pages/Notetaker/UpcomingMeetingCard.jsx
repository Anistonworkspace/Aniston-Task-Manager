import React from 'react';
import { Link, Calendar, UserCheck, AlertCircle, Bug } from 'lucide-react';
import LetterAvatar from '../../components/common/LetterAvatar';
import {
  formatRelativeMeeting, formatAbsoluteMeeting, isUpcomingMeeting,
} from './notetakerHelpers';

/**
 * UpcomingMeetingCard — single card in the Upcoming grid (skill §3.4).
 *
 *   <UpcomingMeetingCard
 *     meeting={meeting}
 *     onInviteNotetaker={() => ...}
 *     onClick={() => ...}
 *     showDebug={isAdmin}
 *   />
 *
 * Pure presentation — the consumer wires invite + click.
 */
export default function UpcomingMeetingCard({
  meeting,
  onInviteNotetaker,
  onOpenDebug,
  onClick,
  showDebug = false,
}) {
  if (!meeting) return null;
  const relative = formatRelativeMeeting(meeting);
  const absolute = formatAbsoluteMeeting(meeting);
  const isLive = relative === 'Live now';
  const participants = Array.isArray(meeting.participants) ? meeting.participants : [];
  const visibleAvatars = participants.slice(0, 3);
  const overflow = Math.max(0, participants.length - visibleAvatars.length);
  const notetakerInvited = !!meeting.notetakerInvited;

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left w-full p-4 rounded-md border bg-surface hover:border-primary-300 transition-colors"
      style={{ borderColor: 'var(--layout-border-color, #e2e2e2)' }}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
        {isLive && (
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />
        )}
        <span>{isLive ? 'Now' : relative}</span>
        <span className="text-text-tertiary">·</span>
        <span>{absolute}</span>
      </div>

      <div className="mt-1.5 text-sm font-semibold text-text-primary line-clamp-2">
        {meeting.title || 'Untitled meeting'}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {meeting.meetingUrl ? (
            <a
              href={meeting.meetingUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Link size={11} />
              Meeting link
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-text-tertiary">
              <Calendar size={11} />
              No link
            </span>
          )}

          {!notetakerInvited && onInviteNotetaker && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onInviteNotetaker(meeting); }}
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              + Invite notetaker
            </button>
          )}
          {notetakerInvited && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
              <UserCheck size={11} /> Notetaker invited
            </span>
          )}

          {showDebug && onOpenDebug && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenDebug(meeting); }}
              aria-label="Debug meeting"
              className="ml-1 p-0.5 rounded text-text-tertiary hover:bg-surface-100"
            >
              <Bug size={11} />
            </button>
          )}
        </div>

        <div className="flex items-center -space-x-1.5">
          {visibleAvatars.map((p, i) => (
            <LetterAvatar
              key={p?.id || i}
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
      </div>
    </button>
  );
}
