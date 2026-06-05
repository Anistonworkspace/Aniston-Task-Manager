/**
 * Time Planner design tokens + geometry helpers.
 *
 * Pastel palette per the redesign brief:
 *   - purple / lavender  → task work + focus
 *   - blue               → meetings / calendar
 *   - green              → admin / completed
 *   - gray               → neutral / unlinked / custom
 *   - red / amber        → conflict / overdue / missed
 *
 * Colors are applied as a soft tint (`<hex>` + alpha) over the white panel so
 * the same tokens read correctly in both light and dark themes (the text uses
 * the theme-adaptive `text-primary` var, never a baked color).
 */

import {
  Briefcase, Target, Users, Eye, CheckCircle2, Settings2, Coffee, Plane, Circle,
} from 'lucide-react';

// ── Grid geometry ───────────────────────────────────────────────────────
export const DAY_START_HOUR = 9;       // 09:00 — keep in sync with backend
export const DAY_END_HOUR = 21;        // 21:00
export const HOUR_PX = 60;             // pixels per hour
export const MIN_BLOCK_HEIGHT = 30;    // px, so short blocks stay legible
export const COLUMN_GAP = 3;           // px between side-by-side blocks
export const COLUMN_PADDING = 4;       // px inset on each day column

export const HOURS = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR + 1 }, (_, i) => i + DAY_START_HOUR);

