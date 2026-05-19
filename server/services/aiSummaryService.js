'use strict';

/**
 * AI Summary Service — Plan A Slice 2
 *
 * One-shot AI runs for "summarize task / board" and "suggest priority /
 * plan week". Built on top of:
 *   - aiScopeContextService (Slice 1)  — builds the context block
 *   - aiService.chat                   — provider-agnostic LLM call
 *
 * Why a separate service:
 *   - The Sidekick chat path is multi-turn and free-form. These endpoints
 *     are SINGLE-TURN, returning either text (summaries) or JSON
 *     (priority / plan). Reusing chatWithAI directly would force every
 *     caller to round-trip a system prompt and re-parse the result.
 *   - JSON-strict responses go through a parseStructured helper that
 *     fences the AI's output and falls back to text if the model ignored
 *     the schema. The fallback shape is documented per function.
 *
 * Public exports:
 *   summarizeTaskWithAI(user, taskId, opts)
 *   summarizeBoardWithAI(user, boardId, opts)
 *   suggestPriorityWithAI(user, { taskTitle, taskDescription, boardId })
 *   planWeekWithAI(user, { taskIds })
 *
 * Each function throws `AiNotConfiguredError` if the AI tier isn't set up.
 * Otherwise the resolved value is structured and safe to JSON.stringify.
 */

const aiService = require('./aiService');
const { buildScopeContext, loadPlanningTaskList } = require('./aiScopeContextService');
const safeLogger = require('../utils/safeLogger');

class AiNotConfiguredError extends Error {
  constructor(msg) { super(msg || 'AI is not configured'); this.code = 'AI_NOT_CONFIGURED'; }
}

class AiScopeUnavailableError extends Error {
  constructor(msg) { super(msg || 'Scope context unavailable'); this.code = 'AI_SCOPE_UNAVAILABLE'; }
}

// ─── summaries ────────────────────────────────────────────────

async function summarizeTaskWithAI(user, taskId, opts = {}) {
  const ctx = await buildScopeContext(user, { scope: 'task', scopeId: taskId });
  if (!ctx) throw new AiScopeUnavailableError('Cannot read this task — it may be archived or you may not have access.');

  const system = buildTaskSummarySystemPrompt(user, ctx, opts);
  const messages = [
    { role: 'user', content: 'Summarize this task in 3-5 sentences. Lead with the bottom line. Call out blockers, next steps, and any risk to the due date.' },
  ];
  // 3-5 sentence summary needs ~300 tokens max — capping cuts latency.
  const reply = await aiService.chat(messages, system, opts.providerId, { maxTokens: 350 });
  return { kind: 'text', summary: stripFences(String(reply || '').trim()) };
}

async function summarizeBoardWithAI(user, boardId, opts = {}) {
  const ctx = await buildScopeContext(user, { scope: 'board', scopeId: boardId });
  if (!ctx) throw new AiScopeUnavailableError('Cannot read this board — you may not have access.');

  const system = buildBoardSummarySystemPrompt(user, ctx, opts);
  const messages = [
    { role: 'user', content: 'Give a concise summary of where this board stands. Cover: what is done, what is in flight, what is stuck (and why), what is overdue, and what to focus on next. Maximum 8 sentences.' },
  ];
  // 8-sentence board summary needs ~500 tokens — capping cuts latency.
  const reply = await aiService.chat(messages, system, opts.providerId, { maxTokens: 550 });
  return { kind: 'text', summary: stripFences(String(reply || '').trim()) };
}

// ─── Notetaker — extract action items from a transcript ─────────
//
// One-shot AI call: take a meeting transcript (possibly speaker-prefixed:
//   "Speaker 1: we need to ship the auth fix by Friday")
// and return a structured array of action items the user can convert into
// tasks. Strict-JSON output via a fenced block; if the model refuses we
// fall back to an empty list so the UI degrades gracefully.
//
// Each action has: { title, owner?, dueDate?, priority? }.
// owner is a free-text name string the LLM extracts (we resolve to a real
// user later when the caller clicks "Create task"); we never trust the
// AI to assert user IDs.

const ACTION_PRIORITIES = ['low', 'medium', 'high', 'critical'];

