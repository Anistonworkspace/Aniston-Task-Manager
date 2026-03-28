/**
 * Teams Calendar Service for Director Plan tasks.
 *
 * Creates/updates/deletes Microsoft Graph calendar events for director plan
 * task deadlines. Gracefully handles missing Teams configuration or tokens.
 */
const axios = require('axios');
const { User } = require('../models');

let getTeamsConfig, getAppToken;
try {
  ({ getTeamsConfig } = require('../config/teams'));
  ({ getAppToken } = require('./teamsUserSync'));
} catch (err) {
  // Teams config/sync modules may not exist — all functions will no-op
  console.log('[TeamsCalendar] Teams modules not available — calendar sync disabled.');
}

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

/**
 * Create a calendar event on the user's Teams/Outlook calendar for a director plan task.
 *
 * @param {string} userId - The Aniston Hub user ID (director or assignee)
 * @param {object} params
 * @param {string} params.subject - Event title
 * @param {string} params.body - Event body (HTML)
 * @param {Date|string} params.startTime - Event start
 * @param {Date|string} params.endTime - Event end
 * @param {number} [params.reminder=30] - Reminder minutes before start
 * @returns {string|null} The Teams event ID, or null on failure
 */
async function createCalendarEvent(userId, { subject, body, startTime, endTime, reminder = 30 }) {
  try {
    if (!getTeamsConfig || !getAppToken) return null;

    const teamsConfig = await getTeamsConfig();
    if (!teamsConfig.isConfigured) return null;

    const user = await User.findByPk(userId, { attributes: ['id', 'name', 'teamsUserId'] });
    if (!user || !user.teamsUserId) {
      return null;
    }

    const token = await getAppToken();

    const event = {
      subject,
      body: {
        contentType: 'HTML',
        content: body || '',
      },
      start: {
        dateTime: new Date(startTime).toISOString(),
        timeZone: 'UTC',
      },
      end: {
        dateTime: new Date(endTime).toISOString(),
        timeZone: 'UTC',
      },
      categories: ['Director Plan'],
      isReminderOn: true,
      reminderMinutesBeforeStart: reminder,
    };

    const res = await axios.post(
      `${teamsConfig.graphUrl}/users/${user.teamsUserId}/events`,
      event,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    console.log(`[TeamsCalendar] Event created: "${subject}" for ${user.name} (ID: ${res.data.id})`);
    return res.data.id;
  } catch (error) {
    console.error('[TeamsCalendar] createCalendarEvent error:', error.response?.data?.error?.message || error.message);
    return null;
  }
}

/**
 * Update an existing Teams calendar event.
 *
 * @param {string} userId - The Aniston Hub user ID
 * @param {string} eventId - The Teams event ID to update
 * @param {object} updates - Fields to update (subject, body, startTime, endTime)
 * @returns {string|null} The event ID on success, or null on failure
 */
async function updateCalendarEvent(userId, eventId, updates) {
  try {
    if (!getTeamsConfig || !getAppToken) return null;

    const teamsConfig = await getTeamsConfig();
    if (!teamsConfig.isConfigured) return null;

    const user = await User.findByPk(userId, { attributes: ['id', 'name', 'teamsUserId'] });
    if (!user || !user.teamsUserId) return null;

    const token = await getAppToken();

    const patch = {};
    if (updates.subject) patch.subject = updates.subject;
    if (updates.body) patch.body = { contentType: 'HTML', content: updates.body };
    if (updates.startTime) patch.start = { dateTime: new Date(updates.startTime).toISOString(), timeZone: 'UTC' };
    if (updates.endTime) patch.end = { dateTime: new Date(updates.endTime).toISOString(), timeZone: 'UTC' };

    await axios.patch(
      `${teamsConfig.graphUrl}/users/${user.teamsUserId}/events/${eventId}`,
      patch,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    console.log(`[TeamsCalendar] Event updated: "${updates.subject || eventId}" for ${user.name}`);
    return eventId;
  } catch (error) {
    console.error('[TeamsCalendar] updateCalendarEvent error:', error.response?.data?.error?.message || error.message);
    return null;
  }
}

/**
 * Delete a Teams calendar event.
 *
 * @param {string} userId - The Aniston Hub user ID
 * @param {string} eventId - The Teams event ID to delete
 */
async function deleteCalendarEvent(userId, eventId) {
  try {
    if (!getTeamsConfig || !getAppToken) return;

    const teamsConfig = await getTeamsConfig();
    if (!teamsConfig.isConfigured) return;

    const user = await User.findByPk(userId, { attributes: ['id', 'name', 'teamsUserId'] });
    if (!user || !user.teamsUserId) return;

    const token = await getAppToken();

    await axios.delete(
      `${teamsConfig.graphUrl}/users/${user.teamsUserId}/events/${eventId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    console.log(`[TeamsCalendar] Event deleted: ${eventId} for ${user.name}`);
  } catch (error) {
    console.error('[TeamsCalendar] deleteCalendarEvent error:', error.response?.data?.error?.message || error.message);
  }
}

module.exports = { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent };
