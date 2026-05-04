'use strict';

/**
 * Defense-in-depth coverage for `getArchivedWorkspaces`.
 *
 * The route layer guards `/api/workspaces/archived` with
 * `requireRole('manager','admin')`. The controller now ALSO refuses
 * non-management roles directly, so a future regression in the auth
 * middleware (e.g. the Layer-3 escalation we fixed on 2026-05-04) cannot
 * leak archived workspace names. These tests pin that guarantee.
 */

jest.mock('../../models', () => ({
  Workspace: { findAll: jest.fn() },
  Board:     {},
  User:      {},
}));

const { Workspace } = require('../../models');
const { getArchivedWorkspaces } = require('../../controllers/workspaceController');

function buildReq(user) {
  return { user, params: {}, body: {}, query: {} };
}
function buildRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('getArchivedWorkspaces — controller defense-in-depth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 for member even if the route guard was bypassed', async () => {
    const req = buildReq({ id: 'm', role: 'member', isSuperAdmin: false });
    const res = buildRes();
    await getArchivedWorkspaces(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Workspace.findAll).not.toHaveBeenCalled();
  });

  it('returns 403 for assistant_manager even if the route guard was bypassed', async () => {
    const req = buildReq({ id: 'a', role: 'assistant_manager', isSuperAdmin: false });
    const res = buildRes();
    await getArchivedWorkspaces(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Workspace.findAll).not.toHaveBeenCalled();
  });

  it('returns the archived list for a manager', async () => {
    Workspace.findAll.mockResolvedValue([{ id: 'w1', name: 'Old WS' }]);
    const req = buildReq({ id: 'mgr', role: 'manager', isSuperAdmin: false });
    const res = buildRes();
    await getArchivedWorkspaces(req, res);
    expect(Workspace.findAll).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { workspaces: [{ id: 'w1', name: 'Old WS' }] } })
    );
  });

  it('returns the archived list for an admin', async () => {
    Workspace.findAll.mockResolvedValue([]);
    const req = buildReq({ id: 'adm', role: 'admin', isSuperAdmin: false });
    const res = buildRes();
    await getArchivedWorkspaces(req, res);
    expect(Workspace.findAll).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { workspaces: [] } })
    );
  });

  it('returns the archived list for a super admin even if their role is "member"', async () => {
    Workspace.findAll.mockResolvedValue([]);
    const req = buildReq({ id: 'sa', role: 'member', isSuperAdmin: true });
    const res = buildRes();
    await getArchivedWorkspaces(req, res);
    expect(Workspace.findAll).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