async function extractActionItemsWithAI({ text } = {}, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('text is required');
  }
  const truncated = truncate(text.trim(), 8000);

  const system = [
    'You read meeting transcripts and extract concrete action items.',
    'Return ONLY a JSON object inside a single ```json fenced block.',
    'Shape:',
    '  { "actions": [',
    '      { "title": string,',
    '        "owner": string | null,',
    '        "dueDate": string | null,   // YYYY-MM-DD or null',
    '        "priority": "low" | "medium" | "high" | "critical" | null',
    '      }',
    '  ] }',
    'Rules:',
    '- Only include items that are real to-dos. Skip pleasantries.',
    '- owner is a person name as spoken (e.g. "Sara"), null if unclear.',
    '- dueDate ISO YYYY-MM-DD if a specific date was mentioned (e.g. "by Friday" → next Friday), else null.',
    '- priority "critical" only if the speaker said urgent/blocker/escalate; default null.',
    '- Title should be a single imperative sentence (~80 chars max).',
    '- Cap at 12 actions even if the meeting was longer.',
    '- Return { "actions": [] } if the transcript has no clear action items.',
  ].join('\n');

  const reply = await aiService.chat(
    [{ role: 'user', content: `Transcript:\n"""\n${truncated}\n"""\n\nExtract action items.` }],
    system,
    opts.providerId,
  );

  const parsed = parseFencedJSON(reply);
  if (!parsed || !Array.isArray(parsed.actions)) {
    safeLogger.warn('[aiSummary] extractActions: non-JSON reply; returning empty list', {
      reply: truncate(String(reply || ''), 200),
    });
    return { kind: 'structured', actions: [] };
  }

  const cleaned = parsed.actions
    .filter((a) => a && typeof a === 'object')
    .map((a) => {
      const title = typeof a.title === 'string' ? a.title.trim().slice(0, 180) : '';
      if (!title) return null;
      const owner = typeof a.owner === 'string' && a.owner.trim()
        ? a.owner.trim().slice(0, 80)
        : null;
      const dueDate = isIsoDate(a.dueDate) ? a.dueDate : null;
      const priority = ACTION_PRIORITIES.includes(a.priority) ? a.priority : null;
      return { title, owner, dueDate, priority };
    })
    .filter(Boolean)
    .slice(0, 12);

  return { kind: 'structured', actions: cleaned };
}

// ─── Phase E — inline AI transforms on selected text ─────────────
//
// Surfaces a "select text → AI" interaction inside any rich editor.
// Modes (mirrored on the client `BubbleAIMenu`):
//   improve       — fix awkward phrasing, sharpen the message
//   shorter       — same idea, fewer words
//   longer        — expand with detail / context
//   grammar       — fix grammar / spelling only, keep wording intact
//   continue      — write the next sentence(s) in the same voice
//   casual        — rewrite in a more casual tone
//   professional  — rewrite in a more formal/business tone
//
// Each mode picks a system prompt; the response is plain text (no fences,
// no Markdown surround). The caller swaps the selection in-place.
const INLINE_MODES = {
  improve: {
    system: 'You improve the user-supplied passage. Return ONLY the improved text. No preamble, no fences, no explanation. Keep the language and the rough length the same. Preserve any names, numbers, URLs, and proper nouns verbatim.',
    instruction: 'Rewrite to be clearer and stronger while preserving meaning.',
  },
  shorter: {
    system: 'You shorten the user-supplied passage. Return ONLY the shortened text. Keep the meaning, drop filler.',
    instruction: 'Rewrite the passage to be ~40% shorter, no bullets, no preamble.',
  },
  longer: {
    system: 'You expand the user-supplied passage with relevant detail. Return ONLY the expanded text. Stay on topic.',
    instruction: 'Expand the passage by ~50% with concrete detail. No fluff.',
  },
  grammar: {
    system: 'You fix grammar and spelling only. Preserve the author voice, capitalization style, and word choice as much as possible. Return ONLY the corrected text.',
    instruction: 'Correct grammar and spelling. Do not rewrite for style.',
  },
  continue: {
    system: 'You continue writing in the same voice as the user-supplied passage. Return ONLY the continuation. Do not repeat the original.',
    instruction: 'Write 1-3 sentences that naturally continue what came before.',
  },
  casual: {
    system: 'You rewrite the user-supplied passage in a casual, conversational tone. Return ONLY the rewritten text.',
    instruction: 'Same meaning, casual conversational tone.',
  },
  professional: {
    system: 'You rewrite the user-supplied passage in a polished business/professional tone. Return ONLY the rewritten text.',
    instruction: 'Same meaning, polished professional tone. No jargon spam.',
  },
};

