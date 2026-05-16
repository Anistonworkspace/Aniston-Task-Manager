/**
 * AI Scope Context Service — Plan A Slice 1
 *
 * When the client sends `{ scope, scopeId }` on a `/api/ai/chat` request,
 * this service builds a compact, role-scoped text context for that specific
 * scope (a single task, a single board, or the caller's open workload).
 *
 * Why a separate module:
 *   - aiContextService.js is route-driven (path → resolver). Scope-aware
 *     context is intent-driven (the consumer says "this is a task chat")
 *     and route-independent. Mixing the two muddies both.
 *   - Each loader fetches ONLY data the caller can see (mirrors the existing
 *     RBAC patterns in taskPermissions.js / boardController).
 *   - Token budget: each loader returns a compact text block (~500-2000
 *     chars) so the AI prompt stays bounded even on busy boards.
 *
 * Public:
 *   buildScopeContext(user, { scope, scopeId, params })  →  Promise<string>
 *
 * Returns an empty string when the scope is unknown or the user can't see
 * the resource — callers should fall back to the existing route-based
 * context in that case.
 */

const { Op } = require('sequelize');
const safeLogger = require('../utils/safeLogger');
const {
  User, Task, Board, Comment, WorkLog, Activity,
  TaskAssignee, TaskOwner, Subtask,
} = require('../models');
const { canUserSeeBoard } = require('./boardVisibilityService');

const MAX_COMMENTS = 12;
const MAX_WORKLOGS = 8;
const MAX_ACTIVITY = 10;
const MAX_BOARD_TASKS = 30;
const MAX_PLANNING_TASKS = 40;

async function buildScopeContext(user, { scope, scopeId, params = {} } = {}) {
  if (!scope) return '';
  try {
    if (scope === 'task')     return await buildTaskScope(user, scopeId);
    if (scope === 'board')    return await buildBoardScope(user, scopeId);
    if (scope === 'planning') return await buildPlanningScope(user, params);
    return '';
  } catch (err) {
    safeLogger.warn('[AIScopeContext] context build failed', { scope, scopeId, err });
    return '';
  }
}

// ─── Task scope ──────────────────────────────────────────────────

