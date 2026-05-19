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
  Doc, Workspace, DocComment,
} = require('../models');
const { canUserSeeBoard } = require('./boardVisibilityService');

const MAX_COMMENTS = 12;
const MAX_WORKLOGS = 8;
const MAX_ACTIVITY = 10;
const MAX_BOARD_TASKS = 30;
// Was 40 (May 2026 bug — Sidekick reported 38 overdue while My Work UI showed
// 50 because the planning sample was truncated below the user's open-task
// count). Bumped to 200 so a busy user's full backlog fits in one sample —
// counts derived from this list now match the My Work UI for anyone under
// the cap. The sampleCapped footnote in the prompt covers the rare
// >200-open-task case.
const MAX_PLANNING_TASKS = 200;
// Per-doc body budget when the Sidekick asks about a specific doc. Tiptap
// JSON walks down to plain text; we cap at ~12k chars (~3k tokens) so the
// prompt envelope stays bounded even on long meeting-notes docs.
const MAX_DOC_BODY_CHARS = 12000;
const MAX_DOC_COMMENTS = 10;

async function buildScopeContext(user, { scope, scopeId, params = {} } = {}) {
  if (!scope) return '';
  try {
    if (scope === 'task')     return await buildTaskScope(user, scopeId);
    if (scope === 'board')    return await buildBoardScope(user, scopeId);
    if (scope === 'doc')      return await buildDocScope(user, scopeId);
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

// ─── Doc scope ───────────────────────────────────────────────────
//
// Used when the Sidekick is opened from inside DocPage with
// scope='doc' + scopeId=<docId>. Reuses the docController's
// workspace-visibility rule (which is now broadened to honor
// board-membership-based access — see canCallerSeeWorkspaceForDocs)
// so a Tier 4 board member who can see the doc can also chat about it.

async function buildDocScope(user, docId) {
  if (!docId) return '';

  const doc = await Doc.findByPk(docId, {
    include: [
      { model: User, as: 'creator',    attributes: ['id', 'name', 'email'] },
      { model: User, as: 'lastEditor', attributes: ['id', 'name', 'email'] },
      { model: Workspace, as: 'workspace', attributes: ['id', 'name'] },
    ],
  });
  if (!doc) return '';

  // Defense-in-depth visibility check. Mirrors docController's helper
  // without reaching across module boundaries; we keep the rule local so a
  // future change in docController doesn't silently relax this prompt's
  // visibility surface.
  const visible = await canSeeDocWorkspace(user, doc.workspaceId).catch(() => false);
  if (!visible) {
    safeLogger.info('[AIScopeContext] doc scope denied — workspace not visible', { docId, userId: user.id });
    return '';
  }

  const body = extractDocBodyText(doc.contentJson, doc.contentText);

  let comments = [];
  if (DocComment) {
    try {
      comments = await DocComment.findAll({
        where: { docId: doc.id, parentId: null },
        include: [{ model: User, as: 'author', attributes: ['id', 'name'] }],
        order: [['createdAt', 'DESC']],
        limit: MAX_DOC_COMMENTS,
      });
    } catch (_) { /* doc comments are best-effort context */ }
  }

  const lines = [];
  lines.push('DOC SCOPE — the user is asking about ONE specific document.');
  lines.push('Treat the body below as the authoritative source. Quote it when relevant.');
  lines.push('');
  lines.push(`Title: ${doc.title || 'Untitled doc'}`);
  if (doc.workspace?.name) lines.push(`Workspace: ${doc.workspace.name}`);
  if (doc.creator?.name) lines.push(`Created by: ${doc.creator.name}`);
  if (doc.lastEditor?.name) lines.push(`Last edited by: ${doc.lastEditor.name}`);
  if (doc.lastEditedAt) lines.push(`Last edited: ${formatDate(doc.lastEditedAt)}`);
  if (doc.isArchived) lines.push('⚠️ This doc is ARCHIVED.');
  lines.push('');
  lines.push('Body:');
  lines.push(body || '(empty doc — no body content yet)');

  if (comments.length > 0) {
    lines.push('');
    lines.push(`Recent comments (up to ${MAX_DOC_COMMENTS}):`);
    for (const c of comments) {
      const author = c.author?.name || 'Unknown';
      const snippet = truncate(stripHtml(c.body || ''), 200);
      const anchor = c.anchorText ? ` (on: "${truncate(c.anchorText, 60)}")` : '';
      const resolved = c.resolved ? ' [resolved]' : '';
      lines.push(`  • [${formatDate(c.createdAt)}] ${author}${anchor}${resolved}: ${snippet}`);
    }
  }

  return lines.join('\n');
}

// Mirrors docController.canCallerSeeWorkspace but ALSO honors
// board-membership-based access (so Tier 4 board members can chat about
// docs in the workspaces they reach via boards — same rule the sidebar
// uses).
async function canSeeDocWorkspace(user, workspaceId) {
  if (!workspaceId || !user) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin' || user.role === 'manager') return true;

  const ws = await Workspace.findByPk(workspaceId, {
    include: [{ model: User, as: 'workspaceMembers', attributes: ['id'], required: false }],
  });
  if (!ws) return false;
  if (ws.createdBy === user.id) return true;
  const memberIds = (ws.workspaceMembers || []).map((m) => m.id);
  if (memberIds.includes(user.id)) return true;

  // Board-membership path: the caller has any visible board in this workspace.
  try {
    const boardVisibility = require('./boardVisibilityService');
    const visibleBoardIds = await boardVisibility.getVisibleBoardIdsForUser(user, { includeArchived: false });
    if (visibleBoardIds && visibleBoardIds.size > 0) {
      const wsBoards = await Board.findAll({
        where: { workspaceId, isArchived: false },
        attributes: ['id'],
        raw: true,
      });
      if (wsBoards.some((b) => visibleBoardIds.has(b.id))) return true;
    }
  } catch (_) { /* best-effort */ }
  return false;
}

// Walks Tiptap JSON and concatenates text content, inserting line breaks
// at paragraph/heading/listItem boundaries so the prompt reads like prose
// instead of one giant unwrapped line. Caps total length at
// MAX_DOC_BODY_CHARS — the AI doesn't need the whole novel, just enough
// to answer questions about the visible structure.
function extractDocBodyText(contentJson, contentTextFallback) {
  if (contentJson && typeof contentJson === 'object') {
    const parts = [];
    const BREAK_TYPES = new Set([
      'paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'horizontalRule',
    ]);
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (typeof node.text === 'string') parts.push(node.text);
      // Render mentions / task chips inline so prompt context stays readable.
      if (node.type === 'mention' && node.attrs?.label) {
        parts.push(`@${node.attrs.label}`);
      } else if ((node.type === 'taskChip' || node.type === 'task-chip') && node.attrs?.label) {
        parts.push(`+${node.attrs.label}`);
      }
      if (Array.isArray(node.content)) node.content.forEach(walk);
      if (BREAK_TYPES.has(node.type)) parts.push('\n');
    }
    walk(contentJson);
    const txt = parts.join('').replace(/\n{3,}/g, '\n\n').trim();
    if (txt) return truncate(txt, MAX_DOC_BODY_CHARS);
  }
  // Fallback to the indexed content_text shadow when contentJson is empty
  // or unparseable. The doc controller stores this on every save.
  if (contentTextFallback) return truncate(String(contentTextFallback), MAX_DOC_BODY_CHARS);
  return '';
}

// ─── Planning scope ───────────────────────────────────────────────

// Open-work loader for "My Work" / "Plan my week" / "Suggest order for today".
//
// We split this into a data layer (loadPlanningTaskList) and a text layer
// (buildPlanningScope) for one specific reason: planWeekWithAI needs the
// canonical "allowed task IDs" to validate the LLM's reply, not just the
// human-readable text dump. Building the text from the same data avoids
// the bug where two independent queries (one by the frontend for the hint
// list, one by the backend for the prompt context) returned different
// rows and the LLM gave up because the IDs disagreed.
async function loadPlanningTaskList(user, _params = {}) {
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

  const sampleCapped = tasks.length >= MAX_PLANNING_TASKS;

  // Bucketize against local midnight (matches My Work UI's parseISO + isPast/isSameDay).
  const today0 = startOfDay(new Date());
  const tomorrow0 = new Date(today0.getTime() + 86400000);
  const endOfWeek = new Date(today0); endOfWeek.setDate(endOfWeek.getDate() + 7);

  const buckets = { overdue: [], today: [], thisWeek: [], later: [], noDate: [] };
  for (const t of tasks) {
    if (!t.dueDate) { buckets.noDate.push(t); continue; }
    const d = new Date(t.dueDate);
    if (d < today0) buckets.overdue.push(t);
    else if (d < tomorrow0) buckets.today.push(t);
    else if (d < endOfWeek) buckets.thisWeek.push(t);
    else buckets.later.push(t);
  }

  const counts = {
    total: tasks.length,
    overdue: buckets.overdue.length,
    today: buckets.today.length,
    thisWeek: buckets.thisWeek.length,
    later: buckets.later.length,
    noDate: buckets.noDate.length,
  };

  const allowedIds = new Set(tasks.map((t) => String(t.id)));

  const context = renderPlanningContext({ tasks, buckets, counts, sampleCapped });

  return { tasks, buckets, counts, allowedIds, context, sampleCapped };
}

function renderPlanningContext({ tasks, buckets, counts, sampleCapped }) {
  const lines = [];
  lines.push(`PLANNING SCOPE — the user is asking about their own workload.`);
  lines.push('');

  if (tasks.length === 0) {
    lines.push("You don't have any open tasks at the moment.");
    return lines.join('\n');
  }

  // AUTHORITATIVE COUNTS — the LLM should quote these for "how many"
  // questions instead of counting items in the detail list below. Placed
  // first so it sits in the highest-attention region of the context.
  lines.push('AUTHORITATIVE COUNTS (use these for "how many" / count questions — these are the exact totals for this user\'s open workload):');
  lines.push(`  Total open: ${counts.total}`);
  lines.push(`  Overdue: ${counts.overdue}`);
  lines.push(`  Due today: ${counts.today}`);
  lines.push(`  Due this week: ${counts.thisWeek}`);
  lines.push(`  Later (this month or beyond): ${counts.later}`);
  lines.push(`  No due date: ${counts.noDate}`);
  if (sampleCapped) {
    lines.push(`  (note: the detail list below shows the top ${tasks.length} by priority; the authoritative counts above reflect this sample.)`);
  }
  lines.push('');

  function dumpBucket(label, list) {
    if (list.length === 0) return;
    lines.push(`${label} (${list.length}):`);
    for (const t of list) {
      lines.push(`  • ${formatTaskLine(t, { showBoard: true })}`);
    }
    lines.push('');
  }

  dumpBucket('OVERDUE', buckets.overdue);
  dumpBucket('DUE TODAY', buckets.today);
  dumpBucket('DUE THIS WEEK', buckets.thisWeek);
  dumpBucket('LATER (this month or beyond)', buckets.later);
  dumpBucket('NO DUE DATE', buckets.noDate);

  lines.push(`Total open tasks: ${tasks.length}`);
  return lines.join('\n');
}

async function buildPlanningScope(user, params = {}) {
  const out = await loadPlanningTaskList(user, params);
  return out.context;
}

// ─── Formatting helpers ─────────────────────────────────────────

function formatTaskLine(t, opts = {}) {
  const parts = [];
  // Print the task id FIRST so it sits on the same line as the title. The
  // planWeek system prompt instructs the LLM to use these IDs verbatim in
  // its output; before this fix the IDs were absent from the context, the
  // AI invented IDs that didn't exist, and the response failed validation.
  if (t.id) parts.push(`id=${t.id}`);
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

module.exports = { buildScopeContext, loadPlanningTaskList };
