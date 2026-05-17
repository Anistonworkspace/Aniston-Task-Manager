'use strict';

/**
 * Unit tests for the Phase D Slice 2 task-chip features in docController.
 *
 * Five surfaces are covered:
 *   1. __extractTaskRefs(contentJson) — pure helper exported for tests.
 *   2. syncDocTaskRefs fan-out triggered by createDoc (fire-and-forget).
 *   3. syncDocTaskRefs fan-out triggered by updateDoc (fire-and-forget).
 *   4. listSearchableTasks — GET /api/docs/searchable-tasks endpoint.
 *   5. listDocReferencesForTask — GET /api/tasks/:id/doc-references endpoint.
 *
 * Critical Slice 2 invariant: task-chip sync MUST NOT emit notifications.
 * Task watchers / assignees already get their own task events; layering a
 * "your task was referenced in a doc" notification on top would be noise.
 *
 * All Sequelize models, board-visibility, and notification services are
 * mocked. No real DB or socket I/O.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

const { Op } = require('sequelize');

// ─── Mocks (declared BEFORE the controller is required so the lazy
//     `require('../services/notificationService')` and the inline
//     `require('../models')` inside listSearchableTasks pick up our mocks)
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('../../models', () => ({
  Doc: {
    findByPk: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
  },
  DocVersion: {
    findByPk: jest.fn(),
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  },
  DocMention: {
    findAll: jest.fn(),
    create: jest.fn(),
    destroy: jest.fn(),
  },
  DocTaskReference: {
    findAll: jest.fn(),
    create: jest.fn(),
    destroy: jest.fn(),
  },
  Task: {
    findByPk: jest.fn(),
    findAll: jest.fn(),
  },
  Board: {
    findAll: jest.fn(),
  },
  Workspace: {
    findByPk: jest.fn(),
  },
  User: {},
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../services/boardVisibilityService', () => ({
  canUserSeeBoard: jest.fn(),
}));

const {
  Doc,
  DocVersion,
  DocMention,
  DocTaskReference,
  Task,
  Board,
  Workspace,
} = require('../../models');
const notificationService = require('../../services/notificationService');
const { canUserSeeBoard } = require('../../services/boardVisibilityService');
const docCtrl = require('../../controllers/docController');

const { __extractTaskRefs } = docCtrl;

// ─── shared helpers ────────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

// Yield twice so the fire-and-forget syncDocTaskRefs Promise has time to
// settle (it awaits findAll, then create/destroy) before assertions run.
async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';
const BAD_UUID = 'not-a-uuid';

const ADMIN = { id: 'u-admin', name: 'Admin', role: 'admin', isSuperAdmin: false };
const MANAGER = { id: 'u-manager', name: 'Manager', role: 'manager', isSuperAdmin: false };
const MEMBER = { id: 'u-member', name: 'Mem', role: 'member', isSuperAdmin: false };
const CALLER = { id: 'u-caller', name: 'Caller', role: 'member', isSuperAdmin: false };

function makeWorkspace(overrides = {}) {
  return {
    id: 'w1',
    name: 'Test WS',
    createdBy: ADMIN.id,
    workspaceMembers: [],
    creator: null,
    ...overrides,
  };
}

function makeDoc(overrides = {}) {
  const doc = {
    id: 'd1',
    workspaceId: 'w1',
    title: 'X',
    slug: 'x',
    contentJson: { type: 'doc', content: [] },
    contentText: '',
    sharePolicy: 'workspace',
    isArchived: false,
    archivedAt: null,
    archivedBy: null,
    createdBy: ADMIN.id,
    lastEditedBy: ADMIN.id,
    lastEditedAt: new Date('2026-05-01T00:00:00Z'),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  doc.toJSON = function () {
    const out = {};
    for (const k of Object.keys(this)) {
      if (typeof this[k] !== 'function') out[k] = this[k];
    }
    return out;
  };
  return doc;
}

function taskChip(taskId, label, status, opts = {}) {
  const type = opts.kebab ? 'task-chip' : 'taskChip';
  return { type, attrs: { taskId, label: label || taskId, status: status || 'not_started' } };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible defaults — individual tests override.
  DocMention.findAll.mockResolvedValue([]);
  DocMention.create.mockResolvedValue({});
  DocMention.destroy.mockResolvedValue(0);
  DocTaskReference.findAll.mockResolvedValue([]);
  DocTaskReference.create.mockResolvedValue({});
  DocTaskReference.destroy.mockResolvedValue(0);
  notificationService.createNotification.mockResolvedValue({});
  canUserSeeBoard.mockResolvedValue(true);
});

// ───────────────────────────────────────────────────────────────────────────
// __extractTaskRefs (pure helper)
// ───────────────────────────────────────────────────────────────────────────

describe('__extractTaskRefs', () => {
  test('returns [] for null, undefined, non-object inputs', () => {
    expect(__extractTaskRefs(null)).toEqual([]);
    expect(__extractTaskRefs(undefined)).toEqual([]);
    expect(__extractTaskRefs('not-an-object')).toEqual([]);
    expect(__extractTaskRefs(42)).toEqual([]);
  });

  test('returns [] for an empty doc (no content key, or empty content array)', () => {
    expect(__extractTaskRefs({ type: 'doc' })).toEqual([]);
    expect(__extractTaskRefs({ type: 'doc', content: [] })).toEqual([]);
  });

  test('returns [] for a doc with paragraphs but no task chips', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'No chips here' }] },
      ],
    };
    expect(__extractTaskRefs(doc)).toEqual([]);
  });

  test('extracts a single task chip inside a paragraph', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'See task: ' },
            taskChip(UUID_A, 'Ship it', 'working_on_it'),
          ],
        },
      ],
    };
    const out = __extractTaskRefs(doc);
    expect(out).toHaveLength(1);
    expect(out[0].taskId).toBe(UUID_A);
    expect(typeof out[0].anchorOffset).toBe('number');
  });

  test('walks nested structures (chip inside listItem inside bulletList)', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'do: ' },
                    taskChip(UUID_B, 'Subtask', 'not_started'),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = __extractTaskRefs(doc);
    expect(out).toHaveLength(1);
    expect(out[0].taskId).toBe(UUID_B);
  });

  test('dedupes when the same taskId appears twice', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            taskChip(UUID_A, 'Task A'),
            { type: 'text', text: ' and again ' },
            taskChip(UUID_A, 'Task A'),
          ],
        },
      ],
    };
    const out = __extractTaskRefs(doc);
    expect(out).toHaveLength(1);
    expect(out[0].taskId).toBe(UUID_A);
  });

  test('drops chips with non-UUID taskIds but keeps valid ones', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            taskChip(BAD_UUID, 'Bad'),
            taskChip(UUID_A, 'Good'),
            taskChip('', 'Empty'),
          ],
        },
      ],
    };
    const out = __extractTaskRefs(doc);
    expect(out).toHaveLength(1);
    expect(out[0].taskId).toBe(UUID_A);
  });

  test('ignores chips with missing or empty attrs.taskId', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'taskChip' }, // no attrs at all
            { type: 'taskChip', attrs: {} }, // empty attrs
            { type: 'taskChip', attrs: { taskId: '' } }, // empty taskId
            { type: 'taskChip', attrs: { taskId: null } }, // null taskId
            taskChip(UUID_A, 'Good'),
          ],
        },
      ],
    };
    const out = __extractTaskRefs(doc);
    expect(out).toHaveLength(1);
    expect(out[0].taskId).toBe(UUID_A);
  });

  test('accepts both `taskChip` and `task-chip` as the node type', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            taskChip(UUID_A, 'CamelCase'),                       // type: 'taskChip'
            { type: 'text', text: ' and ' },
            taskChip(UUID_B, 'KebabCase', 'done', { kebab: true }), // type: 'task-chip'
          ],
        },
      ],
    };
    const out = __extractTaskRefs(doc);
    expect(out).toHaveLength(2);
    const ids = out.map((r) => r.taskId);
    expect(ids).toContain(UUID_A);
    expect(ids).toContain(UUID_B);
  });

  test('anchorOffset of the second chip is greater than the first', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Some text before ' },
            taskChip(UUID_A, 'First task'),
            { type: 'text', text: ' and additional content ' },
            taskChip(UUID_B, 'Second task'),
          ],
        },
      ],
    };
    const out = __extractTaskRefs(doc);
    expect(out).toHaveLength(2);
    expect(out[0].taskId).toBe(UUID_A);
    expect(out[1].taskId).toBe(UUID_B);
    expect(out[1].anchorOffset).toBeGreaterThan(out[0].anchorOffset);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Task-ref sync fan-out via createDoc
// ───────────────────────────────────────────────────────────────────────────

describe('task-ref sync via createDoc', () => {
  test('inserts a DocTaskReference row for each chip and fires NO notification', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    const created = makeDoc({ id: 'd-new', title: 'With chips', createdBy: ADMIN.id });
    Doc.create.mockResolvedValue(created);
    Doc.findByPk.mockResolvedValue(created);
    DocTaskReference.findAll.mockResolvedValue([]);

    const contentJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'check ' },
            taskChip(UUID_A, 'Task A'),
            { type: 'text', text: ' and ' },
            taskChip(UUID_B, 'Task B'),
          ],
        },
      ],
    };
    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: 'With chips', contentJson },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    await flushAsync();

    expect(DocTaskReference.create).toHaveBeenCalledTimes(2);
    const taskIdsInserted = DocTaskReference.create.mock.calls.map((c) => c[0].taskId);
    expect(taskIdsInserted).toContain(UUID_A);
    expect(taskIdsInserted).toContain(UUID_B);

    // Every insert should carry the correct addedByUserId + docId
    for (const call of DocTaskReference.create.mock.calls) {
      expect(call[0].docId).toBe('d-new');
      expect(call[0].addedByUserId).toBe(ADMIN.id);
      expect(typeof call[0].anchorOffset).toBe('number');
    }

    // Critical Slice 2 invariant: task-chip sync DOES NOT notify.
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  test('does NOT call DocTaskReference.create or createNotification when the doc has no chips', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    const created = makeDoc({ id: 'd-new', title: 'Plain', createdBy: ADMIN.id });
    Doc.create.mockResolvedValue(created);
    Doc.findByPk.mockResolvedValue(created);
    DocTaskReference.findAll.mockResolvedValue([]);

    const contentJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'no chips here' }] },
      ],
    };
    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: 'Plain', contentJson },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);
    expect(res.status).toHaveBeenCalledWith(201);

    await flushAsync();

    expect(DocTaskReference.create).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  test('still returns 201 if DocTaskReference.findAll rejects (fire-and-forget catch)', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    const created = makeDoc({ id: 'd-new', title: 'Boom', createdBy: ADMIN.id });
    Doc.create.mockResolvedValue(created);
    Doc.findByPk.mockResolvedValue(created);
    DocTaskReference.findAll.mockRejectedValue(new Error('DB down'));

    const contentJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [taskChip(UUID_A, 'Task A')] },
      ],
    };
    const req = {
      user: ADMIN,
      params: { workspaceId: 'w1' },
      body: { title: 'Boom', contentJson },
    };
    const res = mockRes();
    await docCtrl.createDoc(req, res);
    // Must still succeed
    expect(res.status).toHaveBeenCalledWith(201);

    await flushAsync();
    // No notification because sync threw before it could do anything
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Task-ref sync fan-out via updateDoc
// ───────────────────────────────────────────────────────────────────────────

describe('task-ref sync via updateDoc', () => {
  test('adds a new chip vs existing rows → inserts and does NOT notify', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc) // initial lookup
      .mockResolvedValueOnce(doc); // reload
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});

    // Existing: UUID_A. Incoming: UUID_A + UUID_B. So only UUID_B should
    // be inserted; no notification ever.
    DocTaskReference.findAll.mockResolvedValue([
      { id: 'ref-row-a', taskId: UUID_A },
    ]);

    const newJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            taskChip(UUID_A, 'Task A'),
            { type: 'text', text: ' and ' },
            taskChip(UUID_B, 'Task B'),
          ],
        },
      ],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: newJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    await flushAsync();

    expect(DocTaskReference.create).toHaveBeenCalledTimes(1);
    const insertArgs = DocTaskReference.create.mock.calls[0][0];
    expect(insertArgs.taskId).toBe(UUID_B);
    expect(insertArgs.docId).toBe('d1');
    expect(insertArgs.addedByUserId).toBe(ADMIN.id);

    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  test('removing a chip → calls DocTaskReference.destroy with Op.in over the removed id(s)', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});

    // Existing has UUID_A + UUID_B. Incoming only has UUID_A. UUID_B should
    // be destroyed.
    DocTaskReference.findAll.mockResolvedValue([
      { id: 'row-a', taskId: UUID_A },
      { id: 'row-b', taskId: UUID_B },
    ]);

    const trimmedJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [taskChip(UUID_A, 'Task A')] },
      ],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: trimmedJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    await flushAsync();

    expect(DocTaskReference.destroy).toHaveBeenCalledTimes(1);
    const destroyArgs = DocTaskReference.destroy.mock.calls[0][0];
    expect(destroyArgs.where.docId).toBe('d1');
    expect(destroyArgs.where.taskId[Op.in]).toEqual([UUID_B]);

    expect(DocTaskReference.create).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  test('no chip changes (empty incoming, empty existing) → neither create nor destroy', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});

    DocTaskReference.findAll.mockResolvedValue([]); // existing empty

    const plainJson = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'just text' }] }],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: plainJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    await flushAsync();

    expect(DocTaskReference.create).not.toHaveBeenCalled();
    expect(DocTaskReference.destroy).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  test('re-saving WITHOUT changing chips → neither create nor destroy', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});

    // Existing has UUID_A; incoming has UUID_A. Diff is empty both ways.
    DocTaskReference.findAll.mockResolvedValue([
      { id: 'row-a', taskId: UUID_A },
    ]);

    const sameChipJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'still linked ' }, taskChip(UUID_A, 'Task A')] },
      ],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: sameChipJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    await flushAsync();

    expect(DocTaskReference.create).not.toHaveBeenCalled();
    expect(DocTaskReference.destroy).not.toHaveBeenCalled();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  test('still returns 200 if DocTaskReference.findAll rejects (fire-and-forget catch)', async () => {
    const doc = makeDoc({ createdBy: ADMIN.id });
    Doc.findByPk
      .mockResolvedValueOnce(doc)
      .mockResolvedValueOnce(doc);
    DocVersion.count.mockResolvedValue(0);
    DocVersion.create.mockResolvedValue({});
    DocTaskReference.findAll.mockRejectedValue(new Error('task-ref table broken'));

    const newJson = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [taskChip(UUID_A, 'Task A')] },
      ],
    };
    const req = { user: ADMIN, params: { id: 'd1' }, body: { contentJson: newJson } };
    const res = mockRes();
    await docCtrl.updateDoc(req, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.status).not.toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);

    await flushAsync();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// listSearchableTasks — GET /api/docs/searchable-tasks
// ───────────────────────────────────────────────────────────────────────────

describe('listSearchableTasks', () => {
  test('400 when workspaceId query param is missing', async () => {
    const req = { user: CALLER, query: {} };
    const res = mockRes();
    await docCtrl.listSearchableTasks(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Workspace.findByPk).not.toHaveBeenCalled();
    expect(Task.findAll).not.toHaveBeenCalled();
  });

  test('403 when caller cannot see the workspace (workspace not found)', async () => {
    // canCallerSeeWorkspace will call findByPk and get null
    Workspace.findByPk.mockResolvedValueOnce(null);
    const req = { user: CALLER, query: { workspaceId: 'w-missing' } };
    const res = mockRes();
    await docCtrl.listSearchableTasks(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Task.findAll).not.toHaveBeenCalled();
  });

  test('403 when caller is non-admin non-member', async () => {
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: 'someone-else',
      workspaceMembers: [],
    }));
    const req = { user: CALLER, query: { workspaceId: 'w1' } };
    const res = mockRes();
    await docCtrl.listSearchableTasks(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Task.findAll).not.toHaveBeenCalled();
  });

  test('200 with empty tasks array when workspace has no boards', async () => {
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    Board.findAll.mockResolvedValue([]); // no boards

    const req = { user: ADMIN, query: { workspaceId: 'w1' } };
    const res = mockRes();
    await docCtrl.listSearchableTasks(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.tasks).toEqual([]);
    expect(Task.findAll).not.toHaveBeenCalled();
  });

  test('200 returns mapped tasks with boardName + boardColor from board lookup', async () => {
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    Board.findAll.mockResolvedValue([
      { id: 'b1', name: 'Board One', color: '#ff0000' },
      { id: 'b2', name: 'Board Two', color: '#00ff00' },
    ]);
    Task.findAll.mockResolvedValue([
      { id: 't1', title: 'Task One', status: 'not_started', priority: 'high', boardId: 'b1', dueDate: null },
      { id: 't2', title: 'Task Two', status: 'done', priority: 'low', boardId: 'b2', dueDate: null },
      { id: 't3', title: 'Orphan', status: 'review', priority: 'medium', boardId: 'b-missing', dueDate: null },
    ]);

    const req = { user: ADMIN, query: { workspaceId: 'w1' } };
    const res = mockRes();
    await docCtrl.listSearchableTasks(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.tasks).toHaveLength(3);

    const t1 = payload.data.tasks.find((t) => t.id === 't1');
    expect(t1.boardName).toBe('Board One');
    expect(t1.boardColor).toBe('#ff0000');

    const t2 = payload.data.tasks.find((t) => t.id === 't2');
    expect(t2.boardName).toBe('Board Two');
    expect(t2.boardColor).toBe('#00ff00');

    // boardLookup miss returns null fields
    const t3 = payload.data.tasks.find((t) => t.id === 't3');
    expect(t3.boardName).toBeNull();
    expect(t3.boardColor).toBeNull();
  });

  test('passes ilike filter when q param is provided', async () => {
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    Board.findAll.mockResolvedValue([
      { id: 'b1', name: 'B', color: null },
    ]);
    Task.findAll.mockResolvedValue([]);

    const req = { user: ADMIN, query: { workspaceId: 'w1', q: 'sprint' } };
    const res = mockRes();
    await docCtrl.listSearchableTasks(req, res);

    expect(Task.findAll).toHaveBeenCalledTimes(1);
    const args = Task.findAll.mock.calls[0][0];
    expect(args.where.title).toBeDefined();
    expect(args.where.title[Op.iLike]).toBe('%sprint%');
  });

  test('does NOT add title filter when q is empty/whitespace', async () => {
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    Board.findAll.mockResolvedValue([{ id: 'b1', name: 'B', color: null }]);
    Task.findAll.mockResolvedValue([]);

    const req = { user: ADMIN, query: { workspaceId: 'w1', q: '   ' } };
    const res = mockRes();
    await docCtrl.listSearchableTasks(req, res);

    const args = Task.findAll.mock.calls[0][0];
    expect(args.where.title).toBeUndefined();
  });

  test('caps Task.findAll results at limit: 25', async () => {
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    Board.findAll.mockResolvedValue([{ id: 'b1', name: 'B', color: null }]);
    Task.findAll.mockResolvedValue([]);

    const req = { user: ADMIN, query: { workspaceId: 'w1' } };
    const res = mockRes();
    await docCtrl.listSearchableTasks(req, res);

    expect(Task.findAll).toHaveBeenCalledTimes(1);
    const args = Task.findAll.mock.calls[0][0];
    expect(args.limit).toBe(25);
  });

  test('scopes Task.findAll to boards in the workspace and excludes archived tasks', async () => {
    Workspace.findByPk.mockResolvedValueOnce(makeWorkspace({
      createdBy: ADMIN.id,
      workspaceMembers: [],
    }));
    Board.findAll.mockResolvedValue([
      { id: 'b1', name: 'B', color: null },
      { id: 'b2', name: 'C', color: null },
    ]);
    Task.findAll.mockResolvedValue([]);

    const req = { user: ADMIN, query: { workspaceId: 'w1' } };
    const res = mockRes();
    await docCtrl.listSearchableTasks(req, res);

    const args = Task.findAll.mock.calls[0][0];
    expect(args.where.isArchived).toBe(false);
    expect(args.where.boardId[Op.in]).toEqual(['b1', 'b2']);

    // Board.findAll itself must filter to non-archived
    const boardArgs = Board.findAll.mock.calls[0][0];
    expect(boardArgs.where.workspaceId).toBe('w1');
    expect(boardArgs.where.isArchived).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// listDocReferencesForTask — GET /api/tasks/:id/doc-references
// ───────────────────────────────────────────────────────────────────────────

describe('listDocReferencesForTask', () => {
  test('400 when no task id param', async () => {
    const req = { user: CALLER, params: {} };
    const res = mockRes();
    await docCtrl.listDocReferencesForTask(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Task.findByPk).not.toHaveBeenCalled();
  });

  test('404 when Task.findByPk returns null', async () => {
    Task.findByPk.mockResolvedValue(null);
    const req = { user: CALLER, params: { id: UUID_A } };
    const res = mockRes();
    await docCtrl.listDocReferencesForTask(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(canUserSeeBoard).not.toHaveBeenCalled();
  });

  test('403 when canUserSeeBoard returns false', async () => {
    Task.findByPk.mockResolvedValue({ id: UUID_A, boardId: 'b1' });
    canUserSeeBoard.mockResolvedValue(false);
    const req = { user: CALLER, params: { id: UUID_A } };
    const res = mockRes();
    await docCtrl.listDocReferencesForTask(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(DocTaskReference.findAll).not.toHaveBeenCalled();
  });

  test('403 when canUserSeeBoard rejects (caught and treated as denied)', async () => {
    Task.findByPk.mockResolvedValue({ id: UUID_A, boardId: 'b1' });
    canUserSeeBoard.mockRejectedValue(new Error('lookup blew up'));
    const req = { user: CALLER, params: { id: UUID_A } };
    const res = mockRes();
    await docCtrl.listDocReferencesForTask(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('200 returns docs whose workspace the caller can see; excludes archived docs', async () => {
    Task.findByPk.mockResolvedValue({ id: UUID_A, boardId: 'b1' });
    canUserSeeBoard.mockResolvedValue(true);

    const visibleRef = {
      id: 'ref-1',
      createdAt: new Date('2026-05-10T00:00:00Z'),
      doc: {
        id: 'doc-visible',
        title: 'Visible doc',
        workspaceId: 'w-visible',
        isArchived: false,
      },
    };
    const archivedRef = {
      id: 'ref-2',
      createdAt: new Date('2026-05-11T00:00:00Z'),
      doc: {
        id: 'doc-archived',
        title: 'Archived doc',
        workspaceId: 'w-visible',
        isArchived: true, // must be filtered out
      },
    };
    const hiddenRef = {
      id: 'ref-3',
      createdAt: new Date('2026-05-12T00:00:00Z'),
      doc: {
        id: 'doc-hidden',
        title: 'Hidden doc',
        workspaceId: 'w-hidden',
        isArchived: false,
      },
    };
    const nullDocRef = {
      id: 'ref-4',
      createdAt: new Date('2026-05-13T00:00:00Z'),
      doc: null, // dangling ref
    };
    DocTaskReference.findAll.mockResolvedValue([visibleRef, archivedRef, hiddenRef, nullDocRef]);

    // Workspace visibility: w-visible passes (caller is admin), w-hidden returns
    // null (workspace not found) so canCallerSeeWorkspace returns false.
    Workspace.findByPk.mockImplementation((wsId) => {
      if (wsId === 'w-visible') {
        return Promise.resolve(makeWorkspace({ id: 'w-visible', createdBy: ADMIN.id }));
      }
      return Promise.resolve(null);
    });

    const req = { user: ADMIN, params: { id: UUID_A } };
    const res = mockRes();
    await docCtrl.listDocReferencesForTask(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.docs).toHaveLength(1);
    expect(payload.data.docs[0].docId).toBe('doc-visible');
    expect(payload.data.docs[0].title).toBe('Visible doc');
    expect(payload.data.docs[0].workspaceId).toBe('w-visible');
  });

  test('200 returns empty array when there are no references at all', async () => {
    Task.findByPk.mockResolvedValue({ id: UUID_A, boardId: 'b1' });
    canUserSeeBoard.mockResolvedValue(true);
    DocTaskReference.findAll.mockResolvedValue([]);

    const req = { user: ADMIN, params: { id: UUID_A } };
    const res = mockRes();
    await docCtrl.listDocReferencesForTask(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.docs).toEqual([]);
  });

  test('queries DocTaskReference.findAll scoped to the taskId with Doc include', async () => {
    Task.findByPk.mockResolvedValue({ id: UUID_A, boardId: 'b1' });
    canUserSeeBoard.mockResolvedValue(true);
    DocTaskReference.findAll.mockResolvedValue([]);

    const req = { user: ADMIN, params: { id: UUID_A } };
    const res = mockRes();
    await docCtrl.listDocReferencesForTask(req, res);

    expect(DocTaskReference.findAll).toHaveBeenCalledTimes(1);
    const args = DocTaskReference.findAll.mock.calls[0][0];
    expect(args.where.taskId).toBe(UUID_A);
    expect(Array.isArray(args.include)).toBe(true);
    const docInclude = args.include.find((inc) => inc.as === 'doc');
    expect(docInclude).toBeDefined();
    expect(docInclude.attributes).toEqual(expect.arrayContaining(['id', 'title', 'workspaceId', 'isArchived']));
  });
});
