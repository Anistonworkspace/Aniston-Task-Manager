/**
 * Planner Access Service — authorization for viewing / managing another
 * user's Time Planner.
 *
 * The Time Planner is more sensitive than ordinary task data because it
 * overlays each user's Microsoft 365 calendar. So — unlike taskVisibility,
 * where Tier 2 is treated as unrestricted — here ONLY Tier 1 (super admin)
 * sees everyone. Every other actor is limited to:
 *
 *   1. themselves (always),
 *   2. their reporting subtree (hierarchyService.isDescendantOf — covers
 *      "Tier 2 manages the Tier 3/Tier 4 under them", "Tier 3 manages their
 *      reports"),
 *   3. any owner they hold an explicit, per-owner PermissionGrant for
 *      (resourceId = ownerUserId). This is the controlled-delegation path:
 *      a Tier 1 grants `time_plan.edit_team` (manage) or `time_plan.view_all`
 *      (read) for a SPECIFIC owner — e.g. making a Tier 2 the personal
 *      assistant for one Tier 1, without opening up every Tier 1 planner.
 *
 * View is implied by manage, so an `edit_team` grant also confers view.
 */

const hierarchyService = require('./hierarchyService');
const permissionEngine = require('./permissionEngine');
const { resolveTier, TIER_1 } = require('../config/tiers');

function isUnrestricted(actor) {
  return !!actor && (actor.isSuperAdmin === true || resolveTier(actor) === TIER_1);
}

/**
 * Can `actor` READ `targetUserId`'s planner (blocks + calendar)?
 * @returns {Promise<boolean>}
 */
async function canViewPlanner(actor, targetUserId) {
  if (!actor || !targetUserId) return false;
  if (String(actor.id) === String(targetUserId)) return true;
  if (isUnrestricted(actor)) return true;
  if (await hierarchyService.isDescendantOf(targetUserId, actor.id)) return true;
  // Explicit per-owner delegation. edit_team (manage) implies view.
  if (await permissionEngine.hasPermission(actor, 'time_plan', 'view_all', targetUserId)) return true;
  if (await permissionEngine.hasPermission(actor, 'time_plan', 'edit_team', targetUserId)) return true;
  return false;
}

/**
 * Can `actor` CREATE / EDIT / DELETE blocks on `targetUserId`'s planner?
 * @returns {Promise<boolean>}
 */
async function canManagePlanner(actor, targetUserId) {
  if (!actor || !targetUserId) return false;
  if (String(actor.id) === String(targetUserId)) return true;
  if (isUnrestricted(actor)) return true;
  if (await hierarchyService.isDescendantOf(targetUserId, actor.id)) return true;
  if (await permissionEngine.hasPermission(actor, 'time_plan', 'edit_team', targetUserId)) return true;
  return false;
}

/**
 * The set of user IDs whose planners `actor` may VIEW, for filtering the
 * team-overview query. Returns `null` to mean "unrestricted" (Tier 1) so the
 * caller can skip the IN-filter entirely.
 * @returns {Promise<string[]|null>}
 */
async function visiblePlannerUserIds(actor) {
  if (!actor) return [];
  if (isUnrestricted(actor)) return null;
  const set = new Set([String(actor.id)]);
  try {
    const descendants = await hierarchyService.getDescendantIds(actor.id);
    descendants.forEach((id) => set.add(String(id)));
  } catch (e) {
    // hierarchy table absent / transient — fall through with self only.
  }
  // Add explicitly-delegated owners (per-owner grants with a resourceId).
  try {
    const grants = await permissionEngine.fetchActiveGrants(actor.id);
    grants.forEach((g) => {
      if (
        g.resourceType === 'time_plan'
        && ['view_all', 'edit_team'].includes(g.action)
        && g.effect !== 'deny'
        && g.resourceId
      ) {
        set.add(String(g.resourceId));
      }
    });
  } catch (e) {
    // grant table absent — ignore.
  }
  return Array.from(set);
}

/**
 * The set of user IDs whose planners `actor` may MANAGE (create/edit/delete).
 * Returns `null` for unrestricted (Tier 1). Like visiblePlannerUserIds but
 * only counts subtree + `edit_team` delegations (NOT view-only `view_all`).
 * @returns {Promise<string[]|null>}
 */
async function manageablePlannerUserIds(actor) {
  if (!actor) return [];
  if (isUnrestricted(actor)) return null;
  const set = new Set([String(actor.id)]);
  try {
    const descendants = await hierarchyService.getDescendantIds(actor.id);
    descendants.forEach((id) => set.add(String(id)));
  } catch (e) { /* hierarchy absent */ }
  try {
    const grants = await permissionEngine.fetchActiveGrants(actor.id);
    grants.forEach((g) => {
      if (g.resourceType === 'time_plan' && g.action === 'edit_team' && g.effect !== 'deny' && g.resourceId) {
        set.add(String(g.resourceId));
      }
    });
  } catch (e) { /* grant table absent */ }
  return Array.from(set);
}

module.exports = {
  isUnrestricted,
  canViewPlanner,
  canManagePlanner,
  visiblePlannerUserIds,
  manageablePlannerUserIds,
};
