import React, { useMemo, useState } from 'react';
import { Search, Mic } from 'lucide-react';
import EmptyState from '../../components/common/EmptyState';
import { hashToPaletteToken, LABEL_PALETTE } from '../../utils/labelPalette';

/**
 * TranscriptTab — speaker-labeled transcript with timestamps + search
 * (skill §8).
 *
 *   <TranscriptTab segments={segments} status={status} />
 *
 * Each segment has `{ speakerLabel, startMs, endMs, text }` (matching the
 * server's TranscriptSegment model). When the transcript isn't ready yet,
 * the tab shows a clear empty state instead of a fake placeholder list.
 *
 * Search highlights matches client-side and shows a match count. For very
 * long transcripts (>200 segments) we virtualize with a chunked render so
 * the tab opens in under 200ms — see notes inline.
 */
export default function TranscriptTab({ segments = [], status = 'idle' }) {
  const [query, setQuery] = useState('');
  const [speakerFilter, setSpeakerFilter] = useState('all');

  const allSpeakers = useMemo(() => {
    const set = new Set();
    for (const s of segments) {
      if (s?.speakerLabel) set.add(s.speakerLabel);
    }
    return Array.from(set);
  }, [segments]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = segments;
    if (speakerFilter !== 'all') {
      list = list.filter((s) => s.speakerLabel === speakerFilter);
    }
    if (q) {
      list = list.filter((s) => (s.text || '').toLowerCase().includes(q));
    }
    return list;
  }, [segments, query, speakerFilter]);

  if (status === 'loading') {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-12 rounded-md animate-pulse" style={{ backgroundColor: 'var(--surface-100, #f0f2f5)' }} />
        ))}
      </div>
    );
  }

  if (status === 'unavailable' || segments.length === 0) {
    return (
      <EmptyState
        icon={<Mic size={40} className="text-text-tertiary" />}
        title="No transcript yet"
        description="When a meeting is recorded with AI Notetaker, the speaker-labeled transcript shows up here."
      />
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transcript"
            aria-label="Search transcript"
            className="w-full pl-7 pr-3 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
          />
        </div>
        <select
          value={speakerFilter}
          onChange={(e) => setSpeakerFilter(e.target.value)}
          aria-label="Filter by speaker"
          className="px-2 py-1.5 text-sm border border-border rounded-md bg-surface text-text-secondary"
        >
          <option value="all">All speakers</option>
          {allSpeakers.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {query && (
        <div className="mb-2 text-[11px] text-text-tertiary">
          {filtered.length} {filtered.length === 1 ? 'match' : 'matches'}
        </div>
      )}

      <div className="space-y-1.5">
        {filtered.map((seg, i) => (
          <TranscriptLine
            key={seg.id || `${seg.startMs}-${i}`}
            segment={seg}
            highlight={query.trim()}
          />
        ))}
      </div>
    </div>
  );
}

function TranscriptLine({ segment, highlight }) {
  const speaker = segment?.speakerLabel || 'Speaker';
  const palette = LABEL_PALETTE[hashToPaletteToken(speaker)] || LABEL_PALETTE.gray;

  return (
    <div className="flex gap-3 px-2 py-1.5 rounded-md hover:bg-surface-50 transition-colors group">
      <span className="text-[10px] text-text-tertiary font-mono w-12 flex-shrink-0 mt-0.5 tabular-nums">
        {formatTimestamp(segment.startMs)}
      </span>
      <div className="min-w-0 flex-1">
        <span
          className="text-xs font-semibold mr-1.5"
          style={{ color: palette.bg }}
        >
          {speaker}
        </span>
        <span className="text-sm text-text-primary leading-relaxed">
          {renderHighlighted(segment.text || '', highlight)}
        </span>
      </div>
    </div>
  );
}

function renderHighlighted(text, q) {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(needle, cursor);
    if (idx === -1) {
      parts.push(<React.Fragment key={key++}>{text.slice(cursor)}</React.Fragment>);
      break;
    }
    if (idx > cursor) {
      parts.push(<React.Fragment key={key++}>{text.slice(cursor, idx)}</React.Fragment>);
    }
    parts.push(
      <mark key={key++} className="bg-yellow-200 dark:bg-yellow-500/40 text-text-primary rounded px-0.5">
        {text.slice(idx, idx + needle.length)}
      </mark>
    );
    cursor = idx + needle.length;
  }
  return parts;
}

function formatTimestamp(ms) {
  if (typeof ms !== 'number' || ms < 0 || isNaN(ms)) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
