/**
 * Unit tests for calendarService — axios + Sequelize fully mocked.
 * Validates the post-enhancement behavior: identity markers, attach-by-taskId,
 * idempotent create, non-silent errors, graphUserId tracking, safe delete.
 */

jest.mock('axios');
jest.mock('../../models', () => ({
  User: { findByPk: jest.fn() },
  Task: { findByPk: jest.fn(), update: jest.fn().mockResolvedValue([1]) },
  Board: {},
}));
jest.mock('../../config/teams', () => ({
  getTeamsConfig: jest.fn(),
}));
jest.mock('../../services/teamsUserSync', () => ({
  getAppToken: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const axios = require('axios');
const { User, Task } = require('../../models');
const { getTeamsConfig } = require('../../config/teams');
const { getAppToken } = require('../../services/teamsUserSync');
const calendarService = require('../../services/calendarService');

const CONFIGURED = {
  isConfigured: true,
  graphUrl: 'https://graph.microsoft.com/v1.0',
};

const TASK_ID = '00000000-0000-0000-0000-000000000001';
const BOARD_ID = '00000000-0000-0000-0000-000000000002';
const USER_ID = '00000000-0000-0000-0000-000000000003';
const TEAMS_USER_ID = 'aad-user-guid-001';
const EVENT_ID = 'AAMkAD_event_id_001';

function makeTask(overrides = {}) {
  return {
    id: TASK_ID,
    title: 'Ship feature',
    description: 'desc',
    status: 'working_on_it',
    priority: 'high',
    boardId: BOARD_ID,
    assignedTo: USER_ID,
    dueDate: '2026-05-01',
    startDate: '2026-04-25',
    plannedStartTime: null,
    plannedEndTime: null,
    teamsEventId: null,
    teamsCalendarUserId: null,
    syncStatus: 'not_synced',
    syncAttempts: 0,
    board: { id: BOARD_ID, name: 'Sprint' },
    ...overrides,
  };
}

function makeUser(overrides = {}) {
  return { id: USER_ID, name: 'Alice', teamsUserId: TEAMS_USER_ID, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  getTeamsConfig.mockResolvedValue(CONFIGURED);
  getAppToken.mockResolvedValue('fake-token');
  User.findByPk.mockResolvedValue(makeUser());
});

describe('createTaskEvent', () => {
  it('creates a new event and stores mapping + synced state when no prior mapping exists', async () => {
    Task.findByPk.mockResolvedValue(makeTask());
    // attach query returns no matches
    axios.get.mockResolvedValueOnce({ data: { value: [] } });
    axios.post.mockResolvedValueOnce({ data: { id: EVENT_ID } });

    const result = await calendarService.createTaskEvent(TASK_ID, USER_ID);

    expect(result).toBe(EVENT_ID);
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, payload] = axios.post.mock.calls[0];
    expect(url).toBe(`${CONFIGURED.graphUrl}/users/${TEAMS_USER_ID}/events`);
    expect(payload.subject).toContain('Ship feature');
    // Identity marker must be present in the event body and as an extension property
    expect(payload.body.content).toContain(TASK_ID);
    expect(payload.singleValueExtendedProperties).toEqual([
      expect.objectContaining({ id: calendarService.EXT_TASK_ID, value: TASK_ID }),
    ]);
    expect(Task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        teamsEventId: EVENT_ID,
        teamsCalendarUserId: TEAMS_USER_ID,
        syncStatus: 'synced',
        syncAttempts: 0,
      }),
      expect.objectContaining({ where: { id: TASK_ID } })
    );
  });

  it('attaches an existing event (high-confidence single match) instead of creating a duplicate', async () => {
    Task.findByPk.mockResolvedValue(makeTask());
    axios.get.mockResolvedValueOnce({ data: { value: [{ id: EVENT_ID, subject: 'x' }] } });

    const result = await calendarService.createTaskEvent(TASK_ID, USER_ID);

    expect(result).toBe(EVENT_ID);
    expect(axios.post).not.toHaveBeenCalled();
    expect(Task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        teamsEventId: EVENT_ID,
        teamsCalendarUserId: TEAMS_USER_ID,
        syncStatus: 'synced',
      }),
      expect.any(Object)
    );
  });

  it('refuses to attach when multiple candidates match (ambiguous) and creates a new event', async () => {
    Task.findByPk.mockResolvedValue(makeTask());
    axios.get.mockResolvedValueOnce({ data: { value: [{ id: 'a' }, { id: 'b' }] } });
    axios.post.mockResolvedValueOnce({ data: { id: EVENT_ID } });

    const result = await calendarService.createTaskEvent(TASK_ID, USER_ID);

    expect(result).toBe(EVENT_ID);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: skips create when task already mapped to the same mailbox', async () => {
    Task.findByPk.mockResolvedValue(makeTask({
      teamsEventId: EVENT_ID,
      teamsCalendarUserId: TEAMS_USER_ID,
    }));

    const result = await calendarService.createTaskEvent(TASK_ID, USER_ID);

    expect(result).toBe(EVENT_ID);
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('records sync failure with error message on Graph 5xx', async () => {
    Task.findByPk.mockResolvedValue(makeTask());
    axios.get.mockResolvedValueOnce({ data: { value: [] } });
    axios.post.mockRejectedValueOnce({
      response: { status: 500, data: { error: { message: 'Internal server error' } } },
    });

    const result = await calendarService.createTaskEvent(TASK_ID, USER_ID);

    expect(result).toBeNull();
    expect(Task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        syncStatus: 'failed',
        syncError: expect.stringContaining('Internal server error'),
        syncAttempts: 1,
      }),
      expect.any(Object)
    );
  });

  it('skips cleanly when the user has no teamsUserId', async () => {
    Task.findByPk.mockResolvedValue(makeTask());
    User.findByPk.mockResolvedValue(makeUser({ teamsUserId: null }));

    const result = await calendarService.createTaskEvent(TASK_ID, USER_ID);

    expect(result).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
    expect(Task.update).toHaveBeenCalledWith(
      expect.objectContaining({ syncStatus: 'skipped', syncError: 'user_not_synced_to_m365' }),
      expect.any(Object)
    );
  });
});

