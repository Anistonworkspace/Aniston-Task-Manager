import React, { useMemo } from 'react';
import { Users } from 'lucide-react';
import LetterAvatar from '../../components/common/LetterAvatar';
import EmptyState from '../../components/common/EmptyState';
import { hashToPaletteToken, LABEL_PALETTE } from '../../utils/labelPalette';

/**
 * ParticipantsTab — speaker-by-speaker analytics on the meeting detail page
 * (skill §9).
 *
 *   <ParticipantsTab
 *     meeting={meeting}
 *     segments={transcriptSegments}
 *     transcriptStatus={status}
 *   />
 *
 * When transcript segments are available, this tab computes talk-time per
 * speaker (sum of segment durations) and renders:
 *   - A horizontal stacked bar of speaker shares.
 *   - A sortable list of speakers with duration + share %.
 *
 * When no transcript exists, it falls back to a participant roster derived
 * from `meeting.participants` so the tab is still useful.
 */
export default function ParticipantsTab({ meeting, segments = [], transcriptStatus = 'idle' }) {
  const speakerStats = useMemo(() => computeSpeakerStats(segments), [segments]);

  if (speakerStats.totalMs === 0) {
    return <ParticipantsRoster meeting={meeting} transcriptStatus={transcriptStatus} />;
  }

  return (
    <div>
      <h3 className="text-base font-semibold text-text-primary mb-3">Talking time</h3>

      <div className="rounded-md overflow-hidden flex h-6 mb-3">
        {speakerStats.rows.map((r) => (
          <div
            key={r.speaker}
            title={`${r.speaker} — ${formatDuration(r.totalMs)} (${r.share.toFixed(1)}%)`}
            style={{
              width: `${r.share}%`,
              backgroundColor: r.color,
            }}
          />
        ))}
      </div>

      <ul className="space-y-1">
        {speakerStats.rows.map((r) => (
          <li
            key={r.speaker}
            className="grid items-center gap-3 px-3 py-2 rounded-md hover:bg-surface-50 transition-colors"
            style={{ gridTemplateColumns: '12px 1fr 120px 80px' }}
          >
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: r.color }} aria-hidden="true" />
            <span className="text-sm font-semibold text-text-primary truncate">{r.speaker}</span>
            <span className="text-sm text-text-secondary">{formatDuration(r.totalMs)}</span>
            <span className="text-sm font-semibold text-text-primary text-right">{r.share.toFixed(2)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ParticipantsRoster({ meeting, transcriptStatus }) {
  const participants = Array.isArray(meeting?.participants) ? meeting.participants : [];

  if (participants.length === 0) {
    return (
      <EmptyState
        icon={<Users size={40} className="text-text-tertiary" />}
        title="No participants on this meeting"
      />
    );
  }

  return (
    <div>
      <h3 className="text-base font-semibold text-text-primary mb-1">Participants</h3>
      {transcriptStatus === 'unavailable' && (
        <p className="text-xs text-text-tertiary mb-3">
          Talking-time analytics will appear here once this meeting is recorded.
        </p>
      )}
      <ul className="space-y-1">
        {participants.map((p, i) => (
          <li
            key={p?.id || i}
            className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-surface-50 transition-colors"
          >
            <LetterAvatar name={p?.name || p?.email || 'Unknown'} size="sm" shape="circle" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-text-primary truncate">
                {p?.name || 'Unknown'}
              </div>
              {p?.email && (
                <div className="text-xs text-text-tertiary truncate">{p.email}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function computeSpeakerStats(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { totalMs: 0, rows: [] };
  }
  const totals = new Map();
  for (const seg of segments) {
    const speaker = seg?.speakerLabel || 'Speaker';
    const start = Number(seg?.startMs) || 0;
    const end = Number(seg?.endMs) || start;
    const span = Math.max(0, end - start);
    totals.set(speaker, (totals.get(speaker) || 0) + span);
  }
  const totalMs = Array.from(totals.values()).reduce((a, b) => a + b, 0);
  const rows = Array.from(totals.entries())
    .map(([speaker, ms]) => ({
      speaker,
      totalMs: ms,
      share: totalMs > 0 ? (ms / totalMs) * 100 : 0,
      color: LABEL_PALETTE[hashToPaletteToken(speaker)]?.bg || '#94a3b8',
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
  return { totalMs, rows };
}

function formatDuration(ms) {
  const totalSec = Math.floor((ms || 0) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
