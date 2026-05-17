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
import { listMentionableUsers } from '../docsService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('docsService.listMentionableUsers (Phase D Slice 1)', () => {
  it('GETs /docs/mentionable with params { workspaceId, q } and unwraps the response', async () => {
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          users: [
            { id: 'u1', name: 'Alice', email: 'a@x', avatar: null },
            { id: 'u2', name: 'Bob', email: 'b@x', avatar: null },
          ],
        },
      },
    });

    const out = await listMentionableUsers('w1', { q: 'al' });

    expect(api.get).toHaveBeenCalledWith('/docs/mentionable', {
      params: { workspaceId: 'w1', q: 'al' },
    });
    expect(out.users).toHaveLength(2);
    expect(out.users[0]).toMatchObject({ id: 'u1', name: 'Alice' });
  });

  it('rejects when workspaceId is missing', async () => {
    await expect(listMentionableUsers()).rejects.toThrow(/workspaceId/);
    await expect(listMentionableUsers(undefined, { q: 'x' })).rejects.toThrow(/workspaceId/);
    expect(api.get).not.toHaveBeenCalled();
  });
});
