const cron = require('node-cron');
const { Op } = require('sequelize');
const { TimeBlock } = require('../models');
const { createNotification, buildIdempotencyKey } = require('../services/notificationService');
const { withCronLock } = require('./cronLock');

/**
 * Time Planner reminder job.
 *
 * Every minute, finds time blocks with a reminder set that should fire now
 * (start − reminderMinutesBefore ≤ now < start) and sends an in-app + web-push
 * notification (push is emitted automatically by notificationService via the
 * socket). `reminderSentAt` dedupes via a claim-first conditional UPDATE so a
 * reminder fires at most once and multi-replica deploys never double-send.
 *
 * Timezone: planner blocks store wall-clock `date` + `startTime`. We interpret
 * them in a single planner timezone offset (PLANNER_TZ_OFFSET_MINUTES, default
 * 330 = IST, no DST) — correct for this single-region deployment. Documented
 * limitation: not per-user timezone.
 */

const OFFSET_MIN = Number(process.env.PLANNER_TZ_OFFSET_MINUTES || 330);
const MAX_PER_RUN = 200;

function blockStartMs(dateStr, startTime) {
  // Wall-clock date+time interpreted in the planner timezone → real UTC instant.
  const utcAsIfZulu = Date.parse(`${dateStr}T${startTime}:00Z`);
  return utcAsIfZulu - OFFSET_MIN * 60 * 1000;
}

async function processTimeBlockReminders() {
  const now = Date.now();
  // Bound the scan to a ±2-day window (covers any TZ edge) of un-fired reminders.
  const dayMs = 24 * 60 * 60 * 1000;
  const from = new Date(now - 2 * dayMs).toISOString().slice(0, 10);
  const to = new Date(now + 2 * dayMs).toISOString().slice(0, 10);

  const candidates = await TimeBlock.findAll({
    where: {
      reminderMinutesBefore: { [Op.ne]: null },
      reminderSentAt: null,
      date: { [Op.between]: [from, to] },
    },
    order: [['date', 'ASC'], ['startTime', 'ASC']],
    limit: MAX_PER_RUN,
  });
  if (!candidates.length) return;

  for (const block of candidates) {
    try {
      const startMs = blockStartMs(block.date, block.startTime);
      const fireMs = startMs - block.reminderMinutesBefore * 60 * 1000;
      if (now < fireMs) continue; // not due yet

      // Claim first — only the worker that flips reminderSentAt proceeds.
      const [claimed] = await TimeBlock.update(
        { reminderSentAt: new Date() },
        { where: { id: block.id, reminderSentAt: null } },
      );
      if (!claimed) continue;

      // If the block already started, the window is missed — claimed (so it
      // won't retry) but we skip notifying.
      if (now >= startMs) continue;

      await createNotification({
        userId: block.userId,
        type: 'time_block_reminder',
        message: `Reminder: "${block.title || 'Time block'}" starts at ${block.startTime}`,
        entityType: 'time_block',
        entityId: block.id,
        boardId: block.boardId || null,
        idempotencyKey: buildIdempotencyKey('time-block-reminder', block.id, block.userId),
      });
    } catch (err) {
      console.error('[TimePlannerReminder] block error:', block?.id, err.message);
    }
  }
}

function startTimePlannerReminderJob() {
  cron.schedule('* * * * *', async () => {
    try {
      await withCronLock('timePlannerReminderJob', processTimeBlockReminders);
    } catch (err) {
      console.error('[TimePlannerReminder] cron error:', err.message);
    }
  });
  console.log('[TimePlannerReminder] Cron job started (every minute).');
}

module.exports = { startTimePlannerReminderJob, processTimeBlockReminders };