const INLINE_MAX_INPUT_CHARS = 4000;

async function transformInlineWithAI({ text, mode } = {}, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('text is required');
  }
  const cfg = INLINE_MODES[mode];
  if (!cfg) {
    throw new Error(`Unknown mode: ${mode}. Allowed: ${Object.keys(INLINE_MODES).join(', ')}`);
  }
  const trimmed = text.trim();
  const truncated = trimmed.length > INLINE_MAX_INPUT_CHARS
    ? trimmed.slice(0, INLINE_MAX_INPUT_CHARS)
    : trimmed;

  const reply = await aiService.chat(
    [{
      role: 'user',
      content: `${cfg.instruction}\n\nPassage:\n"""${truncated}"""`,
    }],
    cfg.system,
    opts.providerId,
  );

  // Strip Markdown fences and stray surrounding quotes the model sometimes
  // adds despite the system prompt asking for raw text.
  const cleaned = stripFences(String(reply || '').trim())
    .replace(/^["'"]+|["'"]+$/g, '')
    .trim();
  return { kind: 'text', mode, output: cleaned };
}

/**
 * Phase D — one-shot doc summary.
 *
 * Reads a doc the caller can see (workspace-visibility gate done in the
 * controller; this service trusts its caller) and asks the model for a
 * short summary. Plain-text shadow (`contentText`) is sent — the JSON
 * envelope would burn tokens on Tiptap nesting that doesn't change the
 * summary.
 */
async function summarizeDocWithAI(user, doc, opts = {}) {
  if (!doc || !doc.id) throw new AiScopeUnavailableError('Doc not found.');
  // Prefer contentText (cheap shadow column updated on every HTTP save).
  // Fall back to walking contentJson directly when contentText is empty —
  // can happen on docs whose recent edits flowed through Y.js collab and
  // the HTTP shadow path hasn't caught up yet, or on legacy docs.
  let text = String(doc.contentText || '').trim();
  if (!text && doc.contentJson) {
    text = extractTextFromTiptapJson(doc.contentJson).trim();
  }
  if (!text) {
    return {
      kind: 'text',
      summary: 'This doc is empty — write something first, then hit Summarize.',
    };
  }
  // May 2026 latency tuning — was 6000 input / default-1500 output.
  // For a 180-word summary, ~3000 chars of context and ~400 tokens of
  // output is plenty and roughly halves provider latency. Long docs
  // still get summarized; we just bias toward speed.
  const truncated = truncate(text, 3000);
  const system = [
    `You are summarizing a collaborative document titled "${doc.title || 'Untitled doc'}".`,
    'Lead with the bottom line, then list the most important points as 3-5 short bullets.',
    'Keep the whole reply under 150 words. Reply in plain Markdown — no code fences, no preamble.',
  ].join(' ');
  const messages = [
    { role: 'user', content: `Doc contents:\n\n${truncated}\n\nSummarize.` },
  ];
  const reply = await aiService.chat(messages, system, opts.providerId, { maxTokens: 400 });
  return { kind: 'text', summary: stripFences(String(reply || '').trim()) };
}

// Recursively walks a Tiptap JSON tree and pulls plain text. Used by
// summarizeDocWithAI as a fallback when contentText is missing.
function extractTextFromTiptapJson(node) {
  if (!node || typeof node !== 'object') return '';
  const parts = [];
  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (typeof n.text === 'string') parts.push(n.text);
    if (n.type === 'mention' && n.attrs?.label) parts.push(`@${n.attrs.label}`);
    if ((n.type === 'taskChip' || n.type === 'task-chip') && n.attrs?.label) parts.push(`+${n.attrs.label}`);
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock'].includes(n.type)) {
      parts.push('\n');
    }
  }
  walk(node);
  return parts.join('').replace(/\n{3,}/g, '\n\n');
}

