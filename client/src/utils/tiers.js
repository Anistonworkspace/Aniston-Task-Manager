/**
 * Frontend tier model — Phase 6 of role -> tier RBAC migration.
 *
 * Mirrors server/config/tiers.js EXACTLY. Backend remains the source of
 * truth; this module exists so the UI can render tier-based labels and
 * gate visibility consistently with the server matrix.
 *
 * Tier semantics (numerically smaller = more privileged):
 *   1 — Full system access
 *   2 — Broad management (no destructive ops)
 *   3 — Subtree-scoped management
 *   4 — Self-scoped contributor
 *
 * Display labels are always "Tier 1".."Tier 4" — never role names.
 */

export const TIER_1 = 1;
export const TIER_2 = 2;
export const TIER_3 = 3;
export const TIER_4 = 4;

export const ALL_TIERS = Object.freeze([TIER_1, TIER_2, TIER_3, TIER_4]);
export const MIN_TIER = TIER_1;
export const MAX_TIER = TIER_4;

export const TIER_LABELS = Object.freeze({
  [TIER_1]: 'Tier 1',
  [TIER_2]: 'Tier 2',
  [TIER_3]: 'Tier 3',
  [TIER_4]: 'Tier 4',
});

export function isValidTier(t) {
  return Number.isInteger(t) && t >= MIN_TIER && t <= MAX_TIER;
}

/**
 * Mirror of server/config/tiers.js#tierFromLegacy. The single place where
 * legacy role-name strings live in the frontend.
 */
export function tierFromLegacy(role, isSuperAdmin) {
  if (isSuperAdmin === true) return TIER_1;
  if (role === 'admin' || role === 'manager') return TIER_2;
  if (role === 'assistant_manager') return TIER_3;
  return TIER_4;
}

/**
 * Resolve the user's effective tier. Prefers `user.tier` when valid, falls
 * back to legacy fields (works during the migration window before the
 * tier column is populated for everyone).
 */
export function resolveTier(user) {
  if (!user) return TIER_4;
  if (isValidTier(user.tier)) return user.tier;
  return tierFromLegacy(user.role, user.isSuperAdmin);
}

export function isTier1(user) { return resolveTier(user) === TIER_1; }
export function isTier2(user) { return resolveTier(user) === TIER_2; }
export function isTier3(user) { return resolveTier(user) === TIER_3; }
export function isTier4(user) { return resolveTier(user) === TIER_4; }

/**
 * "Does this user have at least the given tier?" Useful for visibility:
 *   hasTierAtLeast(user, 2) → true for Tier 1 and Tier 2.
 */
export function hasTierAtLeast(user, requiredTier) {
  if (!isValidTier(requiredTier)) return false;
  return resolveTier(user) <= requiredTier;
}

/**
 * Display label for a tier value. Used for badges, dropdowns, headers.
 * Returns "Tier N" — never an old role name.
 */
export function tierLabel(tier) {
  return TIER_LABELS[tier] || `Tier ${tier}`;
}

/**
 * Default options for the tier dropdown shown to admins on user-management
 * forms. The actor's own tier limits which tiers they may grant:
 *   - Tier 1 actor: any tier 1..4
 *   - Tier 2 actor: tier 3 or tier 4 only
 *   - Tier 3/4 actor: nothing (this list is empty)
 */
export function tiersGrantableBy(actor) {
  const t = resolveTier(actor);
  if (t === TIER_1) {
    return [TIER_1, TIER_2, TIER_3, TIER_4].map(v => ({ value: v, label: tierLabel(v) }));
  }
  if (t === TIER_2) {
    return [TIER_3, TIER_4].map(v => ({ value: v, label: tierLabel(v) }));
  }
  return [];
}
