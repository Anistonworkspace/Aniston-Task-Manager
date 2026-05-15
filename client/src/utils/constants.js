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
  pending_deploy: { label: 'Pending Deploy', color: '#9d50dd', bgColor: '#9d50dd', textColor: '#fff' },
  stuck: { label: 'Stuck', color: '#df2f4a', bgColor: '#df2f4a', textColor: '#fff' },
  done: { label: 'Done', color: '#00c875', bgColor: '#00c875', textColor: '#fff' },
  review: { label: 'In Review', color: '#9d50dd', bgColor: '#9d50dd', textColor: '#fff' },
};

export const PRIORITY = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

// Priority colors — drawn from skill §1.6 Monday content swatches:
//   bright-blue (#579bfc) · working_orange (#fdab3d) · sunset (#ff7575)
//   · dark-red (#bb3354 — critical stays dark/urgent without going pure red,
//     leaving #df2f4a as the dedicated "stuck" status color).
export const PRIORITY_CONFIG = {
  [PRIORITY.LOW]: { label: 'Low', color: '#579bfc', bgColor: '#579bfc', textColor: '#fff' },
  [PRIORITY.MEDIUM]: { label: 'Medium', color: '#fdab3d', bgColor: '#fdab3d', textColor: '#fff' },
  [PRIORITY.HIGH]: { label: 'High', color: '#ff7575', bgColor: '#ff7575', textColor: '#fff' },
  [PRIORITY.CRITICAL]: { label: 'Critical', color: '#bb3354', bgColor: '#bb3354', textColor: '#fff' },
};

// Default board groups — skill §1.6 swatches.
export const DEFAULT_GROUPS = [
  { name: 'To Do', color: '#579bfc' },
  { name: 'In Progress', color: '#fdab3d' },
  { name: 'Completed', color: '#00c875' },
];

// Board accent palette — all 12 picks drawn from skill §1.6 swatches.
export const BOARD_COLORS = [
  '#0073ea', '#00c875', '#fdab3d', '#df2f4a', '#9d50dd', '#579bfc',
  '#ff6d3b', '#ffcb00', '#66ccff', '#e50073', '#4eccc6', '#5559df',
];

// Color palette used to colour group chips inside the create-board modal.
// We cycle through this rather than asking the user to pick per-group.
export const GROUP_COLORS = [
  '#579bfc', '#fdab3d', '#00c875', '#9d50dd', '#0073ea', '#df2f4a',
  '#ff7575', '#bb3354', '#9aadbd', '#5559df', '#3db085', '#ffcb00',
];

// Predefined board-group templates surfaced in the Create Board modal.
// "default" mirrors the legacy backend default and is preselected so the
// existing flow (do-nothing → New Task / In Progress / Done) is preserved.
// Adding a template entry here is enough to make it available; no other
// edits are required.
export const BOARD_GROUP_TEMPLATES = [
  { id: 'default', label: 'Default Task Flow', groups: ['New Task', 'In Progress', 'Done'] },
  { id: 'software', label: 'Software / Development', groups: ['Backlog', 'Planning', 'In Development', 'Code Review', 'Testing', 'Ready for Release', 'Done'] },
  { id: 'qa', label: 'Bug / QA', groups: ['Reported', 'Reproducing', 'Fixing', 'QA Testing', 'Verified', 'Closed'] },
  { id: 'ops', label: 'Management / Operations', groups: ['Requested', 'Reviewing', 'Assigned', 'In Progress', 'Waiting for Approval', 'Completed'] },
  { id: 'marketing', label: 'Marketing', groups: ['Ideas', 'Planning', 'Content Creation', 'Design', 'Review', 'Scheduled', 'Published'] },
  { id: 'sales', label: 'Sales / CRM', groups: ['Lead', 'Contacted', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost'] },
  { id: 'support', label: 'Support / Helpdesk', groups: ['New Ticket', 'Assigned', 'In Progress', 'Waiting on Customer', 'Resolved', 'Closed'] },
  { id: 'hr', label: 'HR / Recruitment', groups: ['Request Raised', 'Screening', 'Interview', 'Selected', 'Offer', 'Joined', 'Rejected'] },
  { id: 'design', label: 'Design / Creative', groups: ['Brief', 'Concept', 'Design Draft', 'Internal Review', 'Client Review', 'Approved', 'Delivered'] },
  { id: 'custom', label: 'Custom (start blank)', groups: [] },
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
  { key: 'pending_deploy', label: 'Pending Deploy', color: '#9d50dd' },
  { key: 'stuck', label: 'Stuck', color: '#df2f4a' },
  { key: 'done', label: 'Done', color: '#00c875' },
  { key: 'review', label: 'In Review', color: '#9d50dd' },
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

// Status preset palette — 16 picks from skill §1.6 content swatches so
// any custom status created from the picker is on-spec by construction.
export const STATUS_PRESET_COLORS = [
  '#9aadbd', '#579bfc', '#fdab3d', '#9d50dd', '#00c875', '#df2f4a',
  '#ff6d3b', '#66ccff', '#ffcb00', '#9cd326', '#e50073', '#4eccc6',
  '#5559df', '#037f4c', '#401694', '#175a63',
];

// Progress gradient — skill §1.6 swatches keyed by completion bucket.
export function getProgressColor(pct) {
  if (pct <= 25) return '#df2f4a'; // stuck-red
  if (pct <= 50) return '#fdab3d'; // working_orange
  if (pct <= 75) return '#ffcb00'; // egg_yolk
  return '#00c875';                // done-green
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

// Single source of truth for the company's department/team list, sourced from
// the official org chart. Used by every user-facing department picker (Edit
// User, Create User, Profile, Register). Keep this list in sync with the
// printed org chart — the backend stores the raw string, so any value chosen
// here (or typed via "Other") is persisted as-is.
export const OFFICIAL_DEPARTMENTS = [
  'Leadership',
  'Administration',
  'Accounts Team',
  'Embedded & Firmware Team',
  'AI ML Team',
  'IT Team',
  'HR Team',
  'Software Team',
  'Sales & Marketing Team',
  'Sales',
  'Marketing',
  'Pre Sales Team',
  'Project Team',
];

export const DEPARTMENT_OTHER = 'Other';

export function isOfficialDepartment(value) {
  if (typeof value !== 'string') return false;
  return OFFICIAL_DEPARTMENTS.includes(value.trim());
}
