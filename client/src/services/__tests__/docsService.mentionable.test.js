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

describe('docsService.listMentionableUsers (Phase 4 — global mention search)', () => {
  it('GETs /users/mentions with { q } and unwraps the response', async () => {
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

    const out = await listMentionableUsers({ q: 'al' });

    expect(api.get).toHaveBeenCalledWith('/users/mentions', {
      params: { q: 'al' },
    });
    expect(out.users).toHaveLength(2);
    expect(out.users[0]).toMatchObject({ id: 'u1', name: 'Alice' });
  });

  it('omits q when not provided (top-N typeahead seed)', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { users: [] } } });
    await listMentionableUsers();
    expect(api.get).toHaveBeenCalledWith('/users/mentions', { params: {} });
  });

  it('forwards limit when provided', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { users: [] } } });
    await listMentionableUsers({ q: 'sa', limit: 10 });
    expect(api.get).toHaveBeenCalledWith('/users/mentions', {
      params: { q: 'sa', limit: 10 },
    });
  });

  it('backward-compat: accepts the legacy (workspaceId, opts) signature and ignores workspaceId', async () => {
    // Pre-Phase-4 callers passed `listMentionableUsers(workspaceId, { q })`.
    // Phase 4 silently drops workspaceId — same global call shape.
    api.get.mockResolvedValue({ data: { success: true, data: { users: [{ id: 'u1' }] } } });
    await listMentionableUsers('w1', { q: 'sa' });
    expect(api.get).toHaveBeenCalledWith('/users/mentions', {
      params: { q: 'sa' },
    });
  });

  it('does not throw when called with no args (returns the top-N picker seed)', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { users: [] } } });
    await expect(listMentionableUsers()).resolves.toBeDefined();
  });
});
