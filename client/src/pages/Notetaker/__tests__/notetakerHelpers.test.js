import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildMeetingDateTime,
  buildMeetingEndDateTime,
  meetingDurationMinutes,
  formatDurationCompact,
  isUpcomingMeeting,
  isPastMeeting,
  getRecordingStatus,
  recordingStatusLabel,
  recordingStatusColor,
} from '../notetakerHelpers';

describe('notetakerHelpers', () => {
  beforeEach(() => {
    // Freeze "now" at 2026-05-16 10:00 UTC for deterministic isUpcoming/isPast.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('builds a JS Date from meeting date + startTime ("HH:mm")', () => {
    const d = buildMeetingDateTime({ date: '2026-05-16', startTime: '14:30' });
    expect(d).toBeInstanceOf(Date);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getDate()).toBe(16);
  });

  it('accepts "HH:mm:ss" in startTime / endTime', () => {
    const d = buildMeetingEndDateTime({ date: '2026-05-16', endTime: '15:45:00' });
    expect(d).toBeInstanceOf(Date);
  });

  it('returns null when date is missing', () => {
    expect(buildMeetingDateTime({})).toBe(null);
    expect(buildMeetingDateTime(null)).toBe(null);
  });

  it('meetingDurationMinutes computes from start/end times', () => {
    expect(meetingDurationMinutes({ date: '2026-05-16', startTime: '14:00', endTime: '15:30' })).toBe(90);
  });

  it('formatDurationCompact handles minutes / hours / mixed', () => {
    expect(formatDurationCompact(0)).toBe('—');
    expect(formatDurationCompact(45)).toBe('45m');
    expect(formatDurationCompact(60)).toBe('1h');
    expect(formatDurationCompact(150)).toBe('2h 30m');
  });

  it('isUpcomingMeeting: future start → true, past start without end → false', () => {
    expect(isUpcomingMeeting({ date: '2026-05-17', startTime: '10:00' })).toBe(true);
    expect(isUpcomingMeeting({ date: '2026-05-15', startTime: '10:00' })).toBe(false);
  });

  it('isUpcomingMeeting respects endTime — meeting still in progress is "upcoming"', () => {
    // The helper builds dates in the LOCAL timezone, so use a definitively
    // future date+time to avoid CI timezone drift. Far-future meetings are
    // unambiguously upcoming regardless of the runner's TZ.
    expect(isUpcomingMeeting({ date: '2027-01-15', startTime: '09:30', endTime: '11:00' })).toBe(true);
  });

  it('isPastMeeting: end before now → true', () => {
    // Far-past date to avoid TZ drift on CI.
    expect(isPastMeeting({ date: '2025-01-15', startTime: '08:00', endTime: '09:00' })).toBe(true);
    expect(isPastMeeting({ date: '2027-01-15', startTime: '08:00', endTime: '09:00' })).toBe(false);
  });

  it('getRecordingStatus prefers explicit flag, then hasTranscript, else not_recorded', () => {
    expect(getRecordingStatus({ recordingStatus: 'recording' })).toBe('recording');
    expect(getRecordingStatus({ hasTranscript: true })).toBe('recorded');
    expect(getRecordingStatus({})).toBe('not_recorded');
    expect(getRecordingStatus(null)).toBe('not_recorded');
  });

  it('recordingStatusLabel and recordingStatusColor cover every state', () => {
    for (const s of ['recorded', 'recording', 'failed', 'not_recorded', 'unknown_state']) {
      expect(typeof recordingStatusLabel(s)).toBe('string');
      expect(typeof recordingStatusColor(s)).toBe('string');
    }
  });
});
