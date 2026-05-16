import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api', () => ({
  default: { post: vi.fn() },
}));

import api from '../api';
import { summarizeTask, summarizeBoard, suggestPriority, planWeek } from '../aiSummaryService';

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
});
