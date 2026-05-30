'use strict';

/**
 * Phase 3 — manual share endpoints (GET/POST/PATCH/DELETE
 * /api/docs/:id/collaborators). Smoke coverage for the gate + the
 * happy path. Deep semantics live in docAccessService tests.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  Doc: { findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn() },
  DocVersion: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), count: jest.fn() },
  DocAccess: {
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
  },
  DocMention: { findAll: jest.fn() },
  DocTaskReference: { findAll: jest.fn() },
  Task: { findByPk: jest.fn(), findAll: jest.fn() },
  Board: { findByPk: jest.fn(), findAll: jest.fn() },
  Workspace: { findByPk: jest.fn() },
  User: { findByPk: jest.fn() },
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

const { Doc, DocAccess, User } = require('../../models');
const docCtrl = require('../../controllers/docController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const OWNER = { id: 'u-owner', role: 'member', isSuperAdmin: false };
const SUPER = { id: 'u-super', role: 'admin', isSuperAdmin: true };
const NON_OWNER = { id: 'u-other', role: 'member', isSuperAdmin: false };
const TARGET = { id: 'u-target', name: 'Target User', email: 't@a.com', avatar: null, isActive: true };

function makeDoc(overrides = {}) {
  return {
    id: 'd1',
    ownerUserId: OWNER.id,
    title: 'Test Doc',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('listCollaborators', () => {
  test('owner can list (200 with owner + collaborators)', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    User.findByPk.mockResolvedValue({ id: OWNER.id, name: 'Owner', email: 'o@a.com', avatar: null });
    DocAccess.findAll.mockResolvedValue([
      {
        userId: 'u-shared',
        toJSON: () => ({
          id: 'a1', user: { id: 'u-shared', name: 'Shared', email: 's@a.com', avatar: null },
          accessLevel: 'comment', source: 'manual_share', createdAt: new Date(), updatedAt: new Date(),
        }),
      },
      {
        userId: OWNER.id, // owner's own grant row — excluded from the collaborators list
        toJSON: () => ({
          id: 'a2', user: { id: OWNER.id }, accessLevel: 'owner', source: 'owner',
        }),
      },
    ]);

    const req = { user: OWNER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.listCollaborators(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.owner.id).toBe(OWNER.id);
    expect(payload.data.collaborators).toHaveLength(1); // owner row excluded
    expect(payload.data.collaborators[0].accessLevel).toBe('comment');
  });

  test('non-owner with view access can still list collaborators', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    DocAccess.findOne.mockResolvedValue({ accessLevel: 'view' }); // NON_OWNER has view
    User.findByPk.mockResolvedValue({ id: OWNER.id, name: 'Owner', email: 'o@a.com', avatar: null });
    DocAccess.findAll.mockResolvedValue([]);

    const req = { user: NON_OWNER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.listCollaborators(req, res);

    expect(res.json).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  test('user with no access gets 403', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    DocAccess.findOne.mockResolvedValue(null); // no grant

    const req = { user: NON_OWNER, params: { id: 'd1' } };
    const res = mockRes();
    await docCtrl.listCollaborators(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('addCollaborator', () => {
  test('400 when userId is missing', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    const req = { user: OWNER, params: { id: 'd1' }, body: {} };
    const res = mockRes();
    await docCtrl.addCollaborator(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('400 when accessLevel is invalid', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    const req = { user: OWNER, params: { id: 'd1' }, body: { userId: 'u-target', accessLevel: 'admin' } };
    const res = mockRes();
    await docCtrl.addCollaborator(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('403 when caller is not owner', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    DocAccess.findOne.mockResolvedValue({ accessLevel: 'edit' }); // non-owner edit grant
    const req = { user: NON_OWNER, params: { id: 'd1' }, body: { userId: 'u-target', accessLevel: 'comment' } };
    const res = mockRes();
    await docCtrl.addCollaborator(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(DocAccess.create).not.toHaveBeenCalled();
  });

  test('400 when trying to add the owner', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    const req = { user: OWNER, params: { id: 'd1' }, body: { userId: OWNER.id, accessLevel: 'comment' } };
    const res = mockRes();
    await docCtrl.addCollaborator(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('404 when target user is inactive', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    User.findByPk.mockResolvedValueOnce({ id: 'u-target', isActive: false });
    const req = { user: OWNER, params: { id: 'd1' }, body: { userId: 'u-target', accessLevel: 'comment' } };
    const res = mockRes();
    await docCtrl.addCollaborator(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('201 on happy path inserts the grant', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    User.findByPk.mockResolvedValue(TARGET);
    DocAccess.findOne
      .mockResolvedValueOnce(null) // upsertAccess existing check
      .mockResolvedValueOnce({ // reload after create
        toJSON: () => ({
          id: 'a-new', accessLevel: 'comment', source: 'manual_share',
          user: { id: TARGET.id, name: TARGET.name, email: TARGET.email, avatar: null },
          grantedBy: null, createdAt: new Date(), updatedAt: new Date(),
        }),
      });
    DocAccess.create.mockResolvedValue({ id: 'a-new' });

    const req = { user: OWNER, params: { id: 'd1' }, body: { userId: TARGET.id, accessLevel: 'comment' } };
    const res = mockRes();
    await docCtrl.addCollaborator(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(DocAccess.create).toHaveBeenCalledWith(expect.objectContaining({
      docId: 'd1',
      userId: TARGET.id,
      accessLevel: 'comment',
      source: 'manual_share',
      grantedByUserId: OWNER.id,
    }));
  });

  test('super-admin can add a collaborator even when not the owner', async () => {
    // 17.7a bypass — super-admin treated as owner everywhere.
    Doc.findByPk.mockResolvedValue(makeDoc());
    User.findByPk.mockResolvedValue(TARGET);
    DocAccess.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      toJSON: () => ({ id: 'a-new', accessLevel: 'edit', source: 'manual_share', user: TARGET }),
    });
    DocAccess.create.mockResolvedValue({ id: 'a-new' });

    const req = { user: SUPER, params: { id: 'd1' }, body: { userId: TARGET.id, accessLevel: 'edit' } };
    const res = mockRes();
    await docCtrl.addCollaborator(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('removeCollaborator', () => {
  test('403 when caller is not owner', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    DocAccess.findOne.mockResolvedValue({ accessLevel: 'edit' });
    const req = { user: NON_OWNER, params: { id: 'd1', userId: 'u-target' } };
    const res = mockRes();
    await docCtrl.removeCollaborator(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('400 when trying to remove the owner', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    const req = { user: OWNER, params: { id: 'd1', userId: OWNER.id } };
    const res = mockRes();
    await docCtrl.removeCollaborator(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('404 when no grant exists for that user', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    DocAccess.findOne.mockResolvedValue(null);
    const req = { user: OWNER, params: { id: 'd1', userId: 'u-target' } };
    const res = mockRes();
    await docCtrl.removeCollaborator(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('200 destroys the row on happy path', async () => {
    const destroy = jest.fn().mockResolvedValue(undefined);
    Doc.findByPk.mockResolvedValue(makeDoc());
    DocAccess.findOne.mockResolvedValue({ destroy });

    const req = { user: OWNER, params: { id: 'd1', userId: 'u-target' } };
    const res = mockRes();
    await docCtrl.removeCollaborator(req, res);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ docId: 'd1', userId: 'u-target' }),
    }));
  });
});

describe('updateCollaborator', () => {
  test('400 when accessLevel is invalid', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    const req = { user: OWNER, params: { id: 'd1', userId: 'u-target' }, body: { accessLevel: 'owner' } };
    const res = mockRes();
    await docCtrl.updateCollaborator(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('400 when trying to change the owner row', async () => {
    Doc.findByPk.mockResolvedValue(makeDoc());
    const req = { user: OWNER, params: { id: 'd1', userId: OWNER.id }, body: { accessLevel: 'edit' } };
    const res = mockRes();
    await docCtrl.updateCollaborator(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('200 changes accessLevel and pins source to manual_share', async () => {
    const update = jest.fn().mockResolvedValue(undefined);
    Doc.findByPk.mockResolvedValue(makeDoc());
    DocAccess.findOne
      .mockResolvedValueOnce({ update }) // initial lookup
      .mockResolvedValueOnce({ // reload after update
        toJSON: () => ({
          id: 'a1', accessLevel: 'edit', source: 'manual_share',
          user: { id: 'u-target', name: 'X', email: 'x@a.com', avatar: null },
          grantedBy: null, createdAt: new Date(), updatedAt: new Date(),
        }),
      });

    const req = { user: OWNER, params: { id: 'd1', userId: 'u-target' }, body: { accessLevel: 'edit' } };
    const res = mockRes();
    await docCtrl.updateCollaborator(req, res);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      accessLevel: 'edit',
      source: 'manual_share',
      grantedByUserId: OWNER.id,
    }));
  });
});
