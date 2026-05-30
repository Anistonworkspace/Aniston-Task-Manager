'use strict';

/**
 * User Mention Controller — feat/docs-personal-notion Phase 4.
 *
 * GET /api/users/mentions?q=<query>&limit=<n>
 *
 * Global active-user search used by:
 *   - The @-mention picker inside personal docs (Phase 5+ will share this
 *     endpoint for comments + composer chips too).
 *   - The Share panel's "add collaborator" picker (Phase 8).
 *
 * Per decision 17.5 the search returns ANY active user in the app —
 * workspace / board / department / role / hierarchy are NOT consulted.
 * The Tier 4 employee in engineering can mention the CEO.
 *
 * Privacy:
 *   - Only `id, name, email, avatar` are returned. Role / tier / department
 *     are deliberately omitted so a low-tier caller cannot enumerate the
 *     org chart via this endpoint.
 *   - `accountStatus='approved' AND isActive=true` filter excludes:
 *       · soft-deactivated users (offboarded employees)
 *       · pending accounts (awaiting admin approval)
 *       · rejected accounts (admin-denied signups)
 *   - Self is excluded (you can't mention yourself).
 *
 * Result cap:
 *   - Default 15, max 25. The picker only needs ~10 visible rows.
 *   - Frontend debounces to ~4 requests/second worst case.
 *
 * Rate limiting:
 *   - Per-IP via the route-level limiter (see routes/userMentions.js).
 *     60/min/IP is generous — typical @ session is well under 20 requests.
 */

const { Op } = require('sequelize');
const { User } = require('../models');
const safeLogger = require('../utils/safeLogger');

const SAFE_USER_ATTRS = ['id', 'name', 'email', 'avatar'];
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 25;
const MAX_QUERY_LEN = 80;

/**
 * Shared implementation — also called by the legacy
 * `/api/docs/mentionable` route handler so old clients get the new
 * global behavior with zero migration effort. The legacy `workspaceId`
 * query param is silently ignored (workspace scoping is no longer a thing).
 */
async function searchMentionableUsers(req, res) {
  try {
    const q = String(req.query.q || '').trim().slice(0, MAX_QUERY_LEN);
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    const where = {
      isActive: true,
      accountStatus: 'approved',
    };
    // Exclude self — you can't @-mention yourself.
    if (req.user?.id) {
      where.id = { [Op.ne]: req.user.id };
    }
    if (q) {
      const like = { [Op.iLike]: `%${q}%` };
      where[Op.or] = [{ name: like }, { email: like }];
    }

    const users = await User.findAll({
      where,
      attributes: SAFE_USER_ATTRS,
      order: [['name', 'ASC']],
      limit,
    });

    res.json({
      success: true,
      data: {
        users: users.map((u) => ({
          id: u.id, name: u.name, email: u.email, avatar: u.avatar,
        })),
      },
    });
  } catch (err) {
    safeLogger.error('[UserMention] searchMentionableUsers error', { err });
    res.status(500).json({ success: false, message: 'Failed to search users.' });
  }
}

module.exports = {
  searchMentionableUsers,
  // Exposed for tests + the legacy /api/docs/mentionable delegation in
  // docController.listMentionableUsers.
  __SAFE_USER_ATTRS: SAFE_USER_ATTRS,
  __DEFAULT_LIMIT: DEFAULT_LIMIT,
  __MAX_LIMIT: MAX_LIMIT,
};
