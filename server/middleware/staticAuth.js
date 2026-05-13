'use strict';

/**
 * Authentication + per-file authorization for the /uploads static directory.
 *
 * Layers:
 *   1. JWT authentication (cookie / Bearer / ?token= query) — closes the
 *      Phase 5e P0-1 anonymous-download hole.
 *   2. Phase 6 per-file ACL — looks up the FileAttachment row by filename
 *      and delegates to taskVisibilityService.canViewTask, so a leaked
 *      filename (CSV export, log line, socket payload) cannot be downloaded
 *      by a user who lacks access to the parent task. Avatars are exempt
 *      (they're public org-wide by design — used in <img src> across the
 *      app). Orphan files (no matching row) are 403 by default.
 *   3. Content-Disposition: attachment forced for non-avatar paths so
 *      same-origin HTML/SVG cannot execute JS in the platform origin.
 *
 * Direct API path (/api/files/:id/download) remains the canonical download
 * route and enforces its own ACL via fileController.canAccessTask. This
 * middleware is the safety net for direct /uploads/<name> requests.
 */

const jwt = require('jsonwebtoken');
const path = require('path');
const { Op } = require('sequelize');
const { User, FileAttachment, DependencyRequest } = require('../models');
const { getAccessTokenFromRequest } = require('../utils/authCookies');
const taskVisibility = require('../services/taskVisibilityService');
const { hasPermission: enginePermission } = require('../services/permissionEngine');
const safeLogger = require('../utils/safeLogger');

function send401(res, msg) {
  res.status(401).json({ success: false, message: msg });
}
function send403(res, msg) {
  res.status(403).json({ success: false, message: msg });
}

/**
 * Resolve whether `user` may access a task. Mirrors fileController's
 * canAccessTask exactly so the rule is identical on both paths:
 *   - taskVisibilityService.canViewTask (assignee / creator / owner /
 *     subtree)
 *   - falls back to DependencyRequest membership (a user assigned to a
 *     dependency request on the parent task gets read access to its files).
 */
async function canAccessTaskForStatic(taskId, user) {
  if (!user || !taskId) return false;
  try {
    if (await taskVisibility.canViewTask(user, taskId)) return true;
  } catch (err) {
    safeLogger.warn('[staticAuth] canViewTask threw, falling back to deny', { err });
  }
  try {
    const depCount = await DependencyRequest.count({
      where: { parentTaskId: taskId, assignedToUserId: user.id },
    });
    if (depCount > 0) return true;
  } catch { /* dependency_requests table may not exist on old DBs */ }
  return false;
}

/**
 * Resolve the FileAttachment row for a /uploads/* request path.
 * Tries both the stored `filename` and a substring match on `url` to
 * accommodate provider variations (local FS uses `/uploads/<filename>`,
 * older rows may store `/uploads/task-<id>/<filename>`, etc.).
 */
async function findAttachmentForPath(reqPath) {
  // Strip leading slash and avoid path traversal (already enforced by
  // express.static, but defence in depth).
  const cleaned = String(reqPath || '').replace(/^\/+/, '').replace(/\.\.+/g, '');
  if (!cleaned) return null;
  const basename = path.posix.basename(cleaned);
  if (!basename) return null;
  try {
    // Match by filename first (most accurate — uploads use a unique
    // timestamp-random filename per row). Fall back to url substring
    // match for legacy rows or alternative storage providers.
    const attachment = await FileAttachment.findOne({
      where: {
        [Op.or]: [
          { filename: basename },
          { url: { [Op.like]: `%${basename}%` } },
        ],
      },
      attributes: ['id', 'taskId', 'filename', 'category', 'uploadedBy'],
    });
    return attachment || null;
  } catch (err) {
    safeLogger.warn('[staticAuth] FileAttachment lookup failed', { err });
    return null;
  }
}

async function authenticateForStatic(req, res, next) {
  // Cookie-or-Bearer comes from the shared helper. Query-string fallback is
  // kept here because the helper deliberately doesn't support it (no API
  // consumer should accept tokens via URLs in 2026 — that's an /uploads-only
  // historic quirk for inline <img> tags pre-D-1).
  const cookieOrHeader = getAccessTokenFromRequest(req);
  const queryToken =
    typeof req.query.token === 'string' && req.query.token.length > 0
      ? req.query.token
      : null;
  const token = cookieOrHeader || queryToken;

  if (!token) {
    return send401(res, 'Authentication required to access uploaded files.');
  }

  let user;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type === 'refresh') {
      return send401(res, 'Refresh tokens are not accepted on /uploads.');
    }
    user = await User.findByPk(decoded.id, {
      attributes: ['id', 'role', 'tier', 'isSuperAdmin', 'isActive'],
    });
    if (!user || !user.isActive) {
      return send401(res, 'Invalid token.');
    }
  } catch (err) {
    return send401(res, 'Invalid or expired token.');
  }

  // Attach minimal user record so downstream loggers (if any) can audit.
  req.user = user;

  const reqPath = (req.path || req.url || '').toString();
  const isAvatar = /^\/?avatars\//i.test(reqPath);

  // ── P0-4: force download for non-image static content ─────────────
  // /uploads/* is same-origin; if a hostile or mistakenly-allowed file
  // (HTML/SVG/etc.) is served inline, it would run JS in the platform's
  // origin. We force `Content-Disposition: attachment` here BEFORE
  // express.static responds. Avatars are exempt so <img src> works.
  if (!isAvatar) {
    res.setHeader('Content-Disposition', 'attachment');
  }

  // ── Phase 6 per-file ACL ──────────────────────────────────────────
  // Avatars are public org-wide (renders in <img src> across the app).
  // Super admins bypass per-file ACL — they already have unrestricted
  // task visibility.
  if (isAvatar || user.isSuperAdmin) {
    return next();
  }

  const attachment = await findAttachmentForPath(reqPath);
  if (!attachment) {
    // Orphan file (no DB row) — refuse rather than serve. The Phase 5e
    // JWT gate was an order-of-magnitude weaker because any authenticated
    // user could download any orphan; this closes that.
    return send403(res, 'File not found or access denied.');
  }

  // Uploader can always access their own file (they put it there) — but
  // still must hold task_files.download (so a deny override can revoke
  // even own-file download).
  const isUploader = attachment.uploadedBy === user.id;
  if (!isUploader) {
    const allowed = await canAccessTaskForStatic(attachment.taskId, user);
    if (!allowed) {
      return send403(res, 'You do not have access to this file.');
    }
  }

  // Phase 7 — granular task_files.download gate. Enforced even on the
  // direct /uploads path so a deny override actually blocks the leaked-URL
  // attack surface (matches the /api/files/:id/download check above).
  try {
    const canDownload = await enginePermission(user, 'task_files', 'download');
    if (!canDownload) {
      return send403(res, 'You do not have permission to download task files.');
    }
  } catch (err) {
    safeLogger.warn('[staticAuth] download permission check threw, denying', { err });
    return send403(res, 'Permission check failed.');
  }

  return next();
}

module.exports = { authenticateForStatic };
