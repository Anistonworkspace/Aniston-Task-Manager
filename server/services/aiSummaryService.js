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
const { buildScopeContext } = require('./aiScopeContextService');
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

async function planWeekWithAI(user, { taskIds } = {}, opts = {}) {
  // Always reload from the caller's planning context so the AI's plan is
  // grounded in real priorities / due dates / status. We ignore the
  // caller-supplied `taskIds` for visibility — they're only used to bound
  // the response to a relevant subset.
  const ctx = await buildScopeContext(user, { scope: 'planning' });
  if (!ctx) {
    return { kind: 'structured', schedule: emptySchedule(), notes: 'No open tasks to plan.' };
  }

  const system = buildPlanWeekSystemPrompt(user, ctx);
  const userPrompt = Array.isArray(taskIds) && taskIds.length
    ? `Bias the plan to cover these tasks first when reasonable (IDs): ${taskIds.slice(0, 20).join(', ')}.\nReturn ONLY a JSON object inside a fenced block.`
    : `Plan a realistic Mon-Fri schedule from my open tasks. Honor priorities and due dates. Return ONLY a JSON object inside a fenced block.`;

  const reply = await aiService.chat(
    [{ role: 'user', content: userPrompt }],
    system,
    opts.providerId,
  );

  const parsed = parseFencedJSON(reply);
  if (!parsed || !Array.isArray(parsed.schedule)) {
    safeLogger.warn('[aiSummary] planWeek: AI returned non-JSON; falling back to empty schedule', { reply: truncate(reply, 200) });
    return { kind: 'structured', schedule: emptySchedule(), notes: 'AI did not return a structured plan.' };
  }

  const cleaned = parsed.schedule
    .filter((d) => d && DAY_KEYS.includes(d.dayKey))
    .map((d) => ({
      dayKey: d.dayKey,
      taskIds: Array.isArray(d.taskIds) ? d.taskIds.filter((x) => typeof x === 'string').slice(0, 20) : [],
      reason: typeof d.reason === 'string' ? d.reason.slice(0, 240) : '',
    }));

  return {
    kind: 'structured',
    schedule: cleaned,
    notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 600) : '',
  };
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

Rules:
- Use only the task IDs that appear in the PLANNING CONTEXT below.
- Mon = today's working start. Spread overdue + due-today onto Mon/Tue. Spread this-week onto Wed/Thu/Fri.
- Do NOT recommend more than 4 tasks per day. Prefer 2-3.
- Reflect priority: critical/high tasks first.
- If the caller has very little work, leave days empty rather than padding.

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
};
