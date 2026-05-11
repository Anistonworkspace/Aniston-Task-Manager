'use strict';

/**
 * Tests for the recurring template generation cron tick.
 *
 * The job:
 *   - Finds active, non-archived templates whose nextRunAt has elapsed.
 *   - For each, calls recurringTaskService.runTemplateOnce — which is the
 *     unit responsible for idempotency (partial unique index on
 *     (recurringTemplateId, occurrenceDate)) and assignee validation
 *     (skips deactivated assignees with reason='assignee-inactive').
 *   - Errors on one template do NOT abort the rest of the batch.
 */

process.env.LOG_LEVEL = 'error';

const mockTemplateFindAll = jest.fn();
const mockRunTemplateOnce = jest.fn();

jest.mock('../../models', () => ({
  RecurringTaskTemplate: { findAll: (...a) => mockTemplateFindAll(...a) },
}));

jest.mock('../../services/recurringTaskService', () => ({
  runTemplateOnce: (...a) => mockRunTemplateOnce(...a),
}));

jest.mock('node-cron', () => ({ schedule: jest.fn() }));

jest.mock('../../jobs/cronLock', () => ({
  withCronLock: jest.fn(async (_name, fn) => fn()),
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { _tickOnce: tickOnce } = require('../../jobs/recurringTemplateGenerationJob');

function makeTemplate(overrides = {}) {
  return {
    id: overrides.id || 'tpl-1',
    isActive: true,
    archivedAt: null,
    nextRunAt: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

beforeEach(() => {
  mockTemplateFindAll.mockReset();
  mockRunTemplateOnce.mockReset();
});

describe('recurringTemplateGenerationJob.tickOnce — empty queue', () => {
  it('returns zero counters when no templates are due', async () => {
    mockTemplateFindAll.mockResolvedValueOnce([]);
    const r = await tickOnce(new Date());
    expect(r).toEqual({ processed: 0, generated: 0, skipped: 0, errors: 0 });
    expect(mockRunTemplateOnce).not.toHaveBeenCalled();
  });
});

describe('recurringTemplateGenerationJob.tickOnce — per-template service call', () => {
  it('calls runTemplateOnce for every due template', async () => {
    mockTemplateFindAll.mockResolvedValueOnce([
      makeTemplate({ id: 'tpl-A' }),
      makeTemplate({ id: 'tpl-B' }),
    ]);
    mockRunTemplateOnce
      .mockResolvedValueOnce({ ok: true, generated: true, generatedCount: 1 })
      .mockResolvedValueOnce({ ok: true, generated: false });

    const r = await tickOnce(new Date());
    expect(mockRunTemplateOnce).toHaveBeenCalledTimes(2);
    expect(r.processed).toBe(2);
    expect(r.generated).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.errors).toBe(0);
  });

  it('counts backfilled instances when generatedCount > 1 (cron-downtime catch-up)', async () => {
    mockTemplateFindAll.mockResolvedValueOnce([makeTemplate({ id: 'tpl-A' })]);
    mockRunTemplateOnce.mockResolvedValueOnce({
      ok: true,
      generated: true,
      generatedCount: 3,
    });

    const r = await tickOnce(new Date());
    expect(r.generated).toBe(3);
    expect(r.backfilled).toBe(2);
  });
});

describe('recurringTemplateGenerationJob.tickOnce — assignee-inactive skip (Agent #4 fix)', () => {
  it('counts assignee-inactive results as a skipped/error, not a generated instance', async () => {
    mockTemplateFindAll.mockResolvedValueOnce([makeTemplate({ id: 'tpl-A' })]);
    // recurringTaskService returns the error reason when the assignee is
    // deactivated — the job must NOT count this as a generated instance.
    mockRunTemplateOnce.mockResolvedValueOnce({
      ok: false,
      error: 'assignee-inactive',
    });

    const r = await tickOnce(new Date());
    expect(r.processed).toBe(1);
    expect(r.generated).toBe(0);
    expect(r.errors).toBe(1);
  });
});

describe('recurringTemplateGenerationJob.tickOnce — per-template error isolation', () => {
  it('continues processing when one runTemplateOnce throws', async () => {
    mockTemplateFindAll.mockResolvedValueOnce([
      makeTemplate({ id: 'tpl-1' }),
      makeTemplate({ id: 'tpl-2' }),
      makeTemplate({ id: 'tpl-3' }),
    ]);
    mockRunTemplateOnce
      .mockResolvedValueOnce({ ok: true, generated: true, generatedCount: 1 })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true, generated: true, generatedCount: 1 });

    const r = await tickOnce(new Date());
    expect(r.processed).toBe(3);
    expect(r.generated).toBe(2);
    expect(r.errors).toBe(1);
  });
});

describe('recurringTemplateGenerationJob.tickOnce — query shape', () => {
  it('only selects active, non-archived templates whose nextRunAt has elapsed', async () => {
    mockTemplateFindAll.mockResolvedValueOnce([]);
    await tickOnce(new Date());

    const opts = mockTemplateFindAll.mock.calls[0][0];
    expect(opts.where.isActive).toBe(true);
    expect(opts.where.archivedAt).toBeNull();
    expect(opts.where.nextRunAt).toBeDefined();
    expect(opts.order).toEqual([['nextRunAt', 'ASC']]);
    expect(opts.limit).toBe(200);
  });
});
