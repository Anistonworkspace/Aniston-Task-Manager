const axios = require('axios');
const { User, Task, Board } = require('../models');
const teamsConfig = require('../config/teams');
const { getAppToken } = require('./teamsUserSync');

// In-memory cache for calendar events (5-minute TTL)
const calendarCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get a valid access token for a user, refreshing if expired.
 */
async function getAccessToken(userId) {
  const user = await User.findByPk(userId);
  if (!user || !user.teamsAccessToken) return null;

  // Check if token is expired (with 5 min buffer)
  if (user.teamsTokenExpiry && new Date(user.teamsTokenExpiry) < new Date(Date.now() + 5 * 60 * 1000)) {
    // Refresh the token
    if (!user.teamsRefreshToken) return null;
    try {
      const res = await axios.post(`${teamsConfig.authUrl}/token`, new URLSearchParams({
        client_id: teamsConfig.clientId,
        client_secret: teamsConfig.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: user.teamsRefreshToken,
        scope: teamsConfig.scopes.join(' '),
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      await user.update({
        teamsAccessToken: res.data.access_token,
        teamsRefreshToken: res.data.refresh_token || user.teamsRefreshToken,
        teamsTokenExpiry: new Date(Date.now() + res.data.expires_in * 1000),
      });

      return res.data.access_token;
    } catch (err) {
      console.error('[Calendar] Token refresh failed:', err.response?.data || err.message);
      return null;
    }
  }

  return user.teamsAccessToken;
}

/**
 * Create a Teams calendar event for a task.
 */
async function createTaskEvent(taskId, userId) {
  if (!teamsConfig.isConfigured) return null;

  const token = await getAccessToken(userId);
  if (!token) {
    console.log('[Calendar] User has not connected Teams — skipping calendar event for task', taskId);
    return null;
  }

  const task = await Task.findByPk(taskId, {
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name', 'email'] },
      { model: Board, as: 'board', attributes: ['id', 'name'] },
    ],
  });
  if (!task) return null;

  const startTime = task.plannedStartTime || task.startDate || new Date();
  const endTime = task.plannedEndTime || task.dueDate || new Date(new Date(startTime).getTime() + 60 * 60 * 1000);

  const event = {
    subject: `[Project Hub] ${task.title}`,
    body: {
      contentType: 'HTML',
      content: `
        <b>Task:</b> ${task.title}<br>
        <b>Board:</b> ${task.board?.name || 'N/A'}<br>
        <b>Priority:</b> ${task.priority}<br>
        <b>Status:</b> ${task.status}<br>
        ${task.description ? `<b>Description:</b> ${task.description}<br>` : ''}
        <br><a href="${process.env.CLIENT_URL || 'http://localhost:3000'}/boards/${task.boardId}">Open in Project Hub</a>
      `,
    },
    start: {
      dateTime: new Date(startTime).toISOString(),
      timeZone: 'UTC',
    },
    end: {
      dateTime: new Date(endTime).toISOString(),
      timeZone: 'UTC',
    },
    categories: ['Project Hub', task.priority],
    isReminderOn: true,
    reminderMinutesBeforeStart: 30,
  };

  // Add assignee as attendee if different from calendar owner
  if (task.assignee && task.assignee.email) {
    event.attendees = [{
      emailAddress: { address: task.assignee.email, name: task.assignee.name },
      type: 'required',
    }];
  }

  try {
    const res = await axios.post(`${teamsConfig.graphUrl}/me/events`, event, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    // Save event ID to task
    await task.update({ teamsEventId: res.data.id });
    console.log(`[Calendar] Event created for task "${task.title}" (ID: ${res.data.id})`);
    return res.data.id;
  } catch (err) {
    console.error('[Calendar] Create event failed:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Update an existing Teams calendar event.
 */
async function updateTaskEvent(taskId, userId) {
  if (!teamsConfig.isConfigured) return null;

  const task = await Task.findByPk(taskId, {
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name', 'email'] },
      { model: Board, as: 'board', attributes: ['id', 'name'] },
    ],
  });
  if (!task || !task.teamsEventId) return null;

  const token = await getAccessToken(userId);
  if (!token) return null;

  const startTime = task.plannedStartTime || task.startDate || new Date();
  const endTime = task.plannedEndTime || task.dueDate || new Date(new Date(startTime).getTime() + 60 * 60 * 1000);

  const updates = {
    subject: `[Project Hub] ${task.title}`,
    body: {
      contentType: 'HTML',
      content: `
        <b>Task:</b> ${task.title}<br>
        <b>Board:</b> ${task.board?.name || 'N/A'}<br>
        <b>Priority:</b> ${task.priority}<br>
        <b>Status:</b> ${task.status}<br>
        ${task.description ? `<b>Description:</b> ${task.description}<br>` : ''}
      `,
    },
    start: { dateTime: new Date(startTime).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(endTime).toISOString(), timeZone: 'UTC' },
  };

  try {
    await axios.patch(`${teamsConfig.graphUrl}/me/events/${task.teamsEventId}`, updates, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    console.log(`[Calendar] Event updated for task "${task.title}"`);
    return task.teamsEventId;
  } catch (err) {
    console.error('[Calendar] Update event failed:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Delete a Teams calendar event.
 */
async function deleteTaskEvent(taskId, userId) {
  if (!teamsConfig.isConfigured) return;

  const task = await Task.findByPk(taskId);
  if (!task || !task.teamsEventId) return;

  const token = await getAccessToken(userId);
  if (!token) return;

  try {
    await axios.delete(`${teamsConfig.graphUrl}/me/events/${task.teamsEventId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`[Calendar] Event deleted for task "${task.title}"`);
    await task.update({ teamsEventId: null });
  } catch (err) {
    console.error('[Calendar] Delete event failed:', err.response?.data || err.message);
  }
}

/**
 * Sync a task to Teams calendar (create or update).
 */
async function syncToTeamsCalendar(taskId, userId) {
  const task = await Task.findByPk(taskId);
  if (!task) return;

  if (task.teamsEventId) {
    return updateTaskEvent(taskId, userId);
  } else {
    return createTaskEvent(taskId, userId);
  }
}

/**
 * Fetch calendar events from Microsoft 365 for a user (app-level access).
 * Returns { timedEvents: [...], allDayEvents: [...] } or null if user has no teamsUserId.
 */
async function fetchCalendarEvents(teamsUserId, startDate, endDate) {
  if (!teamsConfig.isConfigured || !teamsUserId) return null;

  // Check cache
  const cacheKey = `${teamsUserId}:${startDate}:${endDate}`;
  const cached = calendarCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  try {
    const token = await getAppToken();

    const startISO = `${startDate}T00:00:00`;
    const endISO = `${endDate}T23:59:59`;

    let allEvents = [];
    let nextLink = `${teamsConfig.graphUrl}/users/${teamsUserId}/calendarView?startDateTime=${startISO}&endDateTime=${endISO}&$select=id,subject,start,end,isAllDay,location,showAs,bodyPreview&$top=100&$orderby=start/dateTime`;

    while (nextLink) {
      const res = await axios.get(nextLink, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Prefer': 'outlook.timezone="Asia/Kolkata"',
        },
      });
      allEvents = allEvents.concat(res.data.value || []);
      nextLink = res.data['@odata.nextLink'] || null;
    }

    // Map and separate timed vs all-day events
    const timedEvents = [];
    const allDayEvents = [];

    for (const event of allEvents) {
      const mapped = {
        id: event.id,
        subject: event.subject || '(No title)',
        isAllDay: event.isAllDay,
        location: event.location?.displayName || '',
        showAs: event.showAs,
        bodyPreview: event.bodyPreview || '',
        source: 'teams',
      };

      if (event.isAllDay) {
        // All-day events: extract date from start
        mapped.date = event.start.dateTime.split('T')[0];
        allDayEvents.push(mapped);
      } else {
        // Timed events: extract date and HH:MM
        const startDT = event.start.dateTime;
        const endDT = event.end.dateTime;
        mapped.date = startDT.split('T')[0];
        mapped.startTime = startDT.split('T')[1].substring(0, 5); // HH:MM
        mapped.endTime = endDT.split('T')[1].substring(0, 5);
        // Handle events that span midnight (cap at day end)
        if (mapped.endTime <= mapped.startTime) mapped.endTime = '20:00';
        timedEvents.push(mapped);
      }
    }

    const result = { timedEvents, allDayEvents };

    // Cache the result
    calendarCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL });

    // Lazy cleanup of expired cache entries
    for (const [key, val] of calendarCache) {
      if (val.expiresAt < Date.now()) calendarCache.delete(key);
    }

    return result;
  } catch (err) {
    console.error('[Calendar] fetchCalendarEvents error:', err.response?.data?.error?.message || err.message);
    return { timedEvents: [], allDayEvents: [] };
  }
}

module.exports = { getAccessToken, createTaskEvent, updateTaskEvent, deleteTaskEvent, syncToTeamsCalendar, fetchCalendarEvents };
