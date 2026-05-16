/**
 * Tiny timezone helper for the `daily_times` reminder type.
 *
 * Computes "the next time a given HH:MM clock slot occurs in a given IANA
 * timezone, strictly after a reference instant" — handling DST transitions
 * via the native `Intl.DateTimeFormat`. No external dependency.
 *
 * Why we don't pull in date-fns-tz / luxon: this is the only spot that
 * needs TZ math on the server, the inputs are tightly constrained
 * (HH:MM strings + IANA names), and `Intl.DateTimeFormat` ships in Node 18+.
 */

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidHHMM(s) {
  return typeof s === 'string' && HHMM_RE.test(s);
}

/**
 * Validate an IANA timezone name by asking Intl whether it accepts it.
 * Returns the input if valid, or the default timezone otherwise.
 */
function normalizeTimezone(tz) {
  if (!tz || typeof tz !== 'string') return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Read the local Y/M/D/H/M parts of an instant in a given timezone.
 * Returns plain numbers (not zero-padded strings).
 */
function getLocalParts(instant, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(instant).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl uses "24" for midnight in some locales when hour12:false; normalize.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Compute the UTC offset (minutes) for a given IANA timezone at a given
 * instant. Positive = ahead of UTC. e.g. Asia/Kolkata → +330.
 */
function getTimezoneOffsetMinutes(instant, timezone) {
  const local = getLocalParts(instant, timezone);
  // Build a UTC timestamp from the local Y/M/D/H/M/S parts. The difference
  // between that and the original instant is the offset.
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/**
 * Build a UTC Date from a "Y-M-D HH:MM" wall clock in a given timezone.
 * Handles DST transitions iteratively (the offset at the target wall time
 * may differ from the offset at our first guess).
 */
function wallClockToUtc(year, month, day, hh, mm, timezone) {
  // First guess: assume the target wall time has the same offset as the
  // current moment.
  const now = new Date();
  let offsetMin = getTimezoneOffsetMinutes(now, timezone);
  let utcMs = Date.UTC(year, month - 1, day, hh, mm, 0) - offsetMin * 60000;

  // Refine: re-read the offset at the candidate instant and adjust. Two
  // passes are enough for any real-world DST jump.
  for (let i = 0; i < 2; i += 1) {
    const candidate = new Date(utcMs);
    const off = getTimezoneOffsetMinutes(candidate, timezone);
    if (off === offsetMin) break;
    offsetMin = off;
    utcMs = Date.UTC(year, month - 1, day, hh, mm, 0) - offsetMin * 60000;
  }
  return new Date(utcMs);
}

/**
 * Given a list of "HH:MM" strings, a timezone, and a reference instant,
 * return the soonest UTC Date that is strictly AFTER `from` and matches
 * one of the HH:MM slots in `timezone`.
 *
 * If all of today's slots have already passed (or equal `from`), wraps to
 * tomorrow's first slot.
 *
 * @param {string[]} timesHHMM  e.g. ['09:00', '18:00']
 * @param {string}   timezone   IANA TZ. Falls back to Asia/Kolkata.
 * @param {Date}     from       reference instant
 * @returns {Date|null}         next fire, or null if `timesHHMM` is empty/invalid
 */
function nextDailyTimeFire(timesHHMM, timezone, from) {
  if (!Array.isArray(timesHHMM) || timesHHMM.length === 0) return null;
  const tz = normalizeTimezone(timezone);
  const valid = timesHHMM.filter(isValidHHMM);
  if (valid.length === 0) return null;

  // Sort ascending so we pick the smallest candidate per day naturally.
  const sorted = [...new Set(valid)].sort();

  const local = getLocalParts(from, tz);

  // Try today's slots first.
  for (const t of sorted) {
    const [hh, mm] = t.split(':').map(Number);
    const candidate = wallClockToUtc(local.year, local.month, local.day, hh, mm, tz);
    if (candidate.getTime() > from.getTime()) return candidate;
  }

  // None of today's slots are in the future — wrap to tomorrow's first slot.
  // Use UTC day arithmetic on the local Y/M/D to get a valid "next day" tuple
  // even across month/year boundaries.
  const tomorrowMs = Date.UTC(local.year, local.month - 1, local.day) + 24 * 60 * 60 * 1000;
  const t = new Date(tomorrowMs);
  const ty = t.getUTCFullYear();
  const tm = t.getUTCMonth() + 1;
  const td = t.getUTCDate();
  const [hh, mm] = sorted[0].split(':').map(Number);
  return wallClockToUtc(ty, tm, td, hh, mm, tz);
}

module.exports = {
  DEFAULT_TIMEZONE,
  isValidHHMM,
  normalizeTimezone,
  nextDailyTimeFire,
};
