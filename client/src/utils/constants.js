export const STATUS = {
  NOT_STARTED: 'not_started',
  WORKING: 'working_on_it',
  STUCK: 'stuck',
  DONE: 'done',
  REVIEW: 'review',
};

// Exact Monday.com status colors
export const STATUS_CONFIG = {
  not_started: { label: 'Not Started', color: '#c4c4c4', bgColor: '#c4c4c4', textColor: '#fff' },
  ready_to_start: { label: 'Ready to Start', color: '#fdab3d', bgColor: '#fdab3d', textColor: '#fff' },
  working_on_it: { label: 'Working on it', color: '#fdab3d', bgColor: '#fdab3d', textColor: '#fff' },
  in_progress: { label: 'In Progress', color: '#0073ea', bgColor: '#0073ea', textColor: '#fff' },
  waiting_for_review: { label: 'Waiting for Review', color: '#fdab3d', bgColor: '#fdab3d', textColor: '#fff' },
  pending_deploy: { label: 'Pending Deploy', color: '#a25ddc', bgColor: '#a25ddc', textColor: '#fff' },
  stuck: { label: 'Stuck', color: '#e2445c', bgColor: '#e2445c', textColor: '#fff' },
  done: { label: 'Done', color: '#00c875', bgColor: '#00c875', textColor: '#fff' },
  review: { label: 'In Review', color: '#a25ddc', bgColor: '#a25ddc', textColor: '#fff' },
};

export const PRIORITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

export const PRIORITY_CONFIG = {
  [PRIORITY.LOW]: { label: 'Low', color: '#3b82f6', bgColor: '#3b82f6', textColor: '#fff' },
  [PRIORITY.MEDIUM]: { label: 'Medium', color: '#f59e0b', bgColor: '#f59e0b', textColor: '#fff' },
  [PRIORITY.HIGH]: { label: 'High', color: '#ef4444', bgColor: '#ef4444', textColor: '#fff' },
  [PRIORITY.CRITICAL]: { label: 'Critical', color: '#1e1b4b', bgColor: '#1e1b4b', textColor: '#fff' },
};

export const DEFAULT_GROUPS = [
  { name: 'To Do', color: '#3b82f6' },
  { name: 'In Progress', color: '#f59e0b' },
  { name: 'Completed', color: '#10b981' },
];

export const BOARD_COLORS = [
  '#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6',
  '#f97316', '#eab308', '#06b6d4', '#ec4899', '#14b8a6', '#6366f1',
];

export const COLUMN_TYPES = {
  STATUS: 'status',
  PERSON: 'person',
  DATE: 'date',
  PRIORITY: 'priority',
  TEXT: 'text',
  NUMBER: 'number',
  LABEL: 'label',
  PROGRESS: 'progress',
  CHECKBOX: 'checkbox',
  LINK: 'link',
  FILE: 'file',
  TIMELINE: 'timeline',
  FORMULA: 'formula',
  TIME_TRACKING: 'time_tracking',
};

export const COLUMN_TYPE_OPTIONS = [
  { type: 'text', label: 'Text', icon: 'Type' },
  { type: 'number', label: 'Number', icon: 'Hash' },
  { type: 'date', label: 'Date', icon: 'Calendar' },
  { type: 'status', label: 'Status', icon: 'Circle' },
  { type: 'person', label: 'Person', icon: 'User' },
  { type: 'priority', label: 'Priority', icon: 'Flag' },
  { type: 'label', label: 'Label', icon: 'Tag' },
  { type: 'progress', label: 'Progress', icon: 'BarChart' },
  { type: 'checkbox', label: 'Checkbox', icon: 'CheckSquare' },
  { type: 'link', label: 'Link/URL', icon: 'Link' },
  { type: 'file', label: 'File', icon: 'Paperclip' },
  { type: 'timeline', label: 'Timeline', icon: 'Calendar' },
  { type: 'formula', label: 'Formula', icon: 'Calculator' },
  { type: 'time_tracking', label: 'Time Tracking', icon: 'Clock' },
];