export function timeToMinutes(t) {
  if (!t || typeof t !== 'string') return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTop(mins) {
  return ((mins - DAY_START_HOUR * 60) / 60) * HOUR_PX;
}

export function durationMinutes(start, end) {
  return Math.max(0, timeToMinutes(end) - timeToMinutes(start));
}

/**
 * Total occupied minutes for ONE day's blocks. Intervals are clamped to the
 * working window (09:00–21:00) so legacy/out-of-window blocks don't inflate the
 * total beyond what the grid shows, and overlapping intervals are merged so two
 * blocks never double-count (fixes the "+1h" planned bug).
 */
export function unionMinutesForDay(dayBlocks) {
  const WS = DAY_START_HOUR * 60;
  const WE = DAY_END_HOUR * 60;
  const ivs = dayBlocks
    .map((b) => [Math.max(WS, timeToMinutes(b.startTime)), Math.min(WE, timeToMinutes(b.endTime))])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0; let curS = null; let curE = null;
  for (const [s, e] of ivs) {
    if (curE === null) { curS = s; curE = e; }
    else if (s <= curE) { curE = Math.max(curE, e); }
    else { total += curE - curS; curS = s; curE = e; }
  }
  if (curE !== null) total += curE - curS;
  return total;
}

/** Planned minutes across a set of blocks (grouped by date, union per day). */
export function plannedMinutes(blocks) {
  const byDate = {};
  for (const b of blocks) { (byDate[b.date] = byDate[b.date] || []).push(b); }
  return Object.values(byDate).reduce((s, arr) => s + unionMinutesForDay(arr), 0);
}

/** "1h 30m" / "45m" from a minute count. */
export function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** "8 AM" / "12 PM" hour label. */
export function hourLabel(h) {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

// ── Block type → pastel style ────────────────────────────────────────────
export const TYPE_STYLES = {
  task_work: { hex: '#8b5cf6', label: 'Task Work', Icon: Briefcase },
  focus:     { hex: '#7c3aed', label: 'Focus Time', Icon: Target },
  meeting:   { hex: '#0073ea', label: 'Meeting', Icon: Users },
  review:    { hex: '#0ea5e9', label: 'Review', Icon: Eye },
  approval:  { hex: '#06b6d4', label: 'Approval', Icon: CheckCircle2 },
  admin:     { hex: '#00854d', label: 'Admin Work', Icon: Settings2 },
  break:     { hex: '#14b8a6', label: 'Break', Icon: Coffee },
  travel:    { hex: '#f59e0b', label: 'Travel', Icon: Plane },
  other:     { hex: '#64748b', label: 'Other', Icon: Circle },
};

export const TYPE_OPTIONS = Object.entries(TYPE_STYLES).map(([value, s]) => ({ value, label: s.label }));

export function typeStyle(type) {
  return TYPE_STYLES[type] || TYPE_STYLES.other;
}

// Teams / Microsoft calendar identity (kept from the original UI).
export const TEAMS_HEX = '#7b83eb';

// ── Per-block colour palette (must mirror server COLOR_PALETTE) ───────────
export const COLOR_PALETTE = [
  { hex: '#8b5cf6', label: 'Lavender' },
  { hex: '#0073ea', label: 'Blue' },
  { hex: '#00c875', label: 'Green' },
  { hex: '#fdab3d', label: 'Amber' },
  { hex: '#e2445c', label: 'Red' },
  { hex: '#a25ddc', label: 'Purple' },
  { hex: '#0ea5e9', label: 'Sky' },
  { hex: '#ff642e', label: 'Orange' },
  { hex: '#7b83eb', label: 'Indigo' },
  { hex: '#00a3a3', label: 'Teal' },
];
const PALETTE_HEXES = COLOR_PALETTE.map((c) => c.hex);

/** Pick a varied default colour (rotates by an index/seed). */
export function autoColor(seed = 0) {
  return PALETTE_HEXES[Math.abs(seed) % PALETTE_HEXES.length];
}

/** Effective accent for a block: explicit colour → else type colour. */
export function blockColor(b) {
  if (b && b.color && PALETTE_HEXES.includes(b.color)) return b.color;
  if (b && b.status === 'missed') return '#e2445c';
  return typeStyle(b && b.type).hex;
}

// ── Status chips ─────────────────────────────────────────────────────────
export const STATUS_STYLES = {
  planned:     { label: 'Planned', hex: '#64748b' },
  in_progress: { label: 'In Progress', hex: '#0073ea' },
  done:        { label: 'Done', hex: '#00854d' },
  missed:      { label: 'Missed', hex: '#d83a52' },
  rescheduled: { label: 'Rescheduled', hex: '#f59e0b' },
};
export const STATUS_OPTIONS = Object.entries(STATUS_STYLES).map(([value, s]) => ({ value, label: s.label }));
export function statusStyle(status) {
  return STATUS_STYLES[status] || STATUS_STYLES.planned;
}

// ── Priority ──────────────────────────────────────────────────────────────
export const PRIORITY_STYLES = {
  low:    { label: 'Low', hex: '#94a3b8' },
  normal: { label: 'Normal', hex: '#0073ea' },
  high:   { label: 'High', hex: '#f59e0b' },
  urgent: { label: 'Urgent', hex: '#d83a52' },
};
export const PRIORITY_OPTIONS = Object.entries(PRIORITY_STYLES).map(([value, s]) => ({ value, label: s.label }));
export function priorityStyle(priority) {
  return PRIORITY_STYLES[priority] || PRIORITY_STYLES.normal;
}

export const REMINDER_OPTIONS = [
  { value: '', label: 'No reminder' },
  { value: '5', label: '5 min before' },
  { value: '10', label: '10 min before' },
  { value: '15', label: '15 min before' },
  { value: '30', label: '30 min before' },
  { value: '60', label: '1 hour before' },
];

/** A block's display title regardless of legacy shape. */
export function blockTitle(b) {
  return (b && (b.title || (b.task && b.task.title) || b.description)) || 'Untitled block';
}

/**
 * Overlap layout for a list of {startTime,endTime} items. Returns a Map of
 * item → { col, totalCols } for side-by-side positioning of conflicts.
 */
export function computeOverlapLayout(items) {
  if (!items.length) return new Map();

  const sorted = [...items].sort((a, b) => {
    const aStart = timeToMinutes(a.startTime);
    const bStart = timeToMinutes(b.startTime);
    if (aStart !== bStart) return aStart - bStart;
    return durationMinutes(b.startTime, b.endTime) - durationMinutes(a.startTime, a.endTime);
  });

  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = timeToMinutes(sorted[0].endTime);
  for (let i = 1; i < sorted.length; i++) {
    const itemStart = timeToMinutes(sorted[i].startTime);
    if (itemStart < clusterEnd) {
      currentCluster.push(sorted[i]);
      clusterEnd = Math.max(clusterEnd, timeToMinutes(sorted[i].endTime));
    } else {
      clusters.push(currentCluster);
      currentCluster = [sorted[i]];
      clusterEnd = timeToMinutes(sorted[i].endTime);
    }
  }
  clusters.push(currentCluster);

  const layoutMap = new Map();
  for (const cluster of clusters) {
    const columns = [];
    for (const item of cluster) {
      const itemStart = timeToMinutes(item.startTime);
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (itemStart >= columns[c]) {
          columns[c] = timeToMinutes(item.endTime);
          layoutMap.set(item, { col: c, totalCols: 0 });
          placed = true;
          break;
        }
      }
      if (!placed) {
        layoutMap.set(item, { col: columns.length, totalCols: 0 });
        columns.push(timeToMinutes(item.endTime));
      }
    }
    const totalCols = columns.length;
    for (const item of cluster) layoutMap.get(item).totalCols = totalCols;
  }
  return layoutMap;
}

/** Horizontal position (%) of a block given its overlap layout slot. */
export function columnGeometry(layout) {
  const usableWidth = 100 - COLUMN_PADDING * 2;
  const leftPercent = COLUMN_PADDING + (layout.col * usableWidth) / layout.totalCols;
  const widthPercent = usableWidth / layout.totalCols - (layout.totalCols > 1 ? COLUMN_GAP / 2 : 0);
  return { leftPercent, widthPercent };
}
