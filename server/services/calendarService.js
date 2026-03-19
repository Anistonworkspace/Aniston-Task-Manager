const axios = require('axios');
const { User, Task, Board } = require('../models');
const teamsConfig = require('../config/teams');

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
  if (!token) return null;

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

module.exports = { getAccessToken, createTaskEvent, updateTaskEvent, deleteTaskEvent, syncToTeamsCalendar };