export const DEFAULT_COLUMNS = [
  { id: 'status', title: 'Status', type: COLUMN_TYPES.STATUS, width: 140 },
  { id: 'person', title: 'Owner', type: COLUMN_TYPES.PERSON, width: 130 },
  { id: 'date', title: 'Due Date', type: COLUMN_TYPES.DATE, width: 120 },
  { id: 'priority', title: 'Priority', type: COLUMN_TYPES.PRIORITY, width: 130 },
];

// Default board statuses — used when a board has no custom status config
export const DEFAULT_STATUSES = [
  { key: 'not_started', label: 'Not Started', color: '#c4c4c4' },
  { key: 'ready_to_start', label: 'Ready to Start', color: '#fdab3d' },
  { key: 'working_on_it', label: 'Working on it', color: '#fdab3d' },
  { key: 'in_progress', label: 'In Progress', color: '#0073ea' },
  { key: 'waiting_for_review', label: 'Waiting for Review', color: '#fdab3d' },
  { key: 'pending_deploy', label: 'Pending Deploy', color: '#a25ddc' },
  { key: 'stuck', label: 'Stuck', color: '#e2445c' },
  { key: 'done', label: 'Done', color: '#00c875' },
  { key: 'review', label: 'In Review', color: '#a25ddc' },
];

/**
 * Extract the status configuration array from a board's columns JSONB.
 * Returns the board's custom statuses if configured, otherwise DEFAULT_STATUSES.
 */
export function getBoardStatuses(board) {
  if (!board?.columns) return DEFAULT_STATUSES;
  const statusCol = (Array.isArray(board.columns) ? board.columns : []).find(c => c.type === 'status');
  if (statusCol?.statuses && statusCol.statuses.length > 0) return statusCol.statuses;
  return DEFAULT_STATUSES;
}

/**
 * Resolve the effective statuses for a task, following the priority chain:
 *   1. task.statusConfig (task-specific)
 *   2. board-level statuses (from board.columns)
 *   3. DEFAULT_STATUSES (global fallback)
 *
 * @param {Object} task  - Task object (may have .statusConfig array)
 * @param {Object} board - Board object (may have .columns JSONB)
 * @returns {Array} Array of { key, label, color }
 */
export function getTaskStatuses(task, board) {
  // 1. Task-level
  if (task?.statusConfig && Array.isArray(task.statusConfig) && task.statusConfig.length > 0) {
    return task.statusConfig;
  }
  // 2. Board-level
  if (board) return getBoardStatuses(board);
  // 3. Global
  return DEFAULT_STATUSES;
}

/**
 * Build a lookup map { key → { label, color, bgColor, textColor } } from a statuses array.
 * Falls back to STATUS_CONFIG for any unknown key.
 */
export function buildStatusLookup(statuses) {
  const map = {};
  (statuses || DEFAULT_STATUSES).forEach(s => {
    map[s.key] = { label: s.label, color: s.color, bgColor: s.color, textColor: '#fff' };
  });
  return map;
}

export const STATUS_PRESET_COLORS = [
  '#94a3b8', '#3b82f6', '#f59e0b', '#8b5cf6', '#10b981', '#ef4444',
  '#f97316', '#06b6d4', '#eab308', '#84cc16', '#ec4899', '#14b8a6',
  '#6366f1', '#059669', '#1e1b4b', '#0f766e',
];

export function getProgressColor(pct) {
  if (pct <= 25) return '#ef4444';
  if (pct <= 50) return '#f59e0b';
  if (pct <= 75) return '#eab308';
  return '#10b981';
}

export const HIERARCHY_LEVELS = [
  { value: 'intern', label: 'Intern' },
  { value: 'member', label: 'Team Member' },
  { value: 'team_lead', label: 'Team Lead' },
  { value: 'manager', label: 'Manager' },
  { value: 'senior_manager', label: 'Senior Manager' },
  { value: 'director', label: 'Director' },
  { value: 'vp', label: 'Vice President' },
  { value: 'ceo', label: 'CEO' },
];
