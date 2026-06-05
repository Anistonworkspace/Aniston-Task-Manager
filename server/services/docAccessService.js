'use strict';

/**
 * docAccessService — canonical "can this user see/edit this doc" resolver.
 *
 * feat/docs-personal-notion Phase 2. Replaces the legacy
 * canCallerSeeWorkspace path (workspace/board/role membership). The
 * authoritative rule:
 *
 *     hasDocAccess(user, doc) =
 *         user.isSuperAdmin                                   // 17.7 (a) bypass
 *      OR doc.ownerUserId === user.id
 *      OR EXISTS(doc_access WHERE docId=doc.id AND userId=user.id)
 *
 * No fallback to workspace, board, hierarchy, tier, or role (other than
 * super-admin). New users joining a workspace do NOT auto-acquire access
 * to pre-existing docs in that workspace.
 *
 * Phase 2 only switches the LIST endpoint to this resolver. Phase 3
 * will extend it to read / update / archive / restore / comments / AI /
 * versions / restoreVersion / migrate.
 */

const { Op } = require('sequelize');
const { Doc, DocAccess } = require('../models');
const safeLogger = require('../utils/safeLogger');
// June 2026 — Tier 1 AND Tier 2 are full doc admins (decision: admins manage
// all docs). They see every doc and act with owner-level access, exactly like
// the super-admin bypass. This intentionally widens the May 2026 rule that
// made super-admin the ONLY role-based bypass.
const { hasTierAtLeast, TIER_2 } = require('../config/tiers');

const ACCESS_LEVELS = ['view', 'comment', 'edit', 'owner'];
function levelRank(level) {
  const idx = ACCESS_LEVELS.indexOf(level);
  return idx === -1 ? -1 : idx;
}

/**
 * Doc admins (Tier 1 / Tier 2) get the same blanket access super-admins do:
 * they can see every doc and act on it at owner level. Super-admin implies
 * Tier 1, so the tier check covers them too, but we keep the explicit
 * isSuperAdmin clause for environments where tier hasn't been backfilled.
 */
function isDocAdmin(user) {
  if (!user) return false;
  return user.isSuperAdmin === true || hasTierAtLeast(user, TIER_2);
}

/**
 * Returns the set of doc IDs the user can see. Super-admin gets every
 * non-deleted doc. Other users get owner-rows + doc_access matches.
 *
 * Returns an array (not a Set) so callers can pass it directly into
 * Sequelize WHERE `{ [Op.in]: ids }` clauses.
 */
async function getMyVisibleDocIds(user) {
  if (!user) return [];
  if (isDocAdmin(user)) {
    const all = await Doc.findAll({ attributes: ['id'], raw: true });
    return all.map((d) => d.id);
  }
  // Owner match — checks both ownerUserId (canonical, post-Phase-2) AND
  // createdBy (legacy fallback). Required during the brief window between
  // schema additions and backfill completion, and as a safety net if any
  // future code creates a doc without ownerUserId.
  const { Op } = require('sequelize');
  const [owned, shared] = await Promise.all([
    Doc.findAll({
      where: {
        [Op.or]: [
          { ownerUserId: user.id },
          { ownerUserId: null, createdBy: user.id },
        ],
      },
      attributes: ['id'],
      raw: true,
    }),
    DocAccess.findAll({
      where: { userId: user.id },
      attributes: ['docId'],
      raw: true,
    }),
  ]);
  const ids = new Set();
  for (const d of owned) ids.add(d.id);
  for (const a of shared) ids.add(a.docId);
  return Array.from(ids);
}

// Resolves the canonical owner of a doc — prefers ownerUserId, falls back
// to createdBy when the row pre-dates the Phase 2 backfill or was created
// by code that didn't set ownerUserId.
function resolveOwnerId(doc) {
  if (!doc) return null;
  return doc.ownerUserId || doc.createdBy || null;
}

/**
 * Boolean: can this user read this doc? Accepts either a Doc instance
 * (avoids a roundtrip when the caller has already loaded it) or a docId.
 *
 * Returns false for unknown users/docs — never throws on lookup miss.
 */
async function hasDocAccess(user, docOrId) {
  if (!user) return false;
  if (isDocAdmin(user)) return true;
  let owner, docId;
  if (typeof docOrId === 'string') {
    docId = docOrId;
    const doc = await Doc.findByPk(docId, { attributes: ['ownerUserId', 'createdBy'] });
    if (!doc) return false;
    owner = resolveOwnerId(doc);
  } else if (docOrId && typeof docOrId === 'object') {
    docId = docOrId.id;
    owner = resolveOwnerId(docOrId);
  } else {
    return false;
  }
  if (owner && owner === user.id) return true;
  const row = await DocAccess.findOne({
    where: { docId, userId: user.id },
    attributes: ['id'],
  });
  return !!row;
}

/**
 * Returns the effective access level for this user on this doc, or null.
 * 'owner' for super-admin (mirrors the bypass everywhere).
 */
async function getDocAccessLevel(user, doc) {
  if (!user || !doc) return null;
  if (isDocAdmin(user)) return 'owner';
  const owner = resolveOwnerId(doc);
  if (owner && owner === user.id) return 'owner';
  const row = await DocAccess.findOne({
    where: { docId: doc.id, userId: user.id },
    attributes: ['accessLevel'],
  });
  return row?.accessLevel || null;
}

/**
 * Upsert a doc_access grant. Never DOWNGRADES the existing level — a
 * 'view' insert against an existing 'edit' row is a no-op. Used by the
 * mention sync (Phase 5) and the manual share endpoints (Phase 3+).
 *
 * `source` records why the grant exists so the Phase 5 mention-removal
 * logic can prune only its own rows.
 */
async function upsertAccess({ docId, userId, accessLevel, source, grantedByUserId = null }) {
  if (!docId || !userId || !accessLevel || !source) {
    throw new Error('upsertAccess requires docId, userId, accessLevel, source');
  }
  const existing = await DocAccess.findOne({ where: { docId, userId } });
  if (!existing) {
    try {
      await DocAccess.create({
        docId, userId, accessLevel, source, grantedByUserId,
      });
      return { created: true, upgraded: false };
    } catch (err) {
      // Unique-index race: another writer beat us. Re-read + re-evaluate.
      safeLogger.warn('[DocAccess] upsert race (non-fatal)', { docId, userId, err });
      const retry = await DocAccess.findOne({ where: { docId, userId } });
      if (!retry) throw err;
      return { created: false, upgraded: false };
    }
  }
  // Existing — only update if the new level is HIGHER.
  if (levelRank(accessLevel) > levelRank(existing.accessLevel)) {
    await existing.update({ accessLevel, source, grantedByUserId });
    return { created: false, upgraded: true };
  }
  return { created: false, upgraded: false };
}

module.exports = {
  getMyVisibleDocIds,
  hasDocAccess,
  getDocAccessLevel,
  upsertAccess,
  isDocAdmin,
  ACCESS_LEVELS,
  levelRank,
};
