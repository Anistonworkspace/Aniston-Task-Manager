'use strict';

/**
 * Centralized tier model — Phase 2 of the role -> tier RBAC migration.
 *
 * THIS IS THE ONLY FILE that maps legacy (role, isSuperAdmin) to/from numeric
 * tier. Every other backend module must import from here; do NOT scatter
 * role-name string literals across the codebase.
 *
 * Tier semantics (numerically smaller = more privileged):
 *   1 — Full system access                    (was: super admin / isSuperAdmin=true)
 *   2 — Broad management, NO destructive ops  (was: admin + manager combined)
 *   3 — Subtree-scoped management              (was: assistant_manager)
 *   4 — Self-scoped contributor                (was: member)
 *
 * Display labels are always "Tier 1".."Tier 4" — never role names.
 *
 * Compatibility window:
 *   - Phase 1 added users.tier with backfill from legacy fields.
 *   - Phase 2 (this file) introduces helpers that ALL backend code can use.
 *   - Phase 3 will add a User-model hook that keeps tier in sync with the
 *     legacy fields; until then resolveTier() falls back to legacy when the
 *     tier column is missing or invalid, so this module works whether or not
 *     migration 014 has been applied to a given environment.
 */

const { Op } = require('sequelize');

// ── Constants ─────────────────────────────────────────────────────────────

const TIER_1 = 1;
const TIER_2 = 2;
const TIER_3 = 3;
const TIER_4 = 4;

const ALL_TIERS = Object.freeze([TIER_1, TIER_2, TIER_3, TIER_4]);
const MIN_TIER = TIER_1;   // most privileged (numerically smallest)
const MAX_TIER = TIER_4;   // least privileged (numerically largest)

const TIER_LABELS = Object.freeze({
  [TIER_1]: 'Tier 1',
  [TIER_2]: 'Tier 2',
  [TIER_3]: 'Tier 3',
  [TIER_4]: 'Tier 4',
});

// ── Error class ───────────────────────────────────────────────────────────

/**
 * Thrown by the assert* helpers. Carries an HTTP status + machine-readable
 * code so route error handlers can convert directly to the correct response
 * without re-classifying the message.
 */
class TierError extends Error {
  constructor(message, { status = 403, code = 'TIER_DENIED' } = {}) {
    super(message);
    this.name = 'TierError';
    this.status = status;
    this.code = code;
  }
}

// ── Predicates ────────────────────────────────────────────────────────────

function isValidTier(t) {
  return Number.isInteger(t) && t >= MIN_TIER && t <= MAX_TIER;
}

// ── Legacy <-> tier mapping (the ONE place role names live) ───────────────

/**
 * @param {string|null|undefined} role
 * @param {boolean|null|undefined} isSuperAdmin
 * @returns {number} a tier in [1..4]
 */
function tierFromLegacy(role, isSuperAdmin) {
  if (isSuperAdmin === true) return TIER_1;
  if (role === 'admin' || role === 'manager') return TIER_2;
  if (role === 'assistant_manager') return TIER_3;
  // 'member' or any unknown / missing value -> least privileged (fail safe).
  return TIER_4;
}

/**
 * Returns the canonical legacy representation for a given tier. Used during
 * the compatibility window when a controller writes a tier and also needs
 * to keep role/isSuperAdmin in sync. The User-model hook in Phase 3 will
 * call this; nothing else should.
 *
 * Note: Tier 2 maps to {role:'admin'} canonically, but a user already at
 * Tier 2 with role='manager' should NOT be silently rewritten to 'admin'.
 * The Phase-3 hook preserves existing-role-within-tier; this helper only
 * exposes the default for fresh writes.
 *
 * @param {number} tier
 * @returns {{role: string, isSuperAdmin: boolean}}
 */
function legacyFromTier(tier) {
  switch (tier) {
    case TIER_1: return { role: 'admin',             isSuperAdmin: true };
    case TIER_2: return { role: 'admin',             isSuperAdmin: false };
    case TIER_3: return { role: 'assistant_manager', isSuperAdmin: false };
    case TIER_4: return { role: 'member',            isSuperAdmin: false };
    default:
      throw new TierError(`Invalid tier: ${tier}`, { status: 400, code: 'INVALID_TIER' });
  }
}

/**
 * Resolves a user's effective tier.
 *   1. If `user.tier` is a valid 1..4 integer (post Phase 1 backfill), use it.
 *   2. Otherwise fall back to `tierFromLegacy(role, isSuperAdmin)` so the
 *      module continues to work in environments where migration 014 has
 *      not yet been applied (e.g. CI snapshots without DB).
 *   3. If the input is null/undefined, return TIER_4 — fail safe.
 *
 * @param {object|null|undefined} user
 * @returns {number} tier
 */
function resolveTier(user) {
  if (!user) return TIER_4;
  if (isValidTier(user.tier)) return user.tier;
  return tierFromLegacy(user.role, user.isSuperAdmin);
}

// ── Convenience predicates ────────────────────────────────────────────────

function isTier1(user) { return resolveTier(user) === TIER_1; }
function isTier2(user) { return resolveTier(user) === TIER_2; }
function isTier3(user) { return resolveTier(user) === TIER_3; }
function isTier4(user) { return resolveTier(user) === TIER_4; }

