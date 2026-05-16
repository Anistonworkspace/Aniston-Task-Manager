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