async function buildTaskScope(user, taskId) {
  if (!taskId) return '';

  const task = await Task.findByPk(taskId, {
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'role'] },
      { model: User, as: 'creator',  attributes: ['id', 'name', 'email'] },
      { model: Board, as: 'board',   attributes: ['id', 'name'] },
      { model: User, as: 'owners',   attributes: ['id', 'name'], through: { attributes: [] } },
      { model: TaskAssignee, as: 'taskAssignees', include: [{ model: User, as: 'user', attributes: ['id', 'name'] }] },
      { model: Subtask, as: 'subtasks', attributes: ['id', 'title', 'status'] },
    ],
  });

  if (!task) return '';
  // Visibility check — easiest is "can the caller see this task's board?"
  const visible = await canUserSeeBoard(user, task.boardId).catch(() => false);
  if (!visible) {
    safeLogger.info('[AIScopeContext] task scope denied — board not visible', { taskId, userId: user.id });
    return '';
  }

  const comments = await Comment.findAll({
    where: { taskId: task.id },
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    order: [['createdAt', 'DESC']],
    limit: MAX_COMMENTS,
  });

  const worklogs = await WorkLog.findAll({
    where: { taskId: task.id },
    include: [{ model: User, as: 'author', attributes: ['id', 'name'] }],
    order: [['date', 'DESC'], ['createdAt', 'DESC']],
    limit: MAX_WORKLOGS,
  });

  const activity = await Activity.findAll({
    where: { taskId: task.id },
    order: [['createdAt', 'DESC']],
    limit: MAX_ACTIVITY,
  });

  const ownerNames = (task.owners || []).map((o) => o.name).filter(Boolean);
  const assigneeNames = (task.taskAssignees || [])
    .map((ta) => ta.user?.name)
    .filter(Boolean);
  const subtaskLines = (task.subtasks || []).slice(0, 8).map((s) =>
    `  - [${(s.status || '').toUpperCase()}] ${s.title || '(untitled)'}`
  );

  const lines = [];
  lines.push(`TASK SCOPE — the user is asking about ONE specific task.`);
  lines.push('');
  lines.push(`Title: ${task.title || '(untitled)'}`);
  lines.push(`Board: ${task.board?.name || '(unknown board)'}`);
  lines.push(`Status: ${task.status || 'unknown'} · Priority: ${task.priority || 'unset'} · Progress: ${task.progress ?? 0}%`);
  if (task.dueDate) lines.push(`Due: ${formatDate(task.dueDate)}`);
  if (task.startDate) lines.push(`Started: ${formatDate(task.startDate)}`);
  if (task.estimatedHours) lines.push(`Estimated: ${task.estimatedHours}h · Actual so far: ${task.actualHours ?? 0}h`);
  if (assigneeNames.length || ownerNames.length || task.assignee?.name) {
    const names = Array.from(new Set([
      task.assignee?.name,
      ...ownerNames,
      ...assigneeNames,
    ].filter(Boolean)));
    lines.push(`Assigned to: ${names.join(', ')}`);
  }
  if (task.creator?.name) lines.push(`Created by: ${task.creator.name}`);
  if (task.isArchived) lines.push('⚠️ This task is ARCHIVED.');

  if (task.description) {
    lines.push('');
    lines.push('Description:');
    lines.push(truncate(task.description, 600));
  }

  if (subtaskLines.length > 0) {
    lines.push('');
    lines.push(`Subtasks (${task.subtasks.length}):`);
    lines.push(...subtaskLines);
    if (task.subtasks.length > 8) lines.push(`  + ${task.subtasks.length - 8} more not shown`);
  }

  if (comments.length > 0) {
    lines.push('');
    lines.push(`Recent comments (most recent first, up to ${MAX_COMMENTS}):`);
    for (const c of comments) {
      const author = c.user?.name || 'Unknown';
      lines.push(`  • [${formatDate(c.createdAt)}] ${author}: ${truncate(stripHtml(c.content), 200)}`);
    }
  }

  if (worklogs.length > 0) {
    lines.push('');
    lines.push(`Recent work logs (up to ${MAX_WORKLOGS}):`);
    for (const w of worklogs) {
      const author = w.author?.name || 'Unknown';
      lines.push(`  • [${formatDate(w.date || w.createdAt)}] ${author}: ${truncate(stripHtml(w.content), 200)}`);
    }
  }

  if (activity.length > 0) {
    lines.push('');
    lines.push(`Recent activity (up to ${MAX_ACTIVITY}):`);
    for (const a of activity) {
      lines.push(`  • [${formatDate(a.createdAt)}] ${a.action || ''}: ${truncate(a.description || '', 160)}`);
    }
  }

  return lines.join('\n');
}

// ─── Board scope ─────────────────────────────────────────────────

async function buildBoardScope(user, boardId) {
  if (!boardId) return '';

  const visible = await canUserSeeBoard(user, boardId).catch(() => false);
  if (!visible) {
    safeLogger.info('[AIScopeContext] board scope denied', { boardId, userId: user.id });
    return '';
  }

  const board = await Board.findByPk(boardId);
  if (!board) return '';

  const tasks = await Task.findAll({
    where: { boardId, isArchived: false },
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name'] },
    ],
    order: [
      ['priority', 'ASC'],
      ['dueDate', 'ASC'],
      ['updatedAt', 'DESC'],
    ],
    limit: 500, // pre-aggregate cap; per-board task counts are typically <500.
  });

  const buckets = {
    not_started: [],
    working_on_it: [],
    stuck: [],
    review: [],
    done: [],
    other: [],
  };
  let overdue = 0;
  let dueToday = 0;
  let dueThisWeek = 0;
  const today0 = startOfDay(new Date());
  const endOfWeek = new Date(today0); endOfWeek.setDate(endOfWeek.getDate() + 7);

  for (const t of tasks) {
    const key = buckets[t.status] ? t.status : 'other';
    buckets[key].push(t);
    if (t.dueDate) {
      const d = new Date(t.dueDate);
      if (d < today0 && t.status !== 'done') overdue++;
      else if (d >= today0 && d < new Date(today0.getTime() + 86400000)) dueToday++;
      else if (d >= today0 && d < endOfWeek) dueThisWeek++;
    }
  }

  const lines = [];
  lines.push(`BOARD SCOPE — the user is asking about the entire board "${board.name}".`);
  lines.push('');
  lines.push(`Total open tasks: ${tasks.length}`);
  lines.push(`By status: ${Object.entries(buckets).filter(([, v]) => v.length).map(([k, v]) => `${k}=${v.length}`).join(' · ')}`);
  lines.push(`Overdue: ${overdue} · Due today: ${dueToday} · Due this week: ${dueThisWeek}`);
  lines.push('');

  if (buckets.stuck.length > 0) {
    lines.push(`STUCK tasks (top ${Math.min(buckets.stuck.length, 10)}):`);
    for (const t of buckets.stuck.slice(0, 10)) {
      lines.push(`  • ${formatTaskLine(t)}`);
    }
    lines.push('');
  }

  // Top in-flight items by priority.
  const inFlight = [...buckets.working_on_it, ...buckets.review].slice(0, MAX_BOARD_TASKS);
  if (inFlight.length > 0) {
    lines.push(`IN-FLIGHT tasks (top ${inFlight.length} by priority):`);
    for (const t of inFlight) {
      lines.push(`  • ${formatTaskLine(t)}`);
    }
  }

  return lines.join('\n');
}

