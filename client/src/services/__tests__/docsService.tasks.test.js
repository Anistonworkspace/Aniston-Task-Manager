import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import api from '../api';
import { listSearchableTasks, getTaskDocReferences } from '../docsService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('docsService.listSearchableTasks (Phase D Slice 2)', () => {
  it('GETs /docs/searchable-tasks with params { workspaceId, q } and unwraps response', async () => {
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          tasks: [
            { id: 't1', title: 'Ship docs', status: 'working_on_it', boardId: 'b1', boardName: 'Eng', boardColor: '#22c55e' },
            { id: 't2', title: 'Q3 review',  status: 'done',          boardId: 'b2', boardName: 'Strategy' },
          ],
        },
      },
    });

    const out = await listSearchableTasks('w1', { q: 'ship' });

    expect(api.get).toHaveBeenCalledWith('/docs/searchable-tasks', {
      params: { workspaceId: 'w1', q: 'ship' },
    });
    expect(out.tasks).toHaveLength(2);
    expect(out.tasks[0]).toMatchObject({ id: 't1', title: 'Ship docs' });
  });

  it('passes q as undefined when not supplied (still calls api.get)', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { tasks: [] } } });
    await listSearchableTasks('w1');
    expect(api.get).toHaveBeenCalledWith('/docs/searchable-tasks', {
      params: { workspaceId: 'w1', q: undefined },
    });
  });

  it('rejects when workspaceId is missing', async () => {
    await expect(listSearchableTasks()).rejects.toThrow(/workspaceId/);
    await expect(listSearchableTasks(undefined, { q: 'x' })).rejects.toThrow(/workspaceId/);
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('docsService.getTaskDocReferences (Phase D Slice 2)', () => {
  it('GETs /tasks/:id/doc-references and unwraps the response', async () => {
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          docs: [
            { id: 'd1', title: 'PRD',      workspaceId: 'w1' },
            { id: 'd2', title: 'Roadmap',  workspaceId: 'w1' },
          ],
        },
      },
    });

    const out = await getTaskDocReferences('t1');

    expect(api.get).toHaveBeenCalledWith('/tasks/t1/doc-references');
    expect(out.docs).toHaveLength(2);
    expect(out.docs[0]).toMatchObject({ id: 'd1', title: 'PRD' });
  });

  it('rejects when taskId is missing', async () => {
    await expect(getTaskDocReferences()).rejects.toThrow(/taskId/);
    await expect(getTaskDocReferences('')).rejects.toThrow(/taskId/);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('returns {} when the server responds with no body shape at all', async () => {
    api.get.mockResolvedValue({});
    const out = await getTaskDocReferences('t1');
    expect(out).toEqual({});
  });
});
