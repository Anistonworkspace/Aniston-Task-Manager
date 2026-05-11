'use strict';

/**
 * Tests for the webhook retry cron + the underlying
 * webhookService.retryFailedDeliveries pipeline.
 *
 * Most of the meaningful logic lives in webhookService (the cron file is a
 * thin schedule wrapper), so we exercise both:
 *
 *   - Cron wrapper schedules every 5 min and wraps in withCronLock.
 *   - retryFailedDeliveries finds rows with status='failed' AND
 *     nextRetryAt <= now AND attempts < MAX.
 *   - On HTTP 2xx ack, the delivery flips to status='success'.
 *   - On HTTP error, attempts increments and a new nextRetryAt is scheduled.
 *   - After MAX_ATTEMPTS, status flips to 'dead' (no further retry scheduled).
 */

process.env.LOG_LEVEL = 'error';

// ─── Mock global fetch BEFORE requiring webhookService ──────────────────
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ─── Models / cron / lock mocks ─────────────────────────────────────────
const mockDeliveryFindAll = jest.fn();

jest.mock('../../models', () => ({
  Webhook: { findAll: jest.fn() },
  WebhookDelivery: {
    findAll: (...a) => mockDeliveryFindAll(...a),
    create: jest.fn(),
  },
  ApiKey: {},
}));

jest.mock('node-cron', () => ({ schedule: jest.fn() }));

jest.mock('../../jobs/cronLock', () => ({
  withCronLock: jest.fn(async (_name, fn) => fn()),
}));

const cron = require('node-cron');
const { withCronLock } = require('../../jobs/cronLock');
const webhookService = require('../../services/webhookService');
const { startWebhookRetryJob } = require('../../jobs/webhookRetryJob');

// ─── Test helpers ───────────────────────────────────────────────────────

function makeDelivery(overrides = {}) {
  return {
    id: overrides.id || 'd-1',
    event: 'task.created',
    payload: { eventId: 'e-1', event: 'task.created', timestamp: 'now', data: {} },
    attempts: overrides.attempts ?? 1,
    status: overrides.status ?? 'failed',
    update: jest.fn().mockResolvedValue(true),
    webhook: overrides.webhook || makeWebhook(),
    ...overrides,
  };
}

function makeWebhook(overrides = {}) {
  return {
    id: 'w-1',
    url: 'https://example.test/hook',
    secret: 'hmac-secret',
    isActive: true,
    update: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function ok(status = 200) {
  return {
    ok: true,
    status,
    text: jest.fn().mockResolvedValue('ack'),
  };
}

function bad(status = 503) {
  return {
    ok: false,
    status,
    text: jest.fn().mockResolvedValue('upstream error'),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockDeliveryFindAll.mockReset();
  cron.schedule.mockReset();
  withCronLock.mockClear();
});

// ─── Cron wrapper ────────────────────────────────────────────────────────

describe('startWebhookRetryJob', () => {
  it('schedules a cron tick every 5 minutes and wraps work in withCronLock', async () => {
    startWebhookRetryJob();
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.schedule.mock.calls[0][0]).toBe('*/5 * * * *');

    // Drive the tick — assert it acquires the lock with the correct key.
    mockDeliveryFindAll.mockResolvedValueOnce([]);
    await cron.schedule.mock.calls[0][1]();
    expect(withCronLock).toHaveBeenCalledTimes(1);
    expect(withCronLock.mock.calls[0][0]).toBe('webhookRetryJob:5min');
  });
});

// ─── retryFailedDeliveries pipeline ──────────────────────────────────────

describe('retryFailedDeliveries — success path', () => {
  it('marks delivery as success on HTTP 2xx', async () => {
    const delivery = makeDelivery({ attempts: 1 });
    mockDeliveryFindAll.mockResolvedValueOnce([delivery]);
    mockFetch.mockResolvedValueOnce(ok(200));

    await webhookService.retryFailedDeliveries();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // First positional update was the success-flip.
    const updateArg = delivery.update.mock.calls.find((c) => c[0].status === 'success');
    expect(updateArg).toBeDefined();
    expect(updateArg[0].attempts).toBe(2); // attempts++ after the retry
    expect(updateArg[0].nextRetryAt).toBeNull();
  });
});

describe('retryFailedDeliveries — failure path', () => {
  it('increments attempts and schedules a future retry on HTTP 5xx (not exhausted)', async () => {
    const delivery = makeDelivery({ attempts: 1 });
    mockDeliveryFindAll.mockResolvedValueOnce([delivery]);
    mockFetch.mockResolvedValueOnce(bad(503));

    await webhookService.retryFailedDeliveries();

    const failUpdate = delivery.update.mock.calls.find((c) => c[0].status === 'failed');
    expect(failUpdate).toBeDefined();
    expect(failUpdate[0].attempts).toBe(2);
    expect(failUpdate[0].nextRetryAt).toBeInstanceOf(Date);
    expect(failUpdate[0].nextRetryAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('flips status to "dead" after MAX_ATTEMPTS without scheduling another retry', async () => {
    // MAX_ATTEMPTS = 5; start at attempts=4 so attempts++ → 5 = exhausted.
    const delivery = makeDelivery({ attempts: 4 });
    mockDeliveryFindAll.mockResolvedValueOnce([delivery]);
    mockFetch.mockResolvedValueOnce(bad(500));

    await webhookService.retryFailedDeliveries();

    const deadUpdate = delivery.update.mock.calls.find((c) => c[0].status === 'dead');
    expect(deadUpdate).toBeDefined();
    expect(deadUpdate[0].nextRetryAt).toBeNull();
    expect(deadUpdate[0].attempts).toBe(5);
  });

  it('catches a network error (fetch throws) and schedules a retry', async () => {
    const delivery = makeDelivery({ attempts: 1 });
    mockDeliveryFindAll.mockResolvedValueOnce([delivery]);
    mockFetch.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    await webhookService.retryFailedDeliveries();

    const failUpdate = delivery.update.mock.calls.find((c) => c[0].status === 'failed');
    expect(failUpdate).toBeDefined();
    expect(failUpdate[0].errorMessage).toMatch(/ETIMEDOUT/);
  });
});

describe('retryFailedDeliveries — query shape', () => {
  it('only selects status=failed deliveries whose nextRetryAt has elapsed', async () => {
    mockDeliveryFindAll.mockResolvedValueOnce([]);
    await webhookService.retryFailedDeliveries();
    expect(mockDeliveryFindAll).toHaveBeenCalledTimes(1);
    const opts = mockDeliveryFindAll.mock.calls[0][0];
    expect(opts.where.status).toBe('failed');
    expect(opts.where.nextRetryAt).toBeDefined();
    expect(opts.where.attempts).toBeDefined();
    expect(opts.limit).toBe(50);
  });
});
