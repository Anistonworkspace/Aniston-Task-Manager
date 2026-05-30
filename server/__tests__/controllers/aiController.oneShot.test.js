'use strict';

/**
 * Tests for the one-shot AI endpoints on server/controllers/aiController.js
 * — Phase 3 of the QA remediation plan. aiController was at 3.74% coverage
 * before this; the one-shot endpoints were shipped in f85c72f without
 * dedicated tests at the controller boundary.
 *
 * Endpoints covered:
 *   POST /api/ai/summarize/task/:id
 *   POST /api/ai/summarize/board/:id
 *   POST /api/ai/summarize/doc/:id
 *   POST /api/ai/extract-actions
 *   POST /api/ai/inline-edit
 *   POST /api/ai/suggest-priority
 *   POST /api/ai/plan-week
 * Plus the shared `handleAiEndpointError` mapper.
 *
 * Per skill §7.1 each endpoint gets: required-arg validation, happy path,
 * service-layer error → mapped HTTP status, and provider-specific error
 * classification.
 *
 * aiService + aiSummaryService are mocked at the boundary — no real
 * provider calls. The controller uses `require()` inside handlers so we
 * mock the modules globally via jest.mock + the controller's own require()
 * calls find the mocked exports.
 */

process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

jest.mock('../../services/aiSummaryService', () => {
  class AiScopeUnavailableError extends Error {
    constructor(msg) { super(msg || 'unavailable'); this.code = 'AI_SCOPE_UNAVAILABLE'; }
  }
  return {
    summarizeTaskWithAI: jest.fn(),
    summarizeBoardWithAI: jest.fn(),
    summarizeDocWithAI: jest.fn(),
    suggestPriorityWithAI: jest.fn(),
    planWeekWithAI: jest.fn(),
    extractActionItemsWithAI: jest.fn(),
    transformInlineWithAI: jest.fn(),
    AiScopeUnavailableError,
    INLINE_MODES: {
      improve: 'Improve the text',
      shorter: 'Make it shorter',
      longer: 'Expand the text',
      grammar: 'Fix grammar',
      continue: 'Continue writing',
      casual: 'Make casual',
      professional: 'Make professional',
    },
  };
});

jest.mock('../../services/aiService', () => ({
  classifyError: jest.fn(() => ({ message: 'mapped error', diagnostics: { failureType: 'network' } })),
}));

jest.mock('../../models', () => ({
  Doc: { findByPk: jest.fn() },
  Workspace: { findByPk: jest.fn() },
  User: {},
  // feat/docs-personal-notion Phase 3 — summarize/doc gates on
  // docAccessSvc.hasDocAccess, which reads DocAccess.findOne. Default
  // null → no access; happy-path tests set the doc's ownerUserId to the
  // caller's id or use super-admin.
  DocAccess: { findOne: jest.fn().mockResolvedValue(null), findAll: jest.fn() },
  AIConfig: { findOne: jest.fn() },
  AIProvider: { findOne: jest.fn(), findAll: jest.fn() },
}));

