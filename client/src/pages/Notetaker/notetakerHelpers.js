import { formatDistanceToNow, format, isAfter, isBefore } from 'date-fns';

/**
 * Shared helpers for the Notetaker pages (skill §3.4, §4.4).
 *
 * Kept stack-agnostic and pure so the views can stay focused on layout.
 */

export function buildMeetingDateTime(meeting) {
  if (!meeting) return null;
  if (!meeting.date) return null;
  const datePart = String(meeting.date).slice(0, 10); // YYYY-MM-DD
  const timePart = meeting.startTime || '00:00';
  // Be lenient — startTime can arrive as "HH:mm" or "HH:mm:ss".
  const normalized = timePart.length === 5 ? `${timePart}:00` : timePart;
  const iso = `${datePart}T${normalized}`;
  const parsed = new Date(iso);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export function buildMeetingEndDateTime(meeting) {
  if (!meeting) return null;
  if (!meeting.date) return null;
  if (!meeting.endTime) return null;
  const datePart = String(meeting.date).slice(0, 10);
  const normalized = meeting.endTime.length === 5 ? `${meeting.endTime}:00` : meeting.endTime;
  const parsed = new Date(`${datePart}T${normalized}`);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export function formatRelativeMeeting(meeting) {
  const start = buildMeetingDateTime(meeting);
  if (!start) return '';
  const now = new Date();
  const end = buildMeetingEndDateTime(meeting);
  if (end && isAfter(now, start) && isBefore(now, end)) return 'Live now';
  if (isAfter(now, start)) return formatDistanceToNow(start, { addSuffix: true });
  return formatDistanceToNow(start, { addSuffix: true });
}

export function formatAbsoluteMeeting(meeting) {
  const start = buildMeetingDateTime(meeting);
  if (!start) return '';
  // E.g. "Fri Dec 15, 3:00 pm"
  return format(start, 'EEE MMM d, h:mm aaa');
}

export function meetingDurationMinutes(meeting) {
  const start = buildMeetingDateTime(meeting);
  const end = buildMeetingEndDateTime(meeting);
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end - start) / 60000));
}

export function formatDurationCompact(minutes) {
  if (!minutes || minutes <= 0) return '—';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function isUpcomingMeeting(meeting) {
  const start = buildMeetingDateTime(meeting);
  if (!start) return false;
  const end = buildMeetingEndDateTime(meeting);
  if (end) {
    return isAfter(end, new Date());
  }
  return isAfter(start, new Date());
}

export function isPastMeeting(meeting) {
  const end = buildMeetingEndDateTime(meeting) || buildMeetingDateTime(meeting);
  if (!end) return false;
  return isBefore(end, new Date());
}

// Recording status placeholders for the summaries table (skill §4.4 Status).
// Real values arrive on the meeting payload once the transcript-per-meeting
// backend slice ships; until then "Not recorded" is the honest default.
export function getRecordingStatus(meeting) {
  if (!meeting) return 'not_recorded';
  if (meeting.recordingStatus) return meeting.recordingStatus;
  if (meeting.transcriptUrl || meeting.hasTranscript) return 'recorded';
  return 'not_recorded';
}

export function recordingStatusLabel(status) {
  switch (status) {
    case 'recorded':     return 'Recorded';
    case 'recording':    return 'Recording…';
    case 'failed':       return 'Failed';
    case 'not_recorded':
    default:             return 'Not recorded';
  }
}

export function recordingStatusColor(status) {
  switch (status) {
    case 'recorded':  return 'green';
    case 'recording': return 'blue';
    case 'failed':    return 'red';
    default:          return 'gray';
  }
}
