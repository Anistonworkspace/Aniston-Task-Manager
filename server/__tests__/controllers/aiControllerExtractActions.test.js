'use strict';

/**
 * Endpoint tests for POST /api/ai/extract-actions
 * (Notetaker — extract structured action items from a meeting transcript).
 *
 * Mocking strategy mirrors `__tests__/services/aiSummaryService.test.js`:
 *   - We mock the lowest-level provider call (`aiService.chat`) so the
 *     real `aiSummaryService.extractActionItemsWithAI` runs end-to-end.
 *     This is the same pattern the existing one-shot endpoint tests use
 *     and matches the guidance in the task brief.
 *
 * No controller test file existed for `aiController` previously, so this
 * is a new sibling file scoped narrowly to the extract-actions endpoint.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../services/aiService', () => ({
  chat: jest.fn(),
  classifyError: jest.fn(() => ({ message: 'AI request failed.', diagnostics: {} })),
}));

// aiScopeContextService is unused by extractActionsEndpoint but is required
// transitively by aiSummaryService at module-load time. Mock it so the
// service file loads cleanly without trying to pull real models.
jest.mock('../../services/aiScopeContextService', () => ({
  buildScopeContext: jest.fn(),
}));

// safeLogger is used inside aiSummaryService and aiController to log
// warnings on non-JSON replies and one-shot endpoint errors. Mock so the
// test output stays clean.
jest.mock('../../utils/safeLogger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));

// Models import is triggered by `require('../../controllers/aiController')`.
// Stub out everything the controller could touch; extractActionsEndpoint
// does not read from any of these but the require chain pulls them in.
jest.mock('../../models', () => ({
  AIConfig: { findOne: jest.fn(), update: jest.fn(), destroy: jest.fn() },
  AIProvider: {
    findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn(),
    create: jest.fn(), update: jest.fn(), count: jest.fn(),
  },
  User: {},
  Doc: { findByPk: jest.fn() },
  Workspace: { findByPk: jest.fn() },
}));

jest.mock('../../utils/encryption', () => ({
  encrypt: jest.fn((v) => `enc(${v})`),
  decrypt: jest.fn((v) => v),
  maskSecret: jest.fn((v) => `mask(${v})`),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

jest.mock('../../services/aiContextService', () => ({
  buildAIContext: jest.fn(),
}));

const aiService = require('../../services/aiService');
const { extractActionsEndpoint } = require('../../controllers/aiController');

const USER = { id: 'u1', name: 'Alice', role: 'manager', isSuperAdmin: false };

function buildReqRes(body = {}) {
  const req = { user: USER, body, params: {}, query: {} };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return { req, res };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/ai/extract-actions — extractActionsEndpoint', () => {
  it('returns 400 when body.text is missing', async () => {
    const { req, res } = buildReqRes({});
    await extractActionsEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'invalid_input',
    }));
    // Must short-circuit before touching the provider.
    expect(aiService.chat).not.toHaveBeenCalled();
  });

  it('returns 400 when body.text is an empty string', async () => {
    const { req, res } = buildReqRes({ text: '' });
    await extractActionsEndpoint(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'invalid_input',
      message: expect.stringMatching(/text is required/i),
    }));
    expect(aiService.chat).not.toHaveBeenCalled();
  });

  it('200 happy path: proxies through to the service and returns structured actions', async () => {
    aiService.chat.mockResolvedValue('```json\n{"actions":[' +
      '{"title":"Ship the auth fix","owner":"Sara","dueDate":"2026-06-13","priority":"high"}' +
    ']}\n```');
    const { req, res } = buildReqRes({ text: 'Sara: I will ship the auth fix by June 13.' });
    await extractActionsEndpoint(req, res);

    expect(aiService.chat).toHaveBeenCalledTimes(1);
    // res.status was NOT called with a non-2xx — controller used res.json directly.
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        kind: 'structured',
        actions: [{
          title: 'Ship the auth fix',
          owner: 'Sara',
          dueDate: '2026-06-13',
          priority: 'high',
        }],
      },
    });
  });
});
