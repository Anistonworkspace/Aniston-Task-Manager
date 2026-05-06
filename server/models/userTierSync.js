'use strict';

/**
 * User-model sync layer for the tier ↔ legacy (role, isSuperAdmin) bridge.
 *
 * Lives in models/ rather than config/ because it operates on a Sequelize
 * instance surface (.changed(), .isNewRecord, mutable properties). Pure-ish:
 * mutates the passed object, performs no I/O, never calls .save() — so it
 * cannot infinite-loop and is unit-testable with a plain stub object.
 *
 * Used exclusively by User.js's `beforeSave` hook.
 *
 * REQUIRES migration 014 (adds users.tier column).
 */

const {
  tierFromLegacy,
  isValidTier,
  TIER_1,
  TIER_2,
  TIER_3,
  TIER_4,
} = require('../config/tiers');

/**
 * Map a tier onto a Sequelize user instance's legacy fields.
 *
 * Preserves existing role within Tier 2 (admin OR manager) and Tier 1
 * (admin OR manager + super admin) — both are equivalent for the purposes
 * of `tierFromLegacy`, and we don't want to silently rewrite a 'manager'
 * to 'admin' when their tier didn't actually change semantically.
 */
function applyTierToLegacy(user, tier) {
  switch (tier) {
    case TIER_1:
      user.isSuperAdmin = true;
      if (user.role !== 'admin' && user.role !== 'manager') {
        user.role = 'admin'; // canonical default for fresh Tier 1
      }
      break;
    case TIER_2:
      user.isSuperAdmin = false;
      if (user.role !== 'admin' && user.role !== 'manager') {
        user.role = 'admin'; // canonical default for fresh Tier 2
      }
      break;
    case TIER_3:
      user.isSuperAdmin = false;
      user.role = 'assistant_manager';
      break;
    case TIER_4:
      user.isSuperAdmin = false;
      user.role = 'member';
      break;
    default:
      // Unreachable when caller has validated; defensive no-op.
      break;
  }
}

/**
 * Sync between user.tier and (user.role, user.isSuperAdmin).
 *
 * Precedence:
 *   1. If `tier` was explicitly changed in this save → tier wins, mirror to legacy.
 *   2. Else if any legacy field was changed → legacy wins, recompute tier.
 *   3. Else if it's a new record → ensure consistency from whichever side is set.
 *   4. Else → no-op (loop-safe).
 *
 * For Sequelize, "explicitly changed" means `instance.changed('field')`
 * returned true. On a new record this captures fields the caller passed
 * to .create() (vs fields that took model defaults).
 *
 * Mutates the instance in place. Does NOT call .save() — calling .save()
 * inside a beforeSave hook would re-fire the hook indefinitely.
 *
 * @param {object} user Sequelize User instance OR a stub with the same surface
 */
function syncTierAndLegacyOnUser(user) {
  if (!user) return;

  const hasChanged = typeof user.changed === 'function';
  const tierChanged = hasChanged && user.changed('tier');
  const roleChanged = hasChanged && user.changed('role');
  const saChanged   = hasChanged && user.changed('isSuperAdmin');
  const legacyChanged = roleChanged || saChanged;

  if (tierChanged) {
    // tier wins — including when tier AND a legacy field were both set in
    // the same save (the new canonical takes precedence).
    if (!isValidTier(user.tier)) return; // DB CHECK + Sequelize validator catch this; defensive
    applyTierToLegacy(user, user.tier);
    return;
  }

  if (legacyChanged) {
    user.tier = tierFromLegacy(user.role, user.isSuperAdmin);
    return;
  }

  if (user.isNewRecord) {
    // Both sides took defaults; ensure they stay aligned. Recompute tier
    // from legacy when tier itself is missing/invalid; otherwise mirror
    // tier to legacy. Either path is internally consistent because the
    // model defaults already align (tier=4, role='member', isSuperAdmin=false).
    if (isValidTier(user.tier)) {
      applyTierToLegacy(user, user.tier);
    } else {
      user.tier = tierFromLegacy(user.role, user.isSuperAdmin);
    }
  }
}

module.exports = { syncTierAndLegacyOnUser, applyTierToLegacy };