/**
 * "Does this user have at least the given tier?" — using the standard
 * tier-arithmetic where tier 1 satisfies every requirement.
 *
 *   hasTierAtLeast(user, 2)  // true for tier 1 and 2
 *   hasTierAtLeast(user, 4)  // true for everyone
 *
 * @param {object} user
 * @param {number} requiredTier
 * @returns {boolean}
 */
function hasTierAtLeast(user, requiredTier) {
  if (!isValidTier(requiredTier)) {
    throw new TierError(
      `Invalid required tier: ${requiredTier}`,
      { status: 500, code: 'INVALID_TIER' }
    );
  }
  return resolveTier(user) <= requiredTier;
}

function tierLabel(tier) {
  return TIER_LABELS[tier] || `Tier ${tier}`;
}

// ── Authorization assertions ──────────────────────────────────────────────

/**
 * Throws TierError if `actor` may not assign `newTier` to `target`.
 *
 * Rules (per confirmed product decisions):
 *   - `newTier` must be a valid tier (1..4).
 *   - Tier 1 actors may grant any tier.
 *   - Tier 2 actors may grant ONLY Tier 3 or Tier 4 (never Tier 1 or Tier 2).
 *   - Tier 3 / Tier 4 actors may not grant any tier.
 *   - An actor may never grant a tier more privileged than their own.
 *   - An actor may never promote themselves to a higher tier.
 *
 * Note: this validates the tier-grant authority only. Subtree scoping is a
 * separate concern (scope.js, added in a later phase). Callers that need
 * both must compose the two checks.
 */
function assertCanGrantTier(actor, target, newTier) {
  if (!actor) {
    throw new TierError('Not authenticated.', { status: 401, code: 'UNAUTH' });
  }
  if (!isValidTier(newTier)) {
    throw new TierError(`Invalid tier: ${newTier}`, { status: 400, code: 'INVALID_TIER' });
  }
  const actorTier = resolveTier(actor);

  // Self-promotion to a higher (lower-numbered) tier is forbidden.
  if (target && target.id === actor.id && newTier < actorTier) {
    throw new TierError('Cannot promote yourself.', { status: 403, code: 'SELF_PROMOTION' });
  }

  // Actor cannot grant a tier more privileged than their own.
  if (newTier < actorTier) {
    throw new TierError(
      `Tier ${actorTier} actor cannot grant Tier ${newTier}.`,
      { status: 403, code: 'TIER_GRANT_TOO_HIGH' }
    );
  }

  // Tier 2 actors are limited to granting Tier 3 / Tier 4 only.
  if (actorTier === TIER_2 && newTier < TIER_3) {
    throw new TierError(
      'Tier 2 may only grant Tier 3 or Tier 4.',
      { status: 403, code: 'TIER_2_LIMITED_GRANT' }
    );
  }

  // Tier 3 / Tier 4 actors cannot change tiers at all.
  if (actorTier >= TIER_3) {
    throw new TierError(
      'You do not have permission to change tiers.',
      { status: 403, code: 'TIER_GRANT_FORBIDDEN' }
    );
  }
}

/**
 * Last-Tier-1 protection.
 *
 * Throws TierError if the proposed change would leave zero active Tier 1
 * users in the system. Use BEFORE persisting any of:
 *   - tier change away from 1 (intent: 'demote')
 *   - isActive flip to false  (intent: 'deactivate')
 *   - delete on a Tier 1 user (intent: 'delete')
 *
 * Async — queries the User model for OTHER active Tier 1 users. A stub with
 * a `.count()` method is accepted, which keeps the helper unit-testable.
 *
 * The query uses `isSuperAdmin: true` as the Tier-1 predicate. During the
 * Phase 3 compatibility window the User-model hook keeps `isSuperAdmin` and
 * `tier=1` in lockstep, so this remains correct.
 *
 * @param {object} target          user being changed (must have id; may have tier or legacy fields)
 * @param {string} intent          'demote' | 'deactivate' | 'delete'
 * @param {object} UserModel       Sequelize User model OR stub with .count()
 */
async function assertNotLastTier1Change(target, intent, UserModel) {
  if (!target || !target.id) {
    throw new TierError('Target user required.', { status: 500, code: 'NO_TARGET' });
  }
  if (!UserModel || typeof UserModel.count !== 'function') {
    throw new TierError('User model required.', { status: 500, code: 'NO_USER_MODEL' });
  }
  // The protection only triggers when the target is currently Tier 1.
  if (resolveTier(target) !== TIER_1) return;

  const otherActiveT1 = await UserModel.count({
    where: {
      isSuperAdmin: true,
      isActive: true,
      id: { [Op.ne]: target.id },
    },
  });

  if (otherActiveT1 < 1) {
    const verb =
      intent === 'demote'     ? 'demote'     :
      intent === 'deactivate' ? 'deactivate' :
      intent === 'delete'     ? 'delete'     :
                                 'change';
    throw new TierError(
      `Cannot ${verb} the only Tier 1 user. Promote a successor to Tier 1 first.`,
      { status: 400, code: 'LAST_TIER_1' }
    );
  }
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  // constants
  TIER_1, TIER_2, TIER_3, TIER_4, ALL_TIERS, MIN_TIER, MAX_TIER, TIER_LABELS,
  // error
  TierError,
  // predicates
  isValidTier,
  // mapping
  tierFromLegacy, legacyFromTier, resolveTier,
  // convenience predicates
  isTier1, isTier2, isTier3, isTier4, hasTierAtLeast, tierLabel,
  // assertions
  assertCanGrantTier, assertNotLastTier1Change,
};
