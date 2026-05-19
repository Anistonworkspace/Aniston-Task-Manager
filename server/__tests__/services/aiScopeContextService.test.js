'use strict';

/**
 * Unit tests for aiScopeContextService.
 *
 * The service builds focused, RBAC-aware text context for the AI when the
 * client opens the Sidekick on a specific scope (task / board / planning).
 * Each loader must:
 *   - Return an empty string for unknown scope.
 *   - Return an empty string when the caller can't see the resource.
 *   - Produce a human-readable summary when the caller can.
 *
 * We mock the model layer aggressively because the goal here is to verify
 * the SHAPE of the text output and the visibility gating, not Sequelize.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  User:           { findAll: jest.fn(), findByPk: jest.fn() },
  Task:           { findByPk: jest.fn(), findAll: jest.fn() },
  Board:          { findByPk: jest.fn(), findAll: jest.fn() },
  Comment:        { findAll: jest.fn() },
  WorkLog:        { findAll: jest.fn() },
  Activity:       { findAll: jest.fn() },
  TaskAssignee:   { findAll: jest.fn() },
  TaskOwner:      { findAll: jest.fn() },
  Subtask:        { findAll: jest.fn() },
  Doc:            { findByPk: jest.fn() },
  Workspace:      { findByPk: jest.fn() },
  DocComment:     { findAll: jest.fn() },
}));

jest.mock('../../services/boardVisibilityService', () => ({
  canUserSeeBoard: jest.fn(),
}));

jest.mock('../../utils/safeLogger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const { Task, Board, Comment, WorkLog, Activity, Doc, Workspace, DocComment } = require('../../models');
const { canUserSeeBoard } = require('../../services/boardVisibilityService');
const { buildScopeContext } = require('../../services/aiScopeContextService');

const USER = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  role: 'member',
  isSuperAdmin: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  canUserSeeBoard.mockResolvedValue(true);
  Comment.findAll.mockResolvedValue([]);
  WorkLog.findAll.mockResolvedValue([]);
  Activity.findAll.mockResolvedValue([]);
  DocComment.findAll.mockResolvedValue([]);
});

describe('buildScopeContext', () => {
  it('returns empty string when scope is missing', async () => {
    expect(await buildScopeContext(USER, {})).toBe('');
    expect(await buildScopeContext(USER, { scope: '', scopeId: '' })).toBe('');
  });

  it('returns empty string for an unknown scope', async () => {
    expect(await buildScopeContext(USER, { scope: 'galaxy' })).toBe('');
  });

  // ─── task scope ──────────────────────────────────────────────

  it('task scope returns empty string when scopeId is missing', async () => {
    expect(await buildScopeContext(USER, { scope: 'task' })).toBe('');
  });

  it('task scope returns empty string when the task is not found', async () => {
    Task.findByPk.mockResolvedValue(null);
    expect(await buildScopeContext(USER, { scope: 'task', scopeId: 't1' })).toBe('');
  });

  it('task scope refuses when caller cannot see the board', async () => {
    Task.findByPk.mockResolvedValue({ id: 't1', title: 'X', boardId: 'b1' });
    canUserSeeBoard.mockResolvedValue(false);
    expect(await buildScopeContext(USER, { scope: 'task', scopeId: 't1' })).toBe('');
  });

  it('task scope returns a TASK SCOPE summary with title + status + priority', async () => {
    Task.findByPk.mockResolvedValue({
      id: 't1',
      title: 'Ship the launch email',
      status: 'working_on_it',
      priority: 'high',
      progress: 50,
      boardId: 'b1',
      description: 'Coordinate with marketing.',
      board: { id: 'b1', name: 'Q3 Launch' },
      assignee: { id: 'u9', name: 'Alice' },
      creator: { id: 'u1', name: 'Pat' },
      owners: [{ name: 'Alice' }],
      taskAssignees: [],
      subtasks: [],
    });

    const text = await buildScopeContext(USER, { scope: 'task', scopeId: 't1' });
    expect(text).toContain('TASK SCOPE');
    expect(text).toContain('Ship the launch email');
    expect(text).toContain('Q3 Launch');
    expect(text).toContain('working_on_it');
    expect(text).toContain('high');
    expect(text).toContain('50%');
    expect(text).toContain('Alice');
    expect(text).toContain('Coordinate with marketing.');
  });

  it('task scope folds in recent comments and worklogs', async () => {
    Task.findByPk.mockResolvedValue({
      id: 't1', title: 'X', boardId: 'b1',
      status: 'stuck', priority: 'high',
      board: { name: 'Board' },
      owners: [], taskAssignees: [], subtasks: [],
    });
    Comment.findAll.mockResolvedValue([
      { content: 'Waiting on legal review', createdAt: new Date(), user: { name: 'Pat' } },
    ]);
    WorkLog.findAll.mockResolvedValue([
      { content: 'Drafted v2', createdAt: new Date(), date: new Date(), author: { name: 'Alice' } },
    ]);

    const text = await buildScopeContext(USER, { scope: 'task', scopeId: 't1' });
    expect(text).toContain('Waiting on legal review');
    expect(text).toContain('Drafted v2');
  });

  // ─── board scope ─────────────────────────────────────────────

  it('board scope refuses when caller cannot see the board', async () => {
    canUserSeeBoard.mockResolvedValue(false);
    expect(await buildScopeContext(USER, { scope: 'board', scopeId: 'b1' })).toBe('');
  });

  it('board scope returns empty string when board is not found', async () => {
    canUserSeeBoard.mockResolvedValue(true);
    Board.findByPk.mockResolvedValue(null);
    expect(await buildScopeContext(USER, { scope: 'board', scopeId: 'b1' })).toBe('');
  });

  it('board scope bucketizes tasks by status and counts overdue/today/this-week', async () => {
    canUserSeeBoard.mockResolvedValue(true);
    Board.findByPk.mockResolvedValue({ id: 'b1', name: 'Roadmap' });
    const now = new Date();
    const past = new Date(now.getTime() - 86400000 * 3);
    const today = new Date();
    Task.findAll.mockResolvedValue([
      { title: 'Stuck thing',    status: 'stuck',         priority: 'high',     dueDate: past,  assignee: { name: 'A' } },
      { title: 'In progress',    status: 'working_on_it', priority: 'medium',   dueDate: today, assignee: { name: 'B' } },
      { title: 'Not started',    status: 'not_started',   priority: 'low',      dueDate: null,  assignee: null },
    ]);

    const text = await buildScopeContext(USER, { scope: 'board', scopeId: 'b1' });
    expect(text).toContain('BOARD SCOPE');
    expect(text).toContain('Roadmap');
    expect(text).toContain('Total open tasks: 3');
    expect(text).toContain('STUCK tasks');
    expect(text).toContain('Stuck thing');
    expect(text).toContain('IN-FLIGHT');
    expect(text).toContain('In progress');
    expect(text).toMatch(/Overdue: 1/);
  });

  // ─── planning scope ──────────────────────────────────────────

  it('planning scope returns a "no tasks" message when user has nothing open', async () => {
    Task.findAll.mockResolvedValue([]);
    const text = await buildScopeContext(USER, { scope: 'planning' });
    expect(text).toContain('PLANNING SCOPE');
    expect(text).toContain("don't have any open tasks");
  });

  it('planning scope groups open tasks by overdue / today / this week / later / no date', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const today = new Date();
    today.setHours(15, 0, 0, 0);
    const inFourDays = new Date(now.getTime() + 86400000 * 4);
    const inThirtyDays = new Date(now.getTime() + 86400000 * 30);

    Task.findAll.mockResolvedValue([
      { title: 'Past due thing', status: 'working_on_it', priority: 'high',     dueDate: yesterday,  board: { name: 'A' } },
      { title: 'Today thing',    status: 'not_started',   priority: 'critical', dueDate: today,      board: { name: 'A' } },
      { title: 'This week',      status: 'review',        priority: 'medium',   dueDate: inFourDays, board: { name: 'B' } },
      { title: 'Later',          status: 'not_started',   priority: 'low',      dueDate: inThirtyDays, board: { name: 'B' } },
      { title: 'No date',        status: 'working_on_it', priority: 'medium',   dueDate: null,       board: { name: 'B' } },
    ]);

    const text = await buildScopeContext(USER, { scope: 'planning' });
    expect(text).toContain('PLANNING SCOPE');
    expect(text).toContain('OVERDUE');
    expect(text).toContain('Past due thing');
    expect(text).toContain('DUE TODAY');
    expect(text).toContain('Today thing');
    expect(text).toContain('DUE THIS WEEK');
    expect(text).toContain('This week');
    expect(text).toContain('LATER');
    expect(text).toContain('NO DUE DATE');
    expect(text).toContain('Total open tasks: 5');
  });

  it('returns empty string and logs when an underlying query throws', async () => {
    Task.findByPk.mockRejectedValue(new Error('db down'));
    const text = await buildScopeContext(USER, { scope: 'task', scopeId: 't1' });
    expect(text).toBe('');
  });

  // ─── doc scope ───────────────────────────────────────────────

  it('doc scope returns empty when scopeId is missing', async () => {
    expect(await buildScopeContext(USER, { scope: 'doc' })).toBe('');
  });

  it('doc scope returns empty when the doc is not found', async () => {
    Doc.findByPk.mockResolvedValue(null);
    expect(await buildScopeContext(USER, { scope: 'doc', scopeId: 'd1' })).toBe('');
  });

  it('doc scope returns empty when the caller cannot see the workspace', async () => {
    Doc.findByPk.mockResolvedValue({
      id: 'd1', title: 'Hidden', workspaceId: 'w1',
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'private' }] }] },
    });
    // Member without membership and without board access → cannot see.
    Workspace.findByPk.mockResolvedValue({
      id: 'w1', name: 'WS', createdBy: 'someone-else',
      workspaceMembers: [],
    });
    // No board-membership path either.
    const boardVis = require('../../services/boardVisibilityService');
    boardVis.canUserSeeBoard = jest.fn();
    // canSeeDocWorkspace calls getVisibleBoardIdsForUser which isn't on the mock
    // → falls through to false; the visibility check should reject.
    const text = await buildScopeContext(USER, { scope: 'doc', scopeId: 'd1' });
    expect(text).toBe('');
  });

  it('doc scope includes title, body, and metadata for a visible doc', async () => {
    Doc.findByPk.mockResolvedValue({
      id: 'd1',
      title: 'Project alpha launch plan',
      workspaceId: 'w1',
      contentJson: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Launch goals' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Ship by Q3 end of quarter.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Owners: @Sara, @Mike.' }] },
        ],
      },
      contentText: 'Launch goals Ship by Q3 end of quarter. Owners: @Sara, @Mike.',
      lastEditedAt: new Date('2026-05-18T10:00:00Z'),
      creator: { id: 'u9', name: 'Sunny Mehta' },
      lastEditor: { id: 'u9', name: 'Sunny Mehta' },
      workspace: { id: 'w1', name: 'Engineering' },
    });

    const SUPER = { id: 'super-1', role: 'admin', isSuperAdmin: true };
    const text = await buildScopeContext(SUPER, { scope: 'doc', scopeId: 'd1' });

    expect(text).toContain('DOC SCOPE');
    expect(text).toContain('Project alpha launch plan');
    expect(text).toContain('Engineering'); // workspace name
    expect(text).toContain('Sunny Mehta'); // creator
    expect(text).toContain('Launch goals');
    expect(text).toContain('Ship by Q3 end of quarter');
    expect(text).toContain('Owners: @Sara, @Mike');
  });

  it('doc scope falls back to contentText when contentJson is missing', async () => {
    Doc.findByPk.mockResolvedValue({
      id: 'd1',
      title: 'Legacy doc',
      workspaceId: 'w1',
      contentJson: null,
      contentText: 'this is the legacy plain-text shadow stored by the controller',
      creator: { id: 'u9', name: 'Sara' },
    });
    const SUPER = { id: 'super-1', role: 'admin', isSuperAdmin: true };
    const text = await buildScopeContext(SUPER, { scope: 'doc', scopeId: 'd1' });
    expect(text).toContain('legacy plain-text shadow');
  });

  it('doc scope marks archived docs in the body so the AI knows', async () => {
    Doc.findByPk.mockResolvedValue({
      id: 'd1',
      title: 'Old plan',
      workspaceId: 'w1',
      isArchived: true,
      contentJson: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old content' }] }] },
      creator: { id: 'u9', name: 'Sara' },
    });
    const SUPER = { id: 'super-1', role: 'admin', isSuperAdmin: true };
    const text = await buildScopeContext(SUPER, { scope: 'doc', scopeId: 'd1' });
    expect(text).toContain('ARCHIVED');
  });
});