// ─── suggest priority ────────────────────────────────────────

const ALLOWED_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const PRIORITY_FALLBACK = {
  priority: 'medium',
  reason: 'Could not parse a structured suggestion from the AI; defaulted to medium.',
  suggestedDueDate: null,
};

async function suggestPriorityWithAI(user, { taskTitle, taskDescription, boardId } = {}, opts = {}) {
  if (!taskTitle || typeof taskTitle !== 'string') {
    throw new Error('taskTitle is required');
  }

  let ctx = '';
  if (boardId) {
    ctx = await buildScopeContext(user, { scope: 'board', scopeId: boardId }) || '';
  }

  const system = buildSuggestPrioritySystemPrompt(user, ctx);
  const userPrompt =
    `Task title: ${taskTitle}\n` +
    (taskDescription ? `Description: ${truncate(taskDescription, 1200)}\n` : '') +
    `\nSuggest a priority for THIS task. Reply ONLY with JSON inside a fenced block.`;

  const reply = await aiService.chat(
    [{ role: 'user', content: userPrompt }],
    system,
    opts.providerId,
  );

  const parsed = parseFencedJSON(reply);
  if (!parsed) {
    safeLogger.warn('[aiSummary] suggestPriority: AI returned non-JSON; falling back', { reply: truncate(reply, 200) });
    return { kind: 'structured', ...PRIORITY_FALLBACK };
  }
  const priority = ALLOWED_PRIORITIES.includes(parsed.priority) ? parsed.priority : PRIORITY_FALLBACK.priority;
  const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
    ? parsed.reason.trim().slice(0, 280)
    : PRIORITY_FALLBACK.reason;
  const suggestedDueDate = isIsoDate(parsed.suggestedDueDate) ? parsed.suggestedDueDate : null;
  return { kind: 'structured', priority, reason, suggestedDueDate };
}

// ─── plan week ───────────────────────────────────────────────

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

