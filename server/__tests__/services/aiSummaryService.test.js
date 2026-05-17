'use strict';

/**
 * Unit tests for aiSummaryService (Plan A Slice 2).
 *
 * Covers:
 *   - text summaries (task / board) flow through aiService.chat
 *     and unwrap fenced output cleanly
 *   - suggestPriority parses fenced JSON, validates the priority enum,
 *     and falls back to "medium" on unparseable AI replies
 *   - planWeek parses fenced JSON, drops invalid dayKeys, and returns
 *     an empty schedule when AI ignores the schema
 *   - AiScopeUnavailableError surfaces when the scope context returns ""
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../services/aiService', () => ({
  chat: jest.fn(),
  classifyError: jest.fn(),
}));

jest.mock('../../services/aiScopeContextService', () => ({
  buildScopeContext: jest.fn(),
}));

jest.mock('../../utils/safeLogger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const aiService = require('../../services/aiService');
const { buildScopeContext } = require('../../services/aiScopeContextService');
const {
  summarizeTaskWithAI, summarizeBoardWithAI,
  suggestPriorityWithAI, planWeekWithAI,
  extractActionItemsWithAI,
  AiScopeUnavailableError,
  __parseFencedJSON, __stripFences,
} = require('../../services/aiSummaryService');

const USER = {
  id: 'u1', name: 'Alice', role: 'manager', isSuperAdmin: false,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('__parseFencedJSON', () => {
  it('returns null for empty / non-string input', () => {
    expect(__parseFencedJSON('')).toBeNull();
    expect(__parseFencedJSON(null)).toBeNull();
    expect(__parseFencedJSON(undefined)).toBeNull();
  });

  it('parses a ```json fenced object', () => {
    const out = __parseFencedJSON('Here you go:\n```json\n{"a":1,"b":"x"}\n```\nThanks!');
    expect(out).toEqual({ a: 1, b: 'x' });
  });

  it('parses a plain ``` fenced object too', () => {
    expect(__parseFencedJSON('```\n{"k":"v"}\n```')).toEqual({ k: 'v' });
  });

  it('extracts the first {…} when the model emits JSON with surrounding prose', () => {
    expect(__parseFencedJSON('Sure: {"priority":"high"} done.')).toEqual({ priority: 'high' });
  });

  it('returns null on unparseable text', () => {
    expect(__parseFencedJSON('definitely not json')).toBeNull();
  });
});

describe('__stripFences', () => {
  it('removes leading and trailing fences', () => {
    expect(__stripFences('```\nhello world\n```')).toBe('hello world');
    expect(__stripFences('```text\nbody\n```')).toBe('body');
  });

  it('leaves regular text untouched', () => {
    expect(__stripFences('plain text')).toBe('plain text');
  });

  it('handles empty input safely', () => {
    expect(__stripFences('')).toBe('');
    expect(__stripFences(null)).toBe('');
  });
});

// ─── summarizeTaskWithAI ────────────────────────────────────

describe('summarizeTaskWithAI', () => {
  it('throws AiScopeUnavailableError when scope context is empty', async () => {
    buildScopeContext.mockResolvedValue('');
    await expect(summarizeTaskWithAI(USER, 't1')).rejects.toBeInstanceOf(AiScopeUnavailableError);
  });

  it('returns { kind: text, summary } when AI replies cleanly', async () => {
    buildScopeContext.mockResolvedValue('TASK SCOPE — fake context');
    aiService.chat.mockResolvedValue('This task is blocked on legal review and at risk of slipping past Friday.');
    const out = await summarizeTaskWithAI(USER, 't1');
    expect(out.kind).toBe('text');
    expect(out.summary).toContain('legal review');
  });

  it('strips fences from the AI reply', async () => {
    buildScopeContext.mockResolvedValue('TASK SCOPE');
    aiService.chat.mockResolvedValue('```\nFenced summary\n```');
    const out = await summarizeTaskWithAI(USER, 't1');
    expect(out.summary).toBe('Fenced summary');
  });
});

// ─── summarizeBoardWithAI ───────────────────────────────────

describe('summarizeBoardWithAI', () => {
  it('throws AiScopeUnavailableError when board context is empty', async () => {
    buildScopeContext.mockResolvedValue('');
    await expect(summarizeBoardWithAI(USER, 'b1')).rejects.toBeInstanceOf(AiScopeUnavailableError);
  });

  it('returns { kind: text, summary } on success', async () => {
    buildScopeContext.mockResolvedValue('BOARD SCOPE');
    aiService.chat.mockResolvedValue('Board is on track. 3 stuck items need attention.');
    const out = await summarizeBoardWithAI(USER, 'b1');
    expect(out).toEqual({ kind: 'text', summary: 'Board is on track. 3 stuck items need attention.' });
  });
});

// ─── suggestPriorityWithAI ──────────────────────────────────

describe('suggestPriorityWithAI', () => {
  it('rejects when taskTitle is missing', async () => {
    await expect(suggestPriorityWithAI(USER, {})).rejects.toThrow();
  });

  it('returns the parsed priority on a clean AI JSON reply', async () => {
    buildScopeContext.mockResolvedValue(''); // no board context
    aiService.chat.mockResolvedValue('```json\n{"priority":"high","reason":"due tomorrow","suggestedDueDate":"2026-05-20"}\n```');
    const out = await suggestPriorityWithAI(USER, { taskTitle: 'Send launch email' });
    expect(out).toEqual({
      kind: 'structured',
      priority: 'high',
      reason: 'due tomorrow',
      suggestedDueDate: '2026-05-20',
    });
  });

  it('rejects invalid priority values and falls back to medium', async () => {
    aiService.chat.mockResolvedValue('```json\n{"priority":"yesterday","reason":"oops"}\n```');
    const out = await suggestPriorityWithAI(USER, { taskTitle: 'X' });
    expect(out.priority).toBe('medium');
    // reason should still come through from the AI
    expect(out.reason).toContain('oops');
  });

  it('drops malformed suggestedDueDate', async () => {
    aiService.chat.mockResolvedValue('```json\n{"priority":"low","reason":"r","suggestedDueDate":"not-a-date"}\n```');
    const out = await suggestPriorityWithAI(USER, { taskTitle: 'X' });
    expect(out.suggestedDueDate).toBeNull();
  });

  it('falls back gracefully when the AI ignores the schema', async () => {
    aiService.chat.mockResolvedValue('Sure — just keep it medium.');
    const out = await suggestPriorityWithAI(USER, { taskTitle: 'X' });
    expect(out.priority).toBe('medium');
    expect(out.reason).toMatch(/Could not parse/);
  });

  it('includes the board context when boardId is provided', async () => {
    buildScopeContext.mockResolvedValue('BOARD SCOPE — recent priorities ...');
    aiService.chat.mockResolvedValue('```json\n{"priority":"high","reason":"matches board norms"}\n```');
    await suggestPriorityWithAI(USER, { taskTitle: 'X', boardId: 'b1' });
    expect(buildScopeContext).toHaveBeenCalledWith(USER, { scope: 'board', scopeId: 'b1' });
  });
});

// ─── planWeekWithAI ─────────────────────────────────────────

describe('planWeekWithAI', () => {
  it('returns an empty schedule when planning context is empty', async () => {
    buildScopeContext.mockResolvedValue('');
    const out = await planWeekWithAI(USER, {});
    expect(out.kind).toBe('structured');
    expect(out.schedule).toHaveLength(5);
    expect(out.schedule.every((d) => d.taskIds.length === 0)).toBe(true);
  });

  it('parses a valid AI JSON schedule', async () => {
    buildScopeContext.mockResolvedValue('PLANNING SCOPE — fake');
    aiService.chat.mockResolvedValue(`\`\`\`json
{
  "schedule": [
    { "dayKey": "mon", "taskIds": ["a", "b"], "reason": "overdue first" },
    { "dayKey": "tue", "taskIds": ["c"],       "reason": "due tomorrow" }
  ],
  "notes": "light week"
}
\`\`\``);
    const out = await planWeekWithAI(USER, {});
    expect(out.kind).toBe('structured');
    const mon = out.schedule.find((d) => d.dayKey === 'mon');
    const tue = out.schedule.find((d) => d.dayKey === 'tue');
    expect(mon.taskIds).toEqual(['a', 'b']);
    expect(tue.taskIds).toEqual(['c']);
    expect(out.notes).toBe('light week');
  });

  it('drops unknown dayKey entries', async () => {
    buildScopeContext.mockResolvedValue('PLANNING SCOPE');
    aiService.chat.mockResolvedValue('```json\n{"schedule":[{"dayKey":"sun","taskIds":["x"]}]}\n```');
    const out = await planWeekWithAI(USER, {});
    // No valid days remain.
    expect(out.schedule.length).toBe(0);
  });

  it('returns an empty schedule when AI returns malformed JSON', async () => {
    buildScopeContext.mockResolvedValue('PLANNING SCOPE');
    aiService.chat.mockResolvedValue('not json');
    const out = await planWeekWithAI(USER, {});
    expect(out.schedule).toHaveLength(5);
    expect(out.schedule.every((d) => d.taskIds.length === 0)).toBe(true);
    expect(out.notes).toMatch(/did not return/);
  });

  it('caps taskIds per day at 20 to prevent runaway responses', async () => {
    buildScopeContext.mockResolvedValue('PLANNING SCOPE');
    const ids = Array.from({ length: 50 }, (_, i) => `t${i}`);
    aiService.chat.mockResolvedValue(`\`\`\`json\n{"schedule":[{"dayKey":"mon","taskIds":${JSON.stringify(ids)}}]}\n\`\`\``);
    const out = await planWeekWithAI(USER, {});
    const mon = out.schedule.find((d) => d.dayKey === 'mon');
    expect(mon.taskIds.length).toBeLessThanOrEqual(20);
  });
});

// ─── extractActionItemsWithAI ───────────────────────────────
//
// Notetaker companion. Stateless — does not load any scope context.
// The AI is told to return a fenced JSON object of action items; the
// service sanitizes each row (priority enum, ISO date, owner 80-char cap)
// and caps the array at 12.

describe('extractActionItemsWithAI', () => {
  it('throws when text is missing or empty / whitespace-only', async () => {
    await expect(extractActionItemsWithAI()).rejects.toThrow(/text is required/);
    await expect(extractActionItemsWithAI({})).rejects.toThrow(/text is required/);
    await expect(extractActionItemsWithAI({ text: '' })).rejects.toThrow(/text is required/);
    await expect(extractActionItemsWithAI({ text: '   \n\t  ' })).rejects.toThrow(/text is required/);
    // aiService.chat must NOT be called when input is invalid.
    expect(aiService.chat).not.toHaveBeenCalled();
  });

  it('happy path: model returns a fenced JSON block with one action', async () => {
    aiService.chat.mockResolvedValue('```json\n{"actions":[{"title":"Ship the auth fix","owner":"Sara","dueDate":"2026-06-13","priority":"high"}]}\n```');
    const out = await extractActionItemsWithAI({ text: 'meeting transcript here' });
    expect(out).toEqual({
      kind: 'structured',
      actions: [{
        title: 'Ship the auth fix',
        owner: 'Sara',
        dueDate: '2026-06-13',
        priority: 'high',
      }],
    });
  });

  it('filters out malformed actions (missing title, empty title, non-objects)', async () => {
    aiService.chat.mockResolvedValue('```json\n{"actions":[' +
      '{"title":"Good one","owner":"Bob"},' +
      '{"title":"","owner":"Eve"},' +
      '{"owner":"NoTitle"},' +
      '{"title":"   "},' +
      'null,' +
      '"not-an-object",' +
      '{"title":"Also good"}' +
    ']}\n```');
    const out = await extractActionItemsWithAI({ text: 'transcript' });
    expect(out.kind).toBe('structured');
    expect(out.actions.map((a) => a.title)).toEqual(['Good one', 'Also good']);
  });

  it('sanitizes invalid priority values to null', async () => {
    aiService.chat.mockResolvedValue('```json\n{"actions":[' +
      '{"title":"A","priority":"urgent"},' +
      '{"title":"B","priority":"HIGH"},' +
      '{"title":"C","priority":"critical"},' +
      '{"title":"D","priority":null}' +
    ']}\n```');
    const out = await extractActionItemsWithAI({ text: 'transcript' });
    expect(out.actions).toEqual([
      { title: 'A', owner: null, dueDate: null, priority: null },   // 'urgent' invalid
      { title: 'B', owner: null, dueDate: null, priority: null },   // case-sensitive
      { title: 'C', owner: null, dueDate: null, priority: 'critical' },
      { title: 'D', owner: null, dueDate: null, priority: null },
    ]);
  });

  it('sanitizes dueDate: non-ISO becomes null, valid ISO preserved', async () => {
    aiService.chat.mockResolvedValue('```json\n{"actions":[' +
      '{"title":"A","dueDate":"Friday"},' +
      '{"title":"B","dueDate":"2026-06-13"},' +
      '{"title":"C","dueDate":"06/13/2026"},' +
      '{"title":"D","dueDate":null}' +
    ']}\n```');
    const out = await extractActionItemsWithAI({ text: 'transcript' });
    expect(out.actions[0].dueDate).toBeNull();          // "Friday"
    expect(out.actions[1].dueDate).toBe('2026-06-13');  // valid ISO
    expect(out.actions[2].dueDate).toBeNull();          // US-style
    expect(out.actions[3].dueDate).toBeNull();
  });

  it('sanitizes owner: trims and caps at 80 chars', async () => {
    const longName = '  ' + 'a'.repeat(200) + '  ';
    aiService.chat.mockResolvedValue(`\`\`\`json\n{"actions":[` +
      `{"title":"A","owner":${JSON.stringify(longName)}},` +
      `{"title":"B","owner":"  Sara  "},` +
      `{"title":"C","owner":""},` +
      `{"title":"D","owner":"   "},` +
      `{"title":"E","owner":42}` +
    `]}\n\`\`\``);
    const out = await extractActionItemsWithAI({ text: 'transcript' });
    expect(out.actions[0].owner).toHaveLength(80);
    expect(out.actions[0].owner).toBe('a'.repeat(80));
    expect(out.actions[1].owner).toBe('Sara');
    expect(out.actions[2].owner).toBeNull();
    expect(out.actions[3].owner).toBeNull();
    expect(out.actions[4].owner).toBeNull(); // non-string
  });

  it('caps the actions list at 12 even if the model returns more', async () => {
    const actions = Array.from({ length: 30 }, (_, i) => ({ title: `Action ${i}` }));
    aiService.chat.mockResolvedValue('```json\n' + JSON.stringify({ actions }) + '\n```');
    const out = await extractActionItemsWithAI({ text: 'long transcript' });
    expect(out.actions).toHaveLength(12);
    expect(out.actions[0].title).toBe('Action 0');
    expect(out.actions[11].title).toBe('Action 11');
  });

  it('returns an empty actions array when the AI reply is non-JSON or empty', async () => {
    aiService.chat.mockResolvedValueOnce('definitely not json at all');
    let out = await extractActionItemsWithAI({ text: 'transcript' });
    expect(out).toEqual({ kind: 'structured', actions: [] });

    aiService.chat.mockResolvedValueOnce('');
    out = await extractActionItemsWithAI({ text: 'transcript' });
    expect(out).toEqual({ kind: 'structured', actions: [] });

    // Fenced JSON with the wrong shape (no `actions` array) also degrades to [].
    aiService.chat.mockResolvedValueOnce('```json\n{"foo":"bar"}\n```');
    out = await extractActionItemsWithAI({ text: 'transcript' });
    expect(out).toEqual({ kind: 'structured', actions: [] });
  });

  it('truncates very long input (> 8000 chars) before sending to aiService.chat', async () => {
    aiService.chat.mockResolvedValue('```json\n{"actions":[]}\n```');
    const giantText = 'x'.repeat(20000);
    await extractActionItemsWithAI({ text: giantText });
    expect(aiService.chat).toHaveBeenCalledTimes(1);
    const [messages] = aiService.chat.mock.calls[0];
    const userContent = messages[0].content;
    // The transcript section is wrapped in `"""…"""`. The wrapper plus
    // surrounding prompt adds a small overhead, but the embedded transcript
    // should be at most 8000 chars (truncate() caps at n-1 + '…').
    expect(userContent).toContain('Transcript:');
    // Pull out just what's between the triple-quote fences.
    const match = /"""\n([\s\S]*?)\n"""/.exec(userContent);
    expect(match).not.toBeNull();
    const sentTranscript = match[1];
    expect(sentTranscript.length).toBeLessThanOrEqual(8000);
    // The truncation marker proves the long input got trimmed (not sent whole).
    expect(sentTranscript.endsWith('…')).toBe(true);
    // And it must definitely not still be the full 20k payload.
    expect(sentTranscript.length).toBeLessThan(giantText.length);
  });
});