jest.mock('../../utils/safeLogger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

const aiSummary = require('../../services/aiSummaryService');
const aiService = require('../../services/aiService');
const { Doc, Workspace } = require('../../models');

const {
  summarizeTaskEndpoint,
  summarizeBoardEndpoint,
  suggestPriorityEndpoint,
  planWeekEndpoint,
} = require('../../controllers/aiController');

// extractActionsEndpoint / inlineEditEndpoint / summarizeDocEndpoint aren't
// in module.exports — pull them via the module shape if missing. Hardly
// elegant but the alternative is exporting them just for the test.
const fullCtrl = require('../../controllers/aiController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const MEMBER = { id: 'u-1', name: 'Member User', role: 'member', isSuperAdmin: false };
const ADMIN = { id: 'u-admin', name: 'Admin', role: 'admin', isSuperAdmin: false };
const SUPER = { id: 'u-super', name: 'Super', role: 'admin', isSuperAdmin: true };

beforeEach(() => {
  jest.resetAllMocks();
  aiService.classifyError.mockReturnValue({
    message: 'mapped error', diagnostics: { failureType: 'network' },
  });
});

// ─── summarizeTaskEndpoint ─────────────────────────────────────

describe('POST /api/ai/summarize/task/:id', () => {
  it('returns 400 when task id is missing', async () => {
    const req = { params: {}, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeTaskEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Task id is required.' });
    expect(aiSummary.summarizeTaskWithAI).not.toHaveBeenCalled();
  });

  it('returns 200 + structured data on success', async () => {
    aiSummary.summarizeTaskWithAI.mockResolvedValueOnce({ kind: 'text', summary: 'short summary' });
    const req = { params: { id: 't-1' }, user: MEMBER, body: { providerId: 'p-1' } };
    const res = mockRes();
    await summarizeTaskEndpoint(req, res);

    expect(aiSummary.summarizeTaskWithAI).toHaveBeenCalledWith(MEMBER, 't-1', { providerId: 'p-1' });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { kind: 'text', summary: 'short summary' } });
  });

  it('returns 404 when AiScopeUnavailableError is thrown (task hidden / archived)', async () => {
    aiSummary.summarizeTaskWithAI.mockRejectedValueOnce(
      new aiSummary.AiScopeUnavailableError('Task hidden.'),
    );
    const req = { params: { id: 't-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeTaskEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: 'AI_SCOPE_UNAVAILABLE',
      message: 'Task hidden.',
    });
  });

  it('routes non-Scope errors through handleAiEndpointError (network error → 502)', async () => {
    aiSummary.summarizeTaskWithAI.mockRejectedValueOnce(new Error('provider timeout'));
    aiService.classifyError.mockReturnValueOnce({
      message: 'Network failure (50ms)',
      diagnostics: { failureType: 'network' },
    });
    const req = { params: { id: 't-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeTaskEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    // Status map for network = 502, and the (50ms) suffix gets stripped
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Network failure' });
  });

  it('handles AI_NOT_CONFIGURED by mapping to 400 with code AI_NOT_CONFIGURED', async () => {
    aiSummary.summarizeTaskWithAI.mockRejectedValueOnce(new Error('AI provider not configured'));
    const req = { params: { id: 't-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeTaskEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: 'AI_NOT_CONFIGURED',
      message: 'AI is not configured. Ask an admin to set up AI in Integrations.',
    });
  });
});

// ─── summarizeBoardEndpoint ────────────────────────────────────

describe('POST /api/ai/summarize/board/:id', () => {
  it('returns 400 when board id is missing', async () => {
    const req = { params: {}, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeBoardEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 200 on success', async () => {
    aiSummary.summarizeBoardWithAI.mockResolvedValueOnce({ summary: 'board summary' });
    const req = { params: { id: 'b-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeBoardEndpoint(req, res);

    expect(aiSummary.summarizeBoardWithAI).toHaveBeenCalledWith(MEMBER, 'b-1', { providerId: undefined });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { summary: 'board summary' } });
  });

  it('returns 404 on AiScopeUnavailableError', async () => {
    aiSummary.summarizeBoardWithAI.mockRejectedValueOnce(
      new aiSummary.AiScopeUnavailableError('Board not visible.'),
    );
    const req = { params: { id: 'b-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeBoardEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ─── suggestPriorityEndpoint ───────────────────────────────────

describe('POST /api/ai/suggest-priority', () => {
  it('returns 400 when taskTitle is missing', async () => {
    const req = { user: MEMBER, body: {} };
    const res = mockRes();
    await suggestPriorityEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'taskTitle is required (max 400 chars).',
    });
  });

  it('returns 400 when taskTitle is not a string', async () => {
    const req = { user: MEMBER, body: { taskTitle: 123 } };
    const res = mockRes();
    await suggestPriorityEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when taskTitle exceeds 400 chars (DoS protection)', async () => {
    const req = { user: MEMBER, body: { taskTitle: 'x'.repeat(401) } };
    const res = mockRes();
    await suggestPriorityEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('accepts a 400-char title exactly (boundary)', async () => {
    aiSummary.suggestPriorityWithAI.mockResolvedValueOnce({ priority: 'high', reason: 'urgent' });
    const req = { user: MEMBER, body: { taskTitle: 'x'.repeat(400) } };
    const res = mockRes();
    await suggestPriorityEndpoint(req, res);

    expect(aiSummary.suggestPriorityWithAI).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { priority: 'high', reason: 'urgent' } });
  });

  it('threads taskDescription + boardId + providerId through to the service', async () => {
    aiSummary.suggestPriorityWithAI.mockResolvedValueOnce({ priority: 'low' });
    const req = {
      user: MEMBER,
      body: {
        taskTitle: 'Title',
        taskDescription: 'Desc',
        boardId: 'b-1',
        providerId: 'p-1',
      },
    };
    const res = mockRes();
    await suggestPriorityEndpoint(req, res);

    expect(aiSummary.suggestPriorityWithAI).toHaveBeenCalledWith(
      MEMBER,
      { taskTitle: 'Title', taskDescription: 'Desc', boardId: 'b-1' },
      { providerId: 'p-1' },
    );
  });
});

// ─── planWeekEndpoint ──────────────────────────────────────────

describe('POST /api/ai/plan-week', () => {
  it('returns 200 with no body (all defaults — entire workload)', async () => {
    aiSummary.planWeekWithAI.mockResolvedValueOnce({ schedule: [], notes: '' });
    const req = { user: MEMBER, body: {} };
    const res = mockRes();
    await planWeekEndpoint(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { schedule: [], notes: '' } });
  });

  it('returns 400 when taskIds is not an array', async () => {
    const req = { user: MEMBER, body: { taskIds: 'not-an-array' } };
    const res = mockRes();
    await planWeekEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'taskIds must be an array of strings.',
    });
  });

  it('accepts taskIds as an array', async () => {
    aiSummary.planWeekWithAI.mockResolvedValueOnce({ schedule: [{ day: 'Mon', tasks: [] }] });
    const req = { user: MEMBER, body: { taskIds: ['t-1', 't-2'] } };
    const res = mockRes();
    await planWeekEndpoint(req, res);

    expect(aiSummary.planWeekWithAI).toHaveBeenCalledWith(
      MEMBER,
      { taskIds: ['t-1', 't-2'] },
      { providerId: undefined },
    );
  });
});

// ─── extractActionsEndpoint ────────────────────────────────────

describe('POST /api/ai/extract-actions', () => {
  it('returns 400 when text is missing', async () => {
    const req = { user: MEMBER, body: {} };
    const res = mockRes();
    await fullCtrl.extractActionsEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'text is required.',
      code: 'invalid_input',
    });
  });

  it('returns 400 when text is whitespace only', async () => {
    const req = { user: MEMBER, body: { text: '   \n\t  ' } };
    const res = mockRes();
    await fullCtrl.extractActionsEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 200 with extracted actions on success', async () => {
    aiSummary.extractActionItemsWithAI.mockResolvedValueOnce({
      actions: [{ title: 'Ship the feature', owner: 'Alice' }],
    });
    const req = { user: MEMBER, body: { text: 'Meeting transcript here.' } };
    const res = mockRes();
    await fullCtrl.extractActionsEndpoint(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { actions: [{ title: 'Ship the feature', owner: 'Alice' }] },
    });
  });
});

// ─── inlineEditEndpoint ────────────────────────────────────────

describe('POST /api/ai/inline-edit', () => {
  it('returns 400 when text is missing', async () => {
    const req = { user: MEMBER, body: { mode: 'improve' } };
    const res = mockRes();
    await fullCtrl.inlineEditEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'text is required.',
      code: 'invalid_input',
    });
  });

  it('returns 400 when mode is missing', async () => {
    const req = { user: MEMBER, body: { text: 'hello' } };
    const res = mockRes();
    await fullCtrl.inlineEditEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'mode is required.',
      code: 'invalid_input',
    });
  });

  it('returns 400 when mode is not in INLINE_MODES allowlist', async () => {
    const req = { user: MEMBER, body: { text: 'hello', mode: 'evil_mode' } };
    const res = mockRes();
    await fullCtrl.inlineEditEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    const calledWith = res.json.mock.calls[0][0];
    expect(calledWith.code).toBe('invalid_mode');
    expect(calledWith.message).toMatch(/Allowed:/);
  });

  it('returns 200 with transformed text for a valid mode', async () => {
    aiSummary.transformInlineWithAI.mockResolvedValueOnce({ text: 'Polished text.' });
    const req = { user: MEMBER, body: { text: 'rough text', mode: 'improve' } };
    const res = mockRes();
    await fullCtrl.inlineEditEndpoint(req, res);

    expect(aiSummary.transformInlineWithAI).toHaveBeenCalledWith(
      { text: 'rough text', mode: 'improve' },
      { providerId: undefined },
    );
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { text: 'Polished text.' } });
  });
});