async function planWeekWithAI(user, _payload = {}, opts = {}) {
  // Load the canonical open-task list ONCE. We use the same data for:
  //   1. building the planning context the LLM sees, and
  //   2. validating that every taskId the LLM emits actually exists.
  //
  // Previously the frontend sent a separate "bias hint" list of task IDs
  // (loaded by /tasks?assignedTo=me&limit=100 with NO status filter) while
  // the backend independently re-queried with a status filter and limit:40.
  // The two lists disagreed, the LLM was instructed to "use only IDs in
  // the planning context" but also "bias to these hint IDs", and it
  // gave up with notes like "No task IDs from the provided list match the
  // current open tasks." Using one source of truth eliminates the mismatch.
  let planning;
  try {
    planning = await loadPlanningTaskList(user);
  } catch (err) {
    safeLogger.warn('[aiSummary] planWeek: loadPlanningTaskList failed', { err });
    return { kind: 'structured', schedule: emptySchedule(), notes: 'Could not load your open tasks. Try again in a moment.' };
  }

  if (!planning || !Array.isArray(planning.tasks) || planning.tasks.length === 0) {
    return { kind: 'structured', schedule: emptySchedule(), notes: 'No open tasks to plan — your queue is empty.' };
  }

  const { context, allowedIds, tasks } = planning;
  const system = buildPlanWeekSystemPrompt(user, context);
  const userPrompt = 'Plan a realistic Mon-Fri schedule from my open tasks. Honor priorities and due dates. Return ONLY a JSON object inside a fenced block. Every taskId you output MUST appear verbatim in the PLANNING CONTEXT above.';

  const reply = await aiService.chat(
    [{ role: 'user', content: userPrompt }],
    system,
    opts.providerId,
  );

  const parsed = parseFencedJSON(reply);
  if (!parsed || !Array.isArray(parsed.schedule)) {
    safeLogger.warn('[aiSummary] planWeek: AI returned non-JSON; falling back to deterministic schedule', { reply: truncate(reply, 200) });
    return {
      kind: 'structured',
      schedule: buildDeterministicSchedule(tasks),
      notes: 'AI response was unstructured — showing a priority-based fallback plan.',
    };
  }

  // Validate every taskId against the canonical allowed-ID set. This is the
  // safety net that prevents hallucinated IDs from rendering as empty chips
  // in the UI and prevents the modal from showing a confusing "no IDs match"
  // empty state when the AI returned something genuinely useful.
  const seen = new Set();
  let droppedCount = 0;
  let keptCount = 0;
  const cleaned = parsed.schedule
    .filter((d) => d && DAY_KEYS.includes(d.dayKey))
    .map((d) => {
      const rawIds = Array.isArray(d.taskIds) ? d.taskIds : [];
      const validIds = [];
      for (const raw of rawIds) {
        if (typeof raw !== 'string') { droppedCount++; continue; }
        const id = raw.trim();
        if (!id || !allowedIds.has(id) || seen.has(id)) { droppedCount++; continue; }
        seen.add(id);
        validIds.push(id);
        if (validIds.length >= 20) break;
      }
      keptCount += validIds.length;
      return {
        dayKey: d.dayKey,
        taskIds: validIds,
        reason: typeof d.reason === 'string' ? d.reason.slice(0, 240) : '',
      };
    });

  // If the AI returned a structured plan but every ID was invalid (e.g.
  // hallucinated UUIDs, or it echoed back stale task references), fall
  // back to the deterministic schedule rather than showing the user
  // empty day columns and an unhelpful note.
  if (keptCount === 0) {
    safeLogger.warn('[aiSummary] planWeek: AI returned 0 valid task IDs after validation; using deterministic fallback', {
      dropped: droppedCount,
      allowedCount: allowedIds.size,
    });
    return {
      kind: 'structured',
      schedule: buildDeterministicSchedule(tasks),
      notes: 'AI suggested tasks not in your current open list — showing a priority-based fallback plan instead.',
    };
  }

  const aiNotes = typeof parsed.notes === 'string' ? parsed.notes.slice(0, 600) : '';
  const notes = droppedCount > 0
    ? (aiNotes ? `${aiNotes} (${droppedCount} suggested item${droppedCount === 1 ? '' : 's'} not in your open list and skipped.)` : `${droppedCount} suggested item${droppedCount === 1 ? '' : 's'} not in your open list — skipped.`)
    : aiNotes;

  return {
    kind: 'structured',
    schedule: cleaned,
    notes,
  };
}