// ─── Planning scope ───────────────────────────────────────────────

async function buildPlanningScope(user, params = {}) {
  // "Plan my week" / "Suggest order for today" — load the caller's open tasks
  // across all boards they have access to. The /api/tasks?assignedTo=me
  // controller already enforces RBAC; we reuse its WHERE clause via direct
  // Sequelize lookup keyed on assignedTo / TaskOwner / TaskAssignee.
  const tasks = await Task.findAll({
    where: {
      isArchived: false,
      status: { [Op.notIn]: ['done', 'completed', 'closed'] },
      [Op.or]: [
        { assignedTo: user.id },
        { '$owners.id$': user.id },
        { '$taskAssignees.userId$': user.id },
      ],
    },
    include: [
      { model: Board, as: 'board', attributes: ['id', 'name'] },
      { model: User,  as: 'owners', attributes: ['id'], through: { attributes: [] }, required: false },
      { model: TaskAssignee, as: 'taskAssignees', attributes: ['userId'], required: false },
    ],
    order: [
      ['priority', 'ASC'],
      ['dueDate', 'ASC'],
      ['createdAt', 'DESC'],
    ],
    limit: MAX_PLANNING_TASKS,
    subQuery: false,
  });

  const lines = [];
  lines.push(`PLANNING SCOPE — the user is asking about their own workload.`);
  lines.push('');

  if (tasks.length === 0) {
    lines.push("You don't have any open tasks at the moment.");
    return lines.join('\n');
  }

  const today0 = startOfDay(new Date());
  const endOfWeek = new Date(today0); endOfWeek.setDate(endOfWeek.getDate() + 7);

  const overdue = [];
  const today = [];
  const thisWeek = [];
  const later = [];
  const noDate = [];

  for (const t of tasks) {
    if (!t.dueDate) { noDate.push(t); continue; }
    const d = new Date(t.dueDate);
    if (d < today0) overdue.push(t);
    else if (d < new Date(today0.getTime() + 86400000)) today.push(t);
    else if (d < endOfWeek) thisWeek.push(t);
    else later.push(t);
  }

  function dumpBucket(label, list) {
    if (list.length === 0) return;
    lines.push(`${label} (${list.length}):`);
    for (const t of list) {
      lines.push(`  • ${formatTaskLine(t, { showBoard: true })}`);
    }
    lines.push('');
  }

  dumpBucket('OVERDUE', overdue);
  dumpBucket('DUE TODAY', today);
  dumpBucket('DUE THIS WEEK', thisWeek);
  dumpBucket('LATER (this month or beyond)', later);
  dumpBucket('NO DUE DATE', noDate);

  lines.push(`Total open tasks: ${tasks.length}`);
  return lines.join('\n');
}

// ─── Formatting helpers ─────────────────────────────────────────

function formatTaskLine(t, opts = {}) {
  const parts = [];
  parts.push(`[${t.priority || 'no-pri'}]`);
  parts.push(t.title || '(untitled)');
  parts.push(`(status: ${t.status || '?'})`);
  if (t.dueDate) parts.push(`due ${formatDate(t.dueDate)}`);
  if (opts.showBoard && t.board?.name) parts.push(`· board: ${t.board.name}`);
  return parts.join(' ');
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function formatDate(d) {
  if (!d) return '';
  try {
    const x = new Date(d);
    if (isNaN(x.getTime())) return '';
    return x.toISOString().slice(0, 10);
  } catch { return ''; }
}

function stripHtml(s) {
  if (!s) return '';
  return String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  if (!s) return '';
  const text = String(s);
  if (text.length <= n) return text;
  return text.slice(0, n - 1) + '…';
}

module.exports = { buildScopeContext };
