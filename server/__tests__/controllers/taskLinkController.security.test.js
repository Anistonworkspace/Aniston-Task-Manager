'use strict';

/**
 * Security + URL validator tests for taskLinkController.
 *
 * Covers P0-5 (list IDOR) and P1-4 (SSRF surface — reject localhost,
 * RFC1918, link-local, cloud-metadata hosts). The validateUrl helper
 * is exercised indirectly via createLink + a direct path that mirrors
 * the validateUrl behavior.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  TaskLink: {
    findAll: jest.fn(),
    findByPk: jest.fn(),
    create: jest.fn(),
    max: jest.fn(),
  },
  Task: { findByPk: jest.fn() },
  TaskAssignee: { findOne: jest.fn() },
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToBoardAndUsers: jest.fn(),
}));

jest.mock('../../services/taskVisibilityService', () => ({
  canViewTask: jest.fn(),
  getAuthorizedRealtimeRecipients: jest.fn(async () => []),
}));

jest.mock('../../config/tiers', () => ({
  resolveTier: jest.fn(() => 1),
  TIER_1: 1,
  TIER_2: 2,
}));

const { TaskLink, Task } = require('../../models');
const taskVisibility = require('../../services/taskVisibilityService');
const linkCtrl = require('../../controllers/taskLinkController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1', assignedTo: 'u1', createdBy: 'u1' });
  taskVisibility.canViewTask.mockResolvedValue(true);
  TaskLink.max.mockResolvedValue(null);
});

// ── P0-5 ────────────────────────────────────────────────────────────
describe('listLinks — IDOR protection (P0-5)', () => {
  test('returns 403 when user cannot view the task', async () => {
    taskVisibility.canViewTask.mockResolvedValue(false);
    const req = { user: { id: 'attacker' }, params: { taskId: 't1' } };
    const res = mockRes();
    await linkCtrl.listLinks(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(TaskLink.findAll).not.toHaveBeenCalled();
  });
});

// ── P1-4 + URL validation ───────────────────────────────────────────
describe('URL validation', () => {
  async function tryCreate(url) {
    TaskLink.create.mockResolvedValue({ id: 'lk1', url });
    const req = { user: { id: 'u1' }, body: { taskId: 't1', url } };
    const res = mockRes();
    await linkCtrl.createLink(req, res);
    return res;
  }

  test('rejects javascript: scheme', async () => {
    const res = await tryCreate('javascript:alert(1)');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects data: scheme', async () => {
    const res = await tryCreate('data:text/html,<script>1</script>');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects file: scheme', async () => {
    const res = await tryCreate('file:///etc/passwd');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects http://localhost (SSRF surface)', async () => {
    const res = await tryCreate('http://localhost:5000/admin');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(TaskLink.create).not.toHaveBeenCalled();
  });

  test('rejects http://127.0.0.1 (loopback)', async () => {
    const res = await tryCreate('http://127.0.0.1');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects http://10.0.0.5 (RFC1918)', async () => {
    const res = await tryCreate('http://10.0.0.5');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects http://192.168.1.1 (RFC1918)', async () => {
    const res = await tryCreate('http://192.168.1.1');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects http://169.254.169.254 (cloud metadata)', async () => {
    const res = await tryCreate('http://169.254.169.254/latest/meta-data');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('rejects http://172.16.0.1 (RFC1918)', async () => {
    const res = await tryCreate('http://172.16.0.1');
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('auto-prefixes bare domain to https://', async () => {
    TaskLink.create.mockResolvedValue({ id: 'lk1' });
    const req = { user: { id: 'u1' }, body: { taskId: 't1', url: 'dribbble.com/x' } };
    const res = mockRes();
    await linkCtrl.createLink(req, res);
    expect(TaskLink.create).toHaveBeenCalled();
    const arg = TaskLink.create.mock.calls[0][0];
    expect(arg.url).toMatch(/^https:\/\/dribbble\.com/);
  });

  test('accepts a valid public https URL', async () => {
    TaskLink.create.mockResolvedValue({ id: 'lk1' });
    const req = { user: { id: 'u1' }, body: { taskId: 't1', url: 'https://example.com/path' } };
    const res = mockRes();
    await linkCtrl.createLink(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