// Deterministic Mon-Fri schedule built straight from the user's open tasks.
// Used when the AI ignores the schema or hallucinates IDs. The shape mirrors
// what the LLM should have returned, so the UI renders identically.
//
// Distribution policy (no AI involved):
//   - Overdue + due-today go onto Mon/Tue (front-loaded so the user clears
//     the backlog).
//   - Due-this-week spread across Wed/Thu.
//   - Everything else (later / no due date), highest priority first, on Fri.
//   - Cap at 3 tasks per day to keep the day card readable.
function buildDeterministicSchedule(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return emptySchedule();

  const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  function rankOf(t) {
    return PRIORITY_RANK[t?.priority] ?? 4;
  }
  function byPriorityThenDueDate(a, b) {
    const r = rankOf(a) - rankOf(b);
    if (r !== 0) return r;
    const ad = a?.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const bd = b?.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    return ad - bd;
  }

  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const tomorrow0 = new Date(today0.getTime() + 86400000);
  const endOfWeek = new Date(today0.getTime() + 7 * 86400000);

  const overdue = [];
  const dueToday = [];
  const dueThisWeek = [];
  const rest = [];
  for (const t of tasks) {
    if (!t?.dueDate) { rest.push(t); continue; }
    const d = new Date(t.dueDate);
    if (d < today0) overdue.push(t);
    else if (d < tomorrow0) dueToday.push(t);
    else if (d < endOfWeek) dueThisWeek.push(t);
    else rest.push(t);
  }
  overdue.sort(byPriorityThenDueDate);
  dueToday.sort(byPriorityThenDueDate);
  dueThisWeek.sort(byPriorityThenDueDate);
  rest.sort(byPriorityThenDueDate);

  const MAX_PER_DAY = 3;
  function take(list, n) {
    return list.splice(0, Math.max(0, n)).map((t) => String(t.id));
  }

  // Front-load Mon/Tue with overdue + due-today.
  const monIds = take([...overdue], MAX_PER_DAY);
  // Remove monIds from overdue
  for (const id of monIds) {
    const idx = overdue.findIndex((t) => String(t.id) === id);
    if (idx >= 0) overdue.splice(idx, 1);
  }
  const tueSeed = [...overdue, ...dueToday];
  tueSeed.sort(byPriorityThenDueDate);
  const tueIds = take(tueSeed, MAX_PER_DAY);
  // Remove tueIds from overdue/dueToday
  for (const id of tueIds) {
    let idx = overdue.findIndex((t) => String(t.id) === id);
    if (idx >= 0) overdue.splice(idx, 1);
    idx = dueToday.findIndex((t) => String(t.id) === id);
    if (idx >= 0) dueToday.splice(idx, 1);
  }

  const wedSeed = [...overdue, ...dueToday, ...dueThisWeek];
  wedSeed.sort(byPriorityThenDueDate);
  const wedIds = take(wedSeed, MAX_PER_DAY);
  for (const id of wedIds) {
    [overdue, dueToday, dueThisWeek].forEach((list) => {
      const idx = list.findIndex((t) => String(t.id) === id);
      if (idx >= 0) list.splice(idx, 1);
    });
  }

  const thuSeed = [...overdue, ...dueToday, ...dueThisWeek];
  thuSeed.sort(byPriorityThenDueDate);
  const thuIds = take(thuSeed, MAX_PER_DAY);
  for (const id of thuIds) {
    [overdue, dueToday, dueThisWeek].forEach((list) => {
      const idx = list.findIndex((t) => String(t.id) === id);
      if (idx >= 0) list.splice(idx, 1);
    });
  }

  const friSeed = [...overdue, ...dueToday, ...dueThisWeek, ...rest];
  friSeed.sort(byPriorityThenDueDate);
  const friIds = take(friSeed, MAX_PER_DAY);

  return [
    { dayKey: 'mon', taskIds: monIds, reason: monIds.length ? 'Overdue items first.' : '' },
    { dayKey: 'tue', taskIds: tueIds, reason: tueIds.length ? 'Remaining overdue and due-today work.' : '' },
    { dayKey: 'wed', taskIds: wedIds, reason: wedIds.length ? 'Mid-week — keep clearing this week\'s work.' : '' },
    { dayKey: 'thu', taskIds: thuIds, reason: thuIds.length ? 'Continue this week\'s priorities.' : '' },
    { dayKey: 'fri', taskIds: friIds, reason: friIds.length ? 'Wrap up with remaining priorities.' : '' },
  ];
}

function emptySchedule() {
  return DAY_KEYS.map((dayKey) => ({ dayKey, taskIds: [], reason: '' }));
}

// ─── prompts ────────────────────────────────────────────────

function buildTaskSummarySystemPrompt(user, ctx, opts) {
  return `You are an AI assistant for Aniston Project Hub. The caller is summarizing ONE specific task.

Style:
- Lead with the bottom line in the FIRST sentence ("This task is …", not "Sure, here's …").
- Be specific. Reference actual statuses, dates, owners from the data.
- Call out blockers, next steps, and risk to the due date.
- Maximum 5 sentences.
- Plain text. No markdown headings. No "Summary:" prefix.

Caller: ${user.name}

########## TASK CONTEXT ##########
${ctx}
########## END ##########`;
}

function buildBoardSummarySystemPrompt(user, ctx, opts) {
  return `You are an AI assistant for Aniston Project Hub. The caller is summarizing an ENTIRE board.

Style:
- 6-8 sentences max. Plain text. No markdown headings.
- Cover in this order: what is done, what is in flight, what is stuck (and why), what is overdue, what to focus on next.
- Reference specific task names when relevant.
- Lead with the bottom line.

Caller: ${user.name}

########## BOARD CONTEXT ##########
${ctx}
########## END ##########`;
}

