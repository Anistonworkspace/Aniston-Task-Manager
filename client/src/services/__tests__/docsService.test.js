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
import {
  listWorkspaceDocs,
  createDoc,
  getDoc,
  updateDoc,
  archiveDoc,
  restoreDoc,
  listVersions,
  restoreVersion,
} from '../docsService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('docsService client wrappers', () => {
  it('listWorkspaceDocs GETs /workspaces/:id/docs with q + archived params', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { docs: [{ id: 'd1' }] } },
    });
    const out = await listWorkspaceDocs('w1', { q: 'spec', archived: true });
    expect(api.get).toHaveBeenCalledWith('/workspaces/w1/docs', {
      params: { q: 'spec', archived: '1' },
    });
    expect(out.docs).toEqual([{ id: 'd1' }]);
  });

  it('listWorkspaceDocs omits q and archived when not provided', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { docs: [] } } });
    await listWorkspaceDocs('w1');
    expect(api.get).toHaveBeenCalledWith('/workspaces/w1/docs', { params: {} });
  });

  it('listWorkspaceDocs throws when workspaceId is missing', async () => {
    await expect(listWorkspaceDocs()).rejects.toThrow(/workspaceId/);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('createDoc POSTs /workspaces/:id/docs with body and throws on missing workspaceId', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { doc: { id: 'd1', title: 'Hi' } } },
    });
    const out = await createDoc('w1', { title: 'Hi' });
    expect(api.post).toHaveBeenCalledWith('/workspaces/w1/docs', { title: 'Hi' });
    expect(out.doc.id).toBe('d1');

    await expect(createDoc()).rejects.toThrow(/workspaceId/);
  });

  it('getDoc GETs /docs/:id and throws when id is missing', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { doc: { id: 'd1' } } },
    });
    const out = await getDoc('d1');
    expect(api.get).toHaveBeenCalledWith('/docs/d1');
    expect(out.doc.id).toBe('d1');

    await expect(getDoc()).rejects.toThrow(/id/);
  });

  it('updateDoc PATCHes /docs/:id with the patch body', async () => {
    api.patch.mockResolvedValue({
      data: { success: true, data: { doc: { id: 'd1', title: 'Renamed' } } },
    });
    const out = await updateDoc('d1', { title: 'Renamed' });
    expect(api.patch).toHaveBeenCalledWith('/docs/d1', { title: 'Renamed' });
    expect(out.doc.title).toBe('Renamed');

    await expect(updateDoc()).rejects.toThrow(/id/);
  });

  it('archiveDoc DELETEs /docs/:id', async () => {
    api.delete.mockResolvedValue({
      data: { success: true, data: { doc: { id: 'd1', isArchived: true } } },
    });
    const out = await archiveDoc('d1');
    expect(api.delete).toHaveBeenCalledWith('/docs/d1');
    expect(out.doc.isArchived).toBe(true);

    await expect(archiveDoc()).rejects.toThrow(/id/);
  });

  it('restoreDoc POSTs /docs/:id/restore', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { doc: { id: 'd1', isArchived: false } } },
    });
    const out = await restoreDoc('d1');
    expect(api.post).toHaveBeenCalledWith('/docs/d1/restore');
    expect(out.doc.isArchived).toBe(false);

    await expect(restoreDoc()).rejects.toThrow(/id/);
  });

  it('listVersions GETs /docs/:id/versions', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { versions: [{ id: 'v1' }, { id: 'v2' }] } },
    });
    const out = await listVersions('d1');
    expect(api.get).toHaveBeenCalledWith('/docs/d1/versions');
    expect(out.versions).toHaveLength(2);

    await expect(listVersions()).rejects.toThrow(/id/);
  });

  it('restoreVersion POSTs /docs/:docId/versions/:versionId/restore', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { doc: { id: 'd1' } } },
    });
    const out = await restoreVersion('d1', 'v9');
    expect(api.post).toHaveBeenCalledWith('/docs/d1/versions/v9/restore');
    expect(out.doc.id).toBe('d1');

    await expect(restoreVersion('d1')).rejects.toThrow(/docId and versionId/);
    await expect(restoreVersion()).rejects.toThrow(/docId and versionId/);
  });

  it('unwrap helper: prefers res.data.data, falls back to res.data, then {}', async () => {
    // Nested {success,data} shape (the canonical backend format)
    api.get.mockResolvedValue({ data: { success: true, data: { docs: ['nested'] } } });
    let out = await listWorkspaceDocs('w1');
    expect(out).toEqual({ docs: ['nested'] });

    // Flat {data:{...}} shape (no nested data wrapper)
    api.get.mockResolvedValue({ data: { docs: ['flat'] } });
    out = await listWorkspaceDocs('w1');
    expect(out).toEqual({ docs: ['flat'] });

    // Completely empty/missing response
    api.get.mockResolvedValue({});
    out = await listWorkspaceDocs('w1');
    expect(out).toEqual({});
  });
});
