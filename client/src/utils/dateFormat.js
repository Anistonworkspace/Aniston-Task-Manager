import { format, parseISO, isValid } from 'date-fns';

// Centralized task-date formatter.
//
// The board table previously used `format(d, 'MMM d')` (e.g. "May 13") while
// TaskModal echoed the raw ISO string ("2026/05/13"), and other surfaces
// fell back to `toLocaleDateString()`. This module is the single source of
// truth so the same value renders consistently everywhere.
//
// Rules (match the existing board pill style):
//   - current-year dates  → "MMM d"            (e.g. "May 13")
//   - other-year dates    → "MMM d, yyyy"      (e.g. "Aug 31, 2027")
//   - empty / invalid     → the placeholder ("—" by default)
//
// Inputs accepted:
//   - ISO string ("2026-05-13", "2026-05-13T00:00:00Z")
//   - Date object
//   - null / undefined
//
// Why date-fns: it's already a dependency, and parseISO on `YYYY-MM-DD`
// produces a local-midnight Date (not the UTC trap that `new Date(str)` has).

function toDate(input) {
  if (!input) return null;
  if (input instanceof Date) return isValid(input) ? input : null;
  if (typeof input === 'string') {
    // Accept full ISO and trim time off date-only inputs first so parseISO
    // doesn't mis-shift across timezones.
    const trimmed = input.length > 10 && input[10] === 'T' ? input : input.slice(0, 10);
    const parsed = parseISO(trimmed);
    return isValid(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Standard task-date format for board cells, modal fields, my-work lists, etc.
 * Returns the placeholder when the input is empty or invalid.
 */
export function formatTaskDate(input, placeholder = '—') {
  const d = toDate(input);
  if (!d) return placeholder;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return format(d, sameYear ? 'MMM d' : 'MMM d, yyyy');
}

/**
 * Always include the year — useful in audit logs / activity timelines where
 * cross-year context matters.
 */
export function formatFullDate(input, placeholder = '—') {
  const d = toDate(input);
  if (!d) return placeholder;
  return format(d, 'MMM d, yyyy');
}

/**
 * `YYYY-MM-DD` for `<input type="date">` value bindings.
 */
export function toInputDate(input) {
  const d = toDate(input);
  if (!d) return '';
  return format(d, 'yyyy-MM-dd');
}
