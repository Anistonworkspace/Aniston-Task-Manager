import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api', () => ({
  default: { post: vi.fn() },
}));

import api from '../api';
import { summarizeTask, summarizeBoard, suggestPriority, planWeek, transformInline, extractActions } from '../aiSummaryService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('aiSummaryService client wrappers', () => {
  it('summarizeTask POSTs to /ai/summarize/task/:id and unwraps {success,data}', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { kind: 'text', summary: 'OK' } } });
    const out = await summarizeTask('t1');
    expect(api.post).toHaveBeenCalledWith('/ai/summarize/task/t1', {});
    expect(out).toEqual({ kind: 'text', summary: 'OK' });
  });

  it('summarizeTask passes providerId through when supplied', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { summary: 'X' } } });
    await summarizeTask('t1', { providerId: 'p9' });
    expect(api.post).toHaveBeenCalledWith('/ai/summarize/task/t1', { providerId: 'p9' });
  });

  it('summarizeTask rejects when taskId is missing', async () => {
    await expect(summarizeTask()).rejects.toThrow();
  });

  it('summarizeBoard POSTs to /ai/summarize/board/:id', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { kind: 'text', summary: 'B' } } });
    const out = await summarizeBoard('b1');
    expect(api.post).toHaveBeenCalledWith('/ai/summarize/board/b1', {});
    expect(out.summary).toBe('B');
  });

  it('suggestPriority POSTs payload and unwraps structured response', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { kind: 'structured', priority: 'high', reason: 'r' } },
    });
    const out = await suggestPriority({ taskTitle: 'Ship the email' });
    expect(api.post).toHaveBeenCalledWith(
      '/ai/suggest-priority',
      expect.objectContaining({ taskTitle: 'Ship the email' })
    );
    expect(out.priority).toBe('high');
  });

  it('suggestPriority rejects when taskTitle is missing', async () => {
    await expect(suggestPriority({})).rejects.toThrow();
  });

  it('planWeek POSTs taskIds when provided', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { kind: 'structured', schedule: [], notes: '' } },
    });
    await planWeek({ taskIds: ['a', 'b'] });
    expect(api.post).toHaveBeenCalledWith(
      '/ai/plan-week',
      expect.objectContaining({ taskIds: ['a', 'b'] })
    );
  });

  it('planWeek skips taskIds when not an array', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { schedule: [] } } });
    await planWeek({ taskIds: 'oops' });
    const call = api.post.mock.calls[0][1];
    expect(call.taskIds).toBeUndefined();
  });

  it('falls back to res.data when there is no nested data wrapper', async () => {
    api.post.mockResolvedValue({ data: { summary: 'flat' } });
    const out = await summarizeTask('t1');
    expect(out.summary).toBe('flat');
  });

  it('returns {} when the server response is missing entirely (defensive)', async () => {
    api.post.mockResolvedValue({});
    const out = await summarizeTask('t1');
    expect(out).toEqual({});
  });

  // ─── Phase E — transformInline ────────────────────────────────

  it('transformInline POSTs to /ai/inline-edit with text + mode', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { kind: 'text', mode: 'improve', output: 'better' } },
    });
    const out = await transformInline({ text: 'hello there', mode: 'improve' });
    expect(api.post).toHaveBeenCalledWith('/ai/inline-edit', {
      text: 'hello there',
      mode: 'improve',
      providerId: undefined,
    });
    expect(out.output).toBe('better');
  });

  it('transformInline forwards providerId when supplied', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { output: 'X' } } });
    await transformInline({ text: 'hi', mode: 'grammar', providerId: 'p1' });
    expect(api.post.mock.calls[0][1].providerId).toBe('p1');
  });

  it('transformInline rejects when text is missing', async () => {
    await expect(transformInline({ mode: 'improve' })).rejects.toThrow();
    await expect(transformInline({ text: '', mode: 'improve' })).rejects.toThrow();
    await expect(transformInline({ text: '   ', mode: 'improve' })).rejects.toThrow();
  });

  it('transformInline rejects when mode is missing', async () => {
    await expect(transformInline({ text: 'hi' })).rejects.toThrow();
    await expect(transformInline({ text: 'hi', mode: '' })).rejects.toThrow();
  });

  // ─── Notetaker — extractActions ───────────────────────────────

  it('extractActions POSTs to /ai/extract-actions with text', async () => {
    api.post.mockResolvedValue({
      data: {
        success: true,
        data: {
          kind: 'structured',
          actions: [
            { title: 'Ship the email', owner: 'Sara', dueDate: '2026-06-01', priority: 'high' },
          ],
        },
      },
    });
    const out = await extractActions({ text: 'Sara: I will ship the email by June 1.' });
    expect(api.post).toHaveBeenCalledWith('/ai/extract-actions', {
      text: 'Sara: I will ship the email by June 1.',
      providerId: undefined,
    });
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].title).toBe('Ship the email');
  });

  it('extractActions forwards providerId when supplied', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { actions: [] } } });
    await extractActions({ text: 'meeting notes', providerId: 'p42' });
    expect(api.post.mock.calls[0][1].providerId).toBe('p42');
  });

  it('extractActions rejects when text is missing / empty / whitespace', async () => {
    await expect(extractActions({})).rejects.toThrow();
    await expect(extractActions({ text: '' })).rejects.toThrow();
    await expect(extractActions({ text: '   ' })).rejects.toThrow();
    await expect(extractActions({ text: 123 })).rejects.toThrow();
  });

  it('extractActions unwraps { success, data: { actions: [...] } } correctly', async () => {
    api.post.mockResolvedValue({
      data: {
        success: true,
        data: {
          actions: [
            { title: 'A', owner: 'Alice' },
            { title: 'B', owner: 'Bob' },
          ],
        },
      },
    });
    const out = await extractActions({ text: 'transcript here' });
    expect(out).toEqual({
      actions: [
        { title: 'A', owner: 'Alice' },
        { title: 'B', owner: 'Bob' },
      ],
    });
  });

  it('extractActions returns {} when response is malformed (defensive)', async () => {
    api.post.mockResolvedValue({});
    const out = await extractActions({ text: 'something' });
    expect(out).toEqual({});
  });
});
