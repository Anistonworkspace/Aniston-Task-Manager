/**
 * Unified notification service.
 *
 * Handles:
 *   1. In-app notifications (DB insert + Socket.io push)
 *   2. Email notifications (placeholder transport — plug in credentials later)
 *
 * All timestamps stored in UTC.
 */

const { Notification } = require('../models');
const { emitToUser } = require('./socketService');
const logger = require('../utils/logger');

// ─── Email placeholder ──────────────────────────────────────────
// To enable email, install nodemailer and set SMTP_* env vars.
// e.g.: npm install nodemailer
//   SMTP_HOST=smtp.example.com
//   SMTP_PORT=587
//   SMTP_USER=...
//   SMTP_PASS=...
//   SMTP_FROM=noreply@anistonav.com

let transporter = null;

function getEmailTransporter() {
  if (transporter) return transporter;
  try {
    const nodemailer = require('nodemailer');
    const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
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
 * Send a notification to a single user.
 *
 * @param {string}  userId   - Target user UUID
 * @param {string}  title    - Notification subject (used for email subject & push title)
 * @param {string}  message  - Notification body text
 * @param {string}  type     - Notification type enum value
 * @param {string}  taskId   - Related task UUID
 * @param {object}  [opts]   - Optional overrides
 * @param {string}  [opts.email]      - User email (if known) for sending email
 * @param {string}  [opts.userName]   - User display name (for email greeting)
 */
async function sendNotification(userId, title, message, type, taskId, opts = {}) {
  try {
    // 1. In-app notification (DB + Socket.io)
    const notification = await Notification.create({
      type,
      message,
      entityType: 'task',
      entityId: taskId,
      userId,
    });
    emitToUser(userId, 'notification:new', { notification });

    // 2. Email (best-effort, fire-and-forget)
    if (opts.email) {
      const transport = getEmailTransporter();
      if (transport) {
        const from = process.env.SMTP_FROM || 'Monday Aniston <noreply@anistonav.com>';
        transport.sendMail({
          from,
          to: opts.email,
          subject: title,
          text: message,
          html: `<p>${message.replace(/\n/g, '<br>')}</p>`,
        }).catch(err => {
          logger.warn('[NotificationService] Email send failed:', err.message);
        });
      }
    }

    return notification;
  } catch (err) {
    logger.error('[NotificationService] sendNotification error:', err);
    return null;
  }
}

module.exports = { sendNotification };