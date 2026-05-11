/**
 * Centralised notification service — the ONLY entry point that should
 * create rows in the notifications table.
 *
 * Why centralised
 * ---------------
 * Before this consolidation, ~15 controllers and jobs called
 * `Notification.create(...)` directly. That produced four classes of bugs:
 *
 *   1. Inconsistent sanitization. Some sites ran user-controlled task titles
 *      through `sanitizeNotificationField` (XSS + Markdown defang); most did
 *      not. A malicious task title rendered raw in OS push and Teams cards.
 *
 *   2. No idempotency. Two concurrent edits, two cron ticks, or a retry of
 *      an HTTP request all produced duplicate notification rows for the
 *      same logical event.
 *
 *   3. Email + push fanout was site-specific. Some sites emitted the socket;
 *      some forgot. None routed through pushService.
 *
 *   4. Failures threw out of awaited calls and surfaced as 500s after the
 *      source mutation already committed.
 *
 * The centralised API:
 *
 *   - createNotification({ userId, type, message, entityType, entityId,
 *                          boardId, idempotencyKey, email, userName,
 *                          sanitize, suppressSocket })
 *       → returns the created Notification row, or the EXISTING row if an
 *         idempotency-key collision happened.
 *
 *   - sendNotification(userId, title, message, type, taskId, opts)
 *       → backwards-compatible thin wrapper around createNotification.
 *
 * Idempotency key strategy
 * ------------------------
 * Callers that can repeat for the same logical event SHOULD pass an
 * `idempotencyKey` (max 120 chars). The DB has a partial unique index on
 * (userId, idempotencyKey) WHERE idempotencyKey IS NOT NULL — a duplicate
 * insert is converted to a SELECT of the existing row, no notification is
 * fanned out twice. Callers without a natural key (e.g. unique-per-event
 * approval transitions) can omit it.
 *
 * Convention: build the key from the EVENT semantic, not the request id.
 *   "comment-mention:<commentId>:<userId>"
 *   "task-assigned:<taskId>:<userId>"
 *   "approval-submitted:<flowId>:<userId>"
 *
 * Failure semantics
 * -----------------
 * createNotification NEVER throws. Errors are logged and `null` is returned
 * so the source mutation's controller can finish its response normally.
 */

const { Op } = require('sequelize');
const { Notification, User } = require('../models');
const { emitToUser } = require('./socketService');
const { sanitizeNotificationField, sanitizeNotificationMessage } = require('../utils/sanitize');
const logger = require('../utils/logger');

// ─── Email transport (unchanged from prior implementation) ─────
let transporter = null;
function getEmailTransporter() {
  if (transporter) return transporter;
  try {
    const nodemailer = require('nodemailer');
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
    if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
      transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT, 10) || 587,
        secure: (parseInt(SMTP_PORT, 10) || 587) === 465,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });
      console.log('[NotificationService] Email transport configured');
    }
  } catch (e) {
    // nodemailer not installed — email disabled
  }
  return transporter;
}

/**
 * Build an idempotency key from a list of parts. Joins with `:` and clips
 * to the column length (120). Centralised so callers across the codebase
 * agree on the same shape.
 *
 * Example:
 *   buildIdempotencyKey('task-assigned', taskId, userId)
 *   → 'task-assigned:<taskUuid>:<userUuid>'
 */
function buildIdempotencyKey(...parts) {
  const joined = parts
    .filter((p) => p !== null && p !== undefined && p !== '')
    .map((p) => String(p))
    .join(':');
  return joined.slice(0, 120);
}

/**
 * Lookup an existing notification by (userId, idempotencyKey).
 *
 * Wrapped in a try/catch because the column is added by a boot migration —
 * if the migration somehow hasn't run on this instance the column is
 * missing and the query throws. We then fall back to "create unconditionally"
 * which is the pre-Phase-3 behaviour. Self-healing on first deploy.
 */
async function findByIdempotencyKey(userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  try {
    return await Notification.findOne({
      where: { userId, idempotencyKey },
    });
  } catch (err) {
    return null;
  }
}

/**
 * Create a notification row + emit socket event + (optional) send email.
 *
 * @param {object}  args
 * @param {string}  args.userId          REQUIRED. Recipient user id.
 * @param {string}  args.type            REQUIRED. Must be a value in the DB
 *                                       enum (see Notification model).
 * @param {string}  args.message         REQUIRED. Pre-built body text. Will
 *                                       be sanitized if `sanitize` is true
 *                                       (the default).
 * @param {string}  [args.entityType]    'task' | 'board' | 'meeting' | etc.
 * @param {string}  [args.entityId]      UUID of the entity.
 * @param {string}  [args.boardId]       Optional — improves push deep-link.
 * @param {string}  [args.idempotencyKey] If supplied and a row already exists
 *                                       for (userId, idempotencyKey), the
 *                                       existing row is returned and no new
 *                                       socket/email is fired.
 * @param {string}  [args.email]         If supplied AND SMTP is configured,
 *                                       a best-effort email is sent.
 * @param {string}  [args.userName]      Used in the email greeting.
 * @param {string}  [args.title]         Email subject (default: a generic).
 * @param {boolean} [args.sanitize=true] Run message through sanitizeNotificationMessage.
 * @param {boolean} [args.suppressSocket=false] If true, no socket emit. Used
 *                                       by callers that batch and emit
 *                                       themselves once per recipient.
 */