describe('updateTaskEvent', () => {
  it('PATCHes the mailbox stored in teamsCalendarUserId, not the current assignee', async () => {
    const storedMailbox = 'aad-user-guid-PREVIOUS';
    Task.findByPk.mockResolvedValue(makeTask({
      teamsEventId: EVENT_ID,
      teamsCalendarUserId: storedMailbox,
      assignedTo: USER_ID, // current assignee different from stored mailbox
    }));
    axios.patch.mockResolvedValueOnce({ data: {} });

    const result = await calendarService.updateTaskEvent(TASK_ID, USER_ID);

    expect(result).toBe(EVENT_ID);
    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining(`/users/${storedMailbox}/events/${EVENT_ID}`),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('prefixes [DONE] onto the subject when the task is marked done', async () => {
    Task.findByPk.mockResolvedValue(makeTask({
      teamsEventId: EVENT_ID,
      teamsCalendarUserId: TEAMS_USER_ID,
      status: 'done',
    }));
    axios.patch.mockResolvedValueOnce({ data: {} });

    await calendarService.updateTaskEvent(TASK_ID, USER_ID);

    const [, payload] = axios.patch.mock.calls[0];
    expect(payload.subject.startsWith('[DONE]')).toBe(true);
  });

  it('falls back to create-or-attach when the remote event is 404 (recreates mapping)', async () => {
    Task.findByPk
      .mockResolvedValueOnce(makeTask({ teamsEventId: EVENT_ID, teamsCalendarUserId: TEAMS_USER_ID }))
      .mockResolvedValueOnce(makeTask({ teamsEventId: null, teamsCalendarUserId: null }));
    axios.patch.mockRejectedValueOnce({
      response: { status: 404, data: { error: { message: 'ErrorItemNotFound' } } },
    });
    axios.get.mockResolvedValueOnce({ data: { value: [] } });
    axios.post.mockResolvedValueOnce({ data: { id: 'new-event-id' } });

    const result = await calendarService.updateTaskEvent(TASK_ID, USER_ID);

    expect(result).toBe('new-event-id');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('falls back to create-or-attach when task has no teamsEventId yet (old task)', async () => {
    Task.findByPk
      .mockResolvedValueOnce(makeTask())             // initial load in updateTaskEvent
      .mockResolvedValueOnce(makeTask());            // reload inside createTaskEvent
    axios.get.mockResolvedValueOnce({ data: { value: [] } });
    axios.post.mockResolvedValueOnce({ data: { id: 'new-event-id' } });

    const result = await calendarService.updateTaskEvent(TASK_ID, USER_ID);

    expect(result).toBe('new-event-id');
    expect(axios.patch).not.toHaveBeenCalled();
  });
});

describe('deleteTaskEvent', () => {
  it('DELETEs using the stored mailbox (teamsCalendarUserId), tolerates 404, and clears mapping', async () => {
    Task.findByPk.mockResolvedValue(makeTask({
      teamsEventId: EVENT_ID,
      teamsCalendarUserId: TEAMS_USER_ID,
    }));
    axios.delete.mockRejectedValueOnce({
      response: { status: 404, data: { error: { message: 'ErrorItemNotFound' } } },
    });

    await calendarService.deleteTaskEvent(TASK_ID, USER_ID);

    expect(axios.delete).toHaveBeenCalledWith(
      expect.stringContaining(`/users/${TEAMS_USER_ID}/events/${EVENT_ID}`),
      expect.any(Object),
    );
    expect(Task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        teamsEventId: null,
        teamsCalendarUserId: null,
        syncStatus: 'not_synced',
      }),
      expect.any(Object),
    );
  });

  it('refuses to delete when an unmapped old task has no high-confidence attach match (safety)', async () => {
    Task.findByPk.mockResolvedValue(makeTask({ teamsEventId: null, teamsCalendarUserId: null }));
    axios.get.mockResolvedValueOnce({ data: { value: [] } });

    await calendarService.deleteTaskEvent(TASK_ID, USER_ID);

    expect(axios.delete).not.toHaveBeenCalled();
  });

  it('attaches and deletes when unmapped old task has exactly one extended-property match', async () => {
    Task.findByPk.mockResolvedValue(makeTask({ teamsEventId: null, teamsCalendarUserId: null }));
    axios.get.mockResolvedValueOnce({ data: { value: [{ id: EVENT_ID }] } });
    axios.delete.mockResolvedValueOnce({ data: {} });

    await calendarService.deleteTaskEvent(TASK_ID, USER_ID);

    expect(axios.delete).toHaveBeenCalledWith(
      expect.stringContaining(`/users/${TEAMS_USER_ID}/events/${EVENT_ID}`),
      expect.any(Object),
    );
  });

  it('refuses to delete when multiple candidates match (ambiguous old task)', async () => {
    Task.findByPk.mockResolvedValue(makeTask({ teamsEventId: null, teamsCalendarUserId: null }));
    axios.get.mockResolvedValueOnce({ data: { value: [{ id: 'a' }, { id: 'b' }] } });

    await calendarService.deleteTaskEvent(TASK_ID, USER_ID);

    expect(axios.delete).not.toHaveBeenCalled();
  });
});

describe('event window (date handling)', () => {
  async function runCreateAndCapture(task) {
    Task.findByPk.mockResolvedValue(task);
    axios.get.mockResolvedValueOnce({ data: { value: [] } });
    axios.post.mockResolvedValueOnce({ data: { id: EVENT_ID } });
    await calendarService.createTaskEvent(TASK_ID, USER_ID);
    return axios.post.mock.calls[0][1];
  }

  it('dueDate-only task → all-day block from createdAt date through dueDate (inclusive, exclusive end)', async () => {
    const payload = await runCreateAndCapture(makeTask({
      dueDate: '2026-04-21', startDate: null, plannedStartTime: null, plannedEndTime: null,
      createdAt: '2026-04-18T09:30:00Z',
    }));
    expect(payload.isAllDay).toBe(true);
    // Start anchored to midnight UTC of createdAt date.
    expect(payload.start.dateTime).toBe('2026-04-18T00:00:00.000Z');
    // End exclusive = dueDate + 1 day.
    expect(payload.end.dateTime).toBe('2026-04-22T00:00:00.000Z');
    expect(payload.reminderMinutesBeforeStart).toBeUndefined();
  });

  it('dueDate-only task with no createdAt → single-day all-day event on dueDate (graceful fallback)', async () => {
    const payload = await runCreateAndCapture(makeTask({
      dueDate: '2026-04-21', startDate: null, plannedStartTime: null, plannedEndTime: null,
      createdAt: null,
    }));
    expect(payload.isAllDay).toBe(true);
    expect(payload.start.dateTime).toBe('2026-04-21T00:00:00.000Z');
    expect(payload.end.dateTime).toBe('2026-04-22T00:00:00.000Z');
  });

  it('dueDate with createdAt in the future (edge) → start clamped to dueDate, not after it', async () => {
    const payload = await runCreateAndCapture(makeTask({
      dueDate: '2026-04-21', startDate: null, plannedStartTime: null, plannedEndTime: null,
      createdAt: '2026-04-30T00:00:00Z', // absurd — createdAt after dueDate
    }));
    expect(payload.isAllDay).toBe(true);
    expect(payload.start.dateTime).toBe('2026-04-21T00:00:00.000Z');
    expect(payload.end.dateTime).toBe('2026-04-22T00:00:00.000Z');
  });

  it('very old task (long-open) → start clamped to WINDOW_DAYS_CAP days before dueDate', async () => {
    const payload = await runCreateAndCapture(makeTask({
      dueDate: '2026-04-21', startDate: null, plannedStartTime: null, plannedEndTime: null,
      createdAt: '2025-01-01T00:00:00Z', // 470+ days before due
    }));
    expect(payload.isAllDay).toBe(true);
    // 60-day cap → 2026-04-21 minus 59 days = 2026-02-21 (60 days inclusive of end = 2026-04-22)
    expect(payload.start.dateTime).toBe('2026-02-21T00:00:00.000Z');
    expect(payload.end.dateTime).toBe('2026-04-22T00:00:00.000Z');
  });

  it('startDate + dueDate → multi-day all-day block (start midnight → day-after-due midnight)', async () => {
    const payload = await runCreateAndCapture(makeTask({
      startDate: '2026-04-25', dueDate: '2026-05-01',
      plannedStartTime: null, plannedEndTime: null,
    }));
    expect(payload.isAllDay).toBe(true);
    expect(payload.start.dateTime).toBe('2026-04-25T00:00:00.000Z');
    expect(payload.end.dateTime).toBe('2026-05-02T00:00:00.000Z');
  });

  it('plannedStartTime + plannedEndTime → timed event, not all-day', async () => {
    const payload = await runCreateAndCapture(makeTask({
      plannedStartTime: '2026-05-10T09:00:00Z', plannedEndTime: '2026-05-10T10:00:00Z',
      dueDate: '2026-05-10', startDate: '2026-05-10',
    }));
    expect(payload.isAllDay).toBe(false);
    expect(payload.start.dateTime).toBe('2026-05-10T09:00:00.000Z');
    expect(payload.end.dateTime).toBe('2026-05-10T10:00:00.000Z');
    expect(payload.reminderMinutesBeforeStart).toBe(30);
  });

  it('plannedStartTime only → 1-hour timed event at that start', async () => {
    const payload = await runCreateAndCapture(makeTask({
      plannedStartTime: '2026-05-15T14:00:00Z', plannedEndTime: null,
      dueDate: null, startDate: null,
    }));
    expect(payload.isAllDay).toBe(false);
    expect(payload.start.dateTime).toBe('2026-05-15T14:00:00.000Z');
    expect(payload.end.dateTime).toBe('2026-05-15T15:00:00.000Z');
  });
});

describe('ensureSynced (retry job)', () => {
  it('respects MAX_RETRY_ATTEMPTS', async () => {
    Task.findByPk.mockResolvedValue(makeTask({
      syncAttempts: calendarService.MAX_RETRY_ATTEMPTS,
    }));

    const result = await calendarService.ensureSynced(TASK_ID);

    expect(result).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