function buildSuggestPrioritySystemPrompt(user, boardCtx) {
  return `You are helping the caller pick the right priority for a new or unprioritized task.

Allowed priorities: low | medium | high | critical.

Rules:
- Default to medium unless evidence suggests otherwise.
- "critical" requires a clear signal (revenue, blocking other people, customer-facing outage).
- "high" requires a deadline or dependency pressure.
- "low" requires no deadline and no dependency.

OUTPUT FORMAT — return ONLY a JSON object inside a single \`\`\`json fenced block:

\`\`\`json
{
  "priority": "low | medium | high | critical",
  "reason": "one sentence, max 200 chars",
  "suggestedDueDate": "YYYY-MM-DD or null"
}
\`\`\`

No prose outside the fence. No additional fields.

${boardCtx ? `\n########## BOARD CONTEXT (for calibration) ##########\n${boardCtx}\n########## END ##########` : ''}`;
}

function buildPlanWeekSystemPrompt(user, planningCtx) {
  return `You are planning a realistic Monday-to-Friday schedule for the caller from their existing open tasks.

CRITICAL ID rules — read carefully:
- Each task line in the PLANNING CONTEXT below begins with "id=<uuid>" — that uuid is the task's database ID. Use those exact ID strings in your "taskIds" arrays.
- Example: a line like \`• id=7f3a... [high] Ship launch email (status: working_on_it) due 2026-05-20 · board: Q3 Launch\` means you should output the string "7f3a..." in taskIds when you schedule this task.
- DO NOT use task titles, made-up slugs, board names, or invented UUIDs in the output. Only the exact id= values shown.
- A given task ID should appear on at most one day across the whole schedule.
- If you cannot find a relevant ID in the context, leave that day's taskIds empty. An empty day is better than a fabricated ID.

Scheduling rules:
- Mon = today's working start. Spread overdue + due-today onto Mon/Tue. Spread this-week onto Wed/Thu/Fri.
- Do NOT recommend more than 4 tasks per day. Prefer 2-3.
- Reflect priority: critical/high tasks first.
- A given task ID should appear on at most one day.

OUTPUT FORMAT — return ONLY a JSON object inside a single \`\`\`json fenced block:

\`\`\`json
{
  "schedule": [
    { "dayKey": "mon", "taskIds": ["..."], "reason": "one short sentence" },
    { "dayKey": "tue", "taskIds": ["..."], "reason": "..." },
    { "dayKey": "wed", "taskIds": ["..."], "reason": "..." },
    { "dayKey": "thu", "taskIds": ["..."], "reason": "..." },
    { "dayKey": "fri", "taskIds": ["..."], "reason": "..." }
  ],
  "notes": "optional overall observation"
}
\`\`\`

No prose outside the fence.

Caller: ${user.name}

########## PLANNING CONTEXT ##########
${planningCtx}
########## END ##########`;
}

// ─── parsing helpers ─────────────────────────────────────────

function parseFencedJSON(text) {
  if (!text || typeof text !== 'string') return null;
  // Look for a ```json ... ``` fence first; fall back to a plain ``` ``` fence.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  let payload = fence ? fence[1] : text;
  payload = payload.trim();
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    // The model sometimes wraps JSON in extra prose. Try to find the first
    // {...} object via a balanced-brace scan.
    const obj = extractFirstJsonObject(payload);
    if (!obj) return null;
    try { return JSON.parse(obj); } catch { return null; }
  }
}

function extractFirstJsonObject(s) {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function stripFences(s) {
  // The summary prompt asks for plain text but models sometimes wrap things
  // in code fences anyway. Strip them so the UI doesn't render `~~~`.
  if (!s) return '';
  return s.replace(/^```[\w-]*\s*/m, '').replace(/```$/m, '').trim();
}

function isIsoDate(v) {
  if (!v || typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime());
}

function truncate(s, n) {
  if (!s) return '';
  const t = String(s);
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

module.exports = {
  summarizeTaskWithAI,
  summarizeBoardWithAI,
  summarizeDocWithAI,
  suggestPriorityWithAI,
  planWeekWithAI,
  transformInlineWithAI,
  extractActionItemsWithAI,
  AiNotConfiguredError,
  AiScopeUnavailableError,
  INLINE_MODES,
  // Exposed for tests:
  __parseFencedJSON: parseFencedJSON,
  __stripFences: stripFences,
  __buildDeterministicSchedule: buildDeterministicSchedule,
};