async function createNotification(args = {}) {
  const {
    userId,
    type,
    message,
    entityType = null,
    entityId = null,
    boardId = null,
    idempotencyKey = null,
    email = null,
    userName = null,
    title = null,
    sanitize = true,
    suppressSocket = false,
  } = args;

  if (!userId || !type || !message) {
    logger.warn('[NotificationService] createNotification missing required args', {
      hasUserId: !!userId, hasType: !!type, hasMessage: !!message,
    });
    return null;
  }

  try {
    // 0. Sanitize the message body. Keeping this inside the service means
    //    every call site is XSS-safe regardless of caller diligence.
    const safeMessage = sanitize ? sanitizeNotificationMessage(message) : String(message);

    // P2-8 — Skip writes addressed to deactivated users. A deactivated
    // account has no session and no UI surface, so writing the row would
    // just accumulate orphan rows and waste socket/email work. The lookup
    // is a single PK fetch on a hot table (kept tight on purpose).
    try {
      const recipient = await User.findByPk(userId, { attributes: ['isActive'] });
      if (recipient && recipient.isActive === false) {
        return { success: false, reason: 'user_inactive' };
      }
    } catch (_) {
      // If the lookup throws (e.g. transient DB blip), fall through to the
      // existing write path so we never silently swallow a notification.
    }

    // 1. Idempotency check FIRST. If this exact event was already created,
    //    skip the insert entirely — no duplicate row, no duplicate emit,
    //    no duplicate email.
    if (idempotencyKey) {
      const existing = await findByIdempotencyKey(userId, idempotencyKey);
      if (existing) {
        // We deliberately do NOT re-emit or re-email — the recipient has
        // already been notified for this logical event.
        return existing;
      }
    }

    // 2. Insert. We try the insert OPTIMISTICALLY rather than running a
    //    findOne + create sequence: under concurrency, two callers can both
    //    pass the findOne and both insert. The DB partial unique index
    //    catches that — we then re-fetch and return the surviving row.
    let notification;
    try {
      notification = await Notification.create({
        type,
        message: safeMessage,
        entityType,
        entityId,
        userId,
        // Column added by boot migration — model declaration is below.
        idempotencyKey: idempotencyKey || null,
      });
    } catch (err) {
      // Postgres SequelizeUniqueConstraintError on the partial unique index
      // means another caller raced us. Re-read and return the winning row.
      if (err && (err.name === 'SequelizeUniqueConstraintError'
                  || err.parent?.code === '23505')
          && idempotencyKey) {
        const existing = await findByIdempotencyKey(userId, idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }

    // 3. Realtime fan-out. Caller can opt out (suppressSocket) when it's
    //    going to emit a single batched event for many recipients.
    if (!suppressSocket) {
      // boardId is forwarded to the socket helper so the SW push can build
      // a deep-link path like /boards/<id>?taskId=<id>.
      emitToUser(userId, 'notification:new', { notification, boardId });
    }

    // 4. Best-effort email. Errors logged, never surfaced.
    if (email) {
      const transport = getEmailTransporter();
      if (transport) {
        const from = process.env.SMTP_FROM || 'Monday Aniston <noreply@anistonav.com>';
        const subject = title || `New notification: ${type.replace(/_/g, ' ')}`;
        transport.sendMail({
          from,
          to: email,
          subject,
          text: safeMessage,
          html: `<p>${safeMessage.replace(/\n/g, '<br>')}</p>`,
        }).catch(err => {
          logger.warn('[NotificationService] Email send failed:', err.message);
        });
      }
    }

    return notification;
  } catch (err) {
    logger.error('[NotificationService] createNotification error:', {
      userId, type, idempotencyKey, msg: err?.message, stack: err?.stack,
    });
    return null;
  }
}

/**
 * Backwards-compatible wrapper around createNotification.
 *
 * Existing callers use the positional form
 *   sendNotification(userId, title, message, type, taskId, { email, userName })
 * which we forward to the structured API. `taskId` becomes the canonical
 * `entityType: 'task' / entityId: taskId` mapping. For non-task events the
 * structured API is preferred.
 *
 * Idempotency note: this wrapper does NOT auto-build an idempotency key
 * because legacy callers may rely on each invocation producing a new row
 * (e.g. recurring reminders that repeat by design). Callers wanting dedup
 * should switch to createNotification and pass `idempotencyKey` explicitly.
 */
async function sendNotification(userId, title, message, type, taskId, opts = {}) {
  return createNotification({
    userId,
    type,
    title,
    message,
    entityType: 'task',
    entityId: taskId,
    boardId: opts.boardId || null,
    email: opts.email || null,
    userName: opts.userName || null,
    idempotencyKey: opts.idempotencyKey || null,
    sanitize: opts.sanitize !== false,
    suppressSocket: !!opts.suppressSocket,
  });
}

module.exports = {
  createNotification,
  sendNotification,
  buildIdempotencyKey,
  // Re-export sanitizers so callers don't need to import from utils/sanitize.
  sanitizeNotificationField,
  sanitizeNotificationMessage,
};
