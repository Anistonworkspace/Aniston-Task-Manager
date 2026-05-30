const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const router = express.Router();
const { authenticate, strictAdminOnly } = require('../middleware/auth');
const {
  getConfig, saveConfig, testConfig, deleteConfig,
  getProviders, createProvider, updateProvider, deleteProvider,
  setDefaultProvider, toggleProvider, testProvider,
  chatWithAI, checkGrammar,
  // Plan A Slice 2 — one-shot AI endpoints (summary / suggest / plan).
  summarizeTaskEndpoint, summarizeBoardEndpoint, summarizeDocEndpoint,
  suggestPriorityEndpoint, planWeekEndpoint,
  // Phase E — inline AI transforms on user-selected text.
  inlineEditEndpoint,
  // Notetaker — structured action-item extraction from a transcript.
  extractActionsEndpoint,
} = require('../controllers/aiController');

// All routes require authentication
router.use(authenticate);

// ─── Per-user rate limiter for paid LLM endpoints ─────────────────────────
// /chat and /grammar both call out to a billed AI provider (OpenAI / DeepSeek
// / Ollama). Without per-user throttling a single authenticated client can
// loop these endpoints and rack up cost or trigger upstream throttling that
// affects every other user. The IP-based generalLimiter on /api isn't
// sufficient here: shared-NAT offices (one team behind one public IP) would
// share the budget AND the cost vulnerability would still apply per-account.
//
// Keying by `req.user.id` makes the budget per-account. Super-admins are
// exempt because they may be running diagnostic batch tasks that legitimately
// exceed the user budget. Hot-path note: this limiter runs AFTER `authenticate`
// (router-level), so req.user is populated.
const aiUserLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 LLM calls per user per minute. Generous for a chat session,
           // tight enough that a runaway script burns out fast.
  standardHeaders: true,
  legacyHeaders: false,
  // Authenticated route, so req.user.id is the canonical bucket key. Falls
  // back to req.ip only if for some reason req.user is missing (defensive).
  keyGenerator: (req) => (req.user && req.user.id) || ipKeyGenerator(req.ip),
  skip: (req) => !!(req.user && req.user.isSuperAdmin),
  handler: (req, res, _next, options) => {
    const retryAfterSec = Math.ceil(options.windowMs / 1000);
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({
      success: false,
      code: 'rate_limited',
      bucket: 'ai_user',
      message: 'You are sending AI requests too quickly. Please wait before retrying.',
      retryAfter: retryAfterSec,
    });
  },
});

// ─── Legacy single-config endpoints (backward compat) ───────
router.get('/config', getConfig);
router.post('/config', strictAdminOnly, saveConfig);
router.post('/test', strictAdminOnly, testConfig);
router.delete('/config', strictAdminOnly, deleteConfig);

// ─── Multi-provider CRUD endpoints ──────────────────────────
router.get('/providers', getProviders);
router.post('/providers', strictAdminOnly, createProvider);
router.put('/providers/:id', strictAdminOnly, updateProvider);
router.delete('/providers/:id', strictAdminOnly, deleteProvider);
router.post('/providers/:id/set-default', strictAdminOnly, setDefaultProvider);
router.post('/providers/:id/toggle', strictAdminOnly, toggleProvider);
router.post('/providers/:id/test', strictAdminOnly, testProvider);

// ─── Chat & Grammar (all authenticated users, per-user rate-limited) ──────
router.post('/chat', aiUserLimiter, chatWithAI);
router.post('/grammar', aiUserLimiter, checkGrammar);

// ─── One-shot endpoints (Plan A Slice 2) ─────────────────────────────────
// Same per-user rate limit as /chat — these hit the same paid provider.
router.post('/summarize/task/:id',  aiUserLimiter, summarizeTaskEndpoint);
router.post('/summarize/board/:id', aiUserLimiter, summarizeBoardEndpoint);
router.post('/summarize/doc/:id',   aiUserLimiter, summarizeDocEndpoint);
router.post('/suggest-priority',    aiUserLimiter, suggestPriorityEndpoint);
router.post('/plan-week',           aiUserLimiter, planWeekEndpoint);
// Phase E — inline AI transform on user-selected text. Same rate budget
// as the other one-shot endpoints since it hits the same paid provider.
router.post('/inline-edit',         aiUserLimiter, inlineEditEndpoint);
// Notetaker — extract action items from a transcript.
router.post('/extract-actions',     aiUserLimiter, extractActionsEndpoint);

module.exports = router;