// ─── summarizeDocEndpoint ──────────────────────────────────────

describe('POST /api/ai/summarize/doc/:id', () => {
  it('returns 400 when doc id is missing', async () => {
    const req = { params: {}, user: MEMBER, body: {} };
    const res = mockRes();
    await fullCtrl.summarizeDocEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when doc not found', async () => {
    Doc.findByPk.mockResolvedValueOnce(null);
    const req = { params: { id: 'd-ghost' }, user: MEMBER, body: {} };
    const res = mockRes();
    await fullCtrl.summarizeDocEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Doc not found.' });
  });

  it('super admin bypasses workspace membership check', async () => {
    Doc.findByPk.mockResolvedValueOnce({ id: 'd-1', workspaceId: 'w-1', title: 'X' });
    aiSummary.summarizeDocWithAI.mockResolvedValueOnce({ summary: 'doc summary' });
    const req = { params: { id: 'd-1' }, user: SUPER, body: {} };
    const res = mockRes();
    await fullCtrl.summarizeDocEndpoint(req, res);

    expect(Workspace.findByPk).not.toHaveBeenCalled(); // bypass — no workspace lookup needed
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { summary: 'doc summary' } });
  });

  it('admin bypasses workspace membership check', async () => {
    Doc.findByPk.mockResolvedValueOnce({ id: 'd-1', workspaceId: 'w-1', title: 'X' });
    aiSummary.summarizeDocWithAI.mockResolvedValueOnce({ summary: 's' });
    const req = { params: { id: 'd-1' }, user: ADMIN, body: {} };
    const res = mockRes();
    await fullCtrl.summarizeDocEndpoint(req, res);
    expect(Workspace.findByPk).not.toHaveBeenCalled();
  });

  it('member with explicit doc_access grant can summarize', async () => {
    // Phase 3: workspace membership no longer grants access — the gate is
    // docAccessSvc.hasDocAccess (owner OR explicit doc_access row).
    Doc.findByPk.mockResolvedValueOnce({ id: 'd-1', workspaceId: 'w-1', title: 'X' });
    const { DocAccess } = require('../../models');
    DocAccess.findOne.mockResolvedValueOnce({ id: 'a-1' }); // explicit grant for MEMBER
    aiSummary.summarizeDocWithAI.mockResolvedValueOnce({ summary: 's' });

    const req = { params: { id: 'd-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await fullCtrl.summarizeDocEndpoint(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { summary: 's' } });
  });

  it('member without doc_access gets 403', async () => {
    // Phase 3: default DocAccess.findOne → null means MEMBER has no grant.
    // Workspace membership is no longer consulted.
    Doc.findByPk.mockResolvedValueOnce({ id: 'd-1', workspaceId: 'w-1', title: 'X', ownerUserId: 'someone-else' });

    const req = { params: { id: 'd-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await fullCtrl.summarizeDocEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'You do not have access to this doc.',
    });
    expect(aiSummary.summarizeDocWithAI).not.toHaveBeenCalled();
  });

  it('doc owner can summarize (Phase 3 ownerUserId match)', async () => {
    // Phase 3: ownership comes from ownerUserId, not workspace creator.
    Doc.findByPk.mockResolvedValueOnce({ id: 'd-1', workspaceId: 'w-1', title: 'X', ownerUserId: MEMBER.id });
    aiSummary.summarizeDocWithAI.mockResolvedValueOnce({ summary: 's' });

    const req = { params: { id: 'd-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await fullCtrl.summarizeDocEndpoint(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { summary: 's' } });
  });
});

// ─── handleAiEndpointError ─────────────────────────────────────

describe('handleAiEndpointError — error classification', () => {
  it.each([
    ['authentication', 401],
    ['billing',        402],
    ['permission',     403],
    ['rate_limit',     429],
    ['timeout',        504],
    ['network',        502],
  ])('maps %s failureType to HTTP %i', async (failureType, expectedStatus) => {
    aiService.classifyError.mockReturnValueOnce({
      message: 'classified',
      diagnostics: { failureType },
    });
    aiSummary.summarizeTaskWithAI.mockRejectedValueOnce(new Error('upstream boom'));

    const req = { params: { id: 't-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeTaskEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(expectedStatus);
  });

  it('falls back to 500 for unknown failureType', async () => {
    aiService.classifyError.mockReturnValueOnce({
      message: 'unknown',
      diagnostics: { failureType: 'something_new' },
    });
    aiSummary.summarizeTaskWithAI.mockRejectedValueOnce(new Error('upstream'));

    const req = { params: { id: 't-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeTaskEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('strips (Nms) latency suffix from user-facing messages', async () => {
    aiService.classifyError.mockReturnValueOnce({
      message: 'Request failed (2000ms)',
      diagnostics: { failureType: 'timeout' },
    });
    aiSummary.summarizeTaskWithAI.mockRejectedValueOnce(new Error('boom'));

    const req = { params: { id: 't-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeTaskEndpoint(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Request failed' });
  });

  it('on authentication failureType, references the provider name in the message', async () => {
    aiService.classifyError.mockReturnValueOnce({
      message: 'auth fail',
      diagnostics: { failureType: 'authentication' },
    });
    const err = new Error('upstream auth fail');
    err._providerInfo = { displayName: 'OpenAI' };
    aiSummary.summarizeTaskWithAI.mockRejectedValueOnce(err);

    const req = { params: { id: 't-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeTaskEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    const body = res.json.mock.calls[0][0];
    expect(body.message).toContain('OpenAI');
    expect(body.message).toContain('invalid or expired');
  });

  it('maps "Unknown AI provider type" error to AI_PROVIDER_UNSUPPORTED 400', async () => {
    aiSummary.summarizeTaskWithAI.mockRejectedValueOnce(new Error('Unknown AI provider type foo'));

    const req = { params: { id: 't-1' }, user: MEMBER, body: {} };
    const res = mockRes();
    await summarizeTaskEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      code: 'AI_PROVIDER_UNSUPPORTED',
      message: 'The selected AI provider type is not supported.',
    });
  });
});
