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
  listMyDocs,
  listWorkspaceDocs, // backward-compat shim — still tested below
  createDoc,
  getDoc,
  updateDoc,
  archiveDoc,
  restoreDoc,
  listVersions,
  restoreVersion,
  migrateDocToCollab,
} from '../docsService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('docsService client wrappers', () => {
  // ─── Phase 2 — personal docs surface ───────────────────────────

  it('listMyDocs GETs /docs with q + archived params', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { docs: [{ id: 'd1' }] } },
    });
    const out = await listMyDocs({ q: 'spec', archived: true });
    expect(api.get).toHaveBeenCalledWith('/docs', {
      params: { q: 'spec', archived: '1' },
    });
    expect(out.docs).toEqual([{ id: 'd1' }]);
  });

  it('listMyDocs omits q and archived when not provided', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { docs: [] } } });
    await listMyDocs();
    expect(api.get).toHaveBeenCalledWith('/docs', { params: {} });
  });

  it('listMyDocs forwards filter param when provided', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { docs: [] } } });
    await listMyDocs({ filter: 'owned' });
    expect(api.get).toHaveBeenCalledWith('/docs', { params: { filter: 'owned' } });
  });

  it('listWorkspaceDocs is a backward-compat shim that ignores workspaceId', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { docs: [{ id: 'd1' }] } },
    });
    // workspaceId param is intentionally discarded — call should go to /docs.
    await listWorkspaceDocs('w1', { q: 'spec' });
    expect(api.get).toHaveBeenCalledWith('/docs', { params: { q: 'spec' } });
  });

  it('createDoc POSTs /docs with body (no workspaceId)', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { doc: { id: 'd1', title: 'Hi' } } },
    });
    const out = await createDoc({ title: 'Hi' });
    expect(api.post).toHaveBeenCalledWith('/docs', { title: 'Hi' });
    expect(out.doc.id).toBe('d1');
  });

  it('createDoc forwards contentFormat when set', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { doc: { id: 'd2' } } },
    });
    await createDoc({ title: 'BN doc', contentFormat: 'blocknote_json' });
    expect(api.post).toHaveBeenCalledWith('/docs', {
      title: 'BN doc',
      contentFormat: 'blocknote_json',
    });
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
    let out = await listMyDocs();
    expect(out).toEqual({ docs: ['nested'] });

    // Flat {data:{...}} shape (no nested data wrapper)
    api.get.mockResolvedValue({ data: { docs: ['flat'] } });
    out = await listMyDocs();
    expect(out).toEqual({ docs: ['flat'] });

    // Completely empty/missing response
    api.get.mockResolvedValue({});
    out = await listMyDocs();
    expect(out).toEqual({});
  });

  // ─── Phase G follow-up — migrateDocToCollab ────────────────────

  it('migrateDocToCollab POSTs /docs/:id/migrate-to-collab', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { doc: { id: 'd1', yjsState: 'present' }, alreadyMigrated: false } },
    });
    const out = await migrateDocToCollab('d1');
    expect(api.post).toHaveBeenCalledWith('/docs/d1/migrate-to-collab');
    expect(out.alreadyMigrated).toBe(false);
  });

  it('migrateDocToCollab throws when docId is missing', async () => {
    await expect(migrateDocToCollab()).rejects.toThrow(/docId/);
    await expect(migrateDocToCollab('')).rejects.toThrow(/docId/);
  });

  it('migrateDocToCollab tolerates flat response shape (defensive)', async () => {
    api.post.mockResolvedValue({ data: { doc: { id: 'd1' }, alreadyMigrated: true } });
    const out = await migrateDocToCollab('d1');
    expect(out.alreadyMigrated).toBe(true);
  });
});
