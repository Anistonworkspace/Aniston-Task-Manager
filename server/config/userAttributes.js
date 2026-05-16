'use strict';

/**
 * Centralised User attribute lists used in Sequelize `include` blocks across
 * controllers. Lives in `config/` (not `models/User.js`) so test files that
 * jest.mock('../../models') don't have to redeclare these constants — the
 * controller can pull them straight from this module independent of whether
 * the real User model is loaded.
 *
 * Tier semantics: `tier` is the canonical privilege column (1..4) auto-derived
 * from (isSuperAdmin, role) on every server boot. Frontend `resolveTier()`
 * prefers `tier`, falling back to `(role, isSuperAdmin)` during the migration
 * window. Dropping any of `tier`, `role`, or `isSuperAdmin` from a User pill
 * include makes the frontend mis-label a super admin as Tier 2.
 */

const PILL_ATTRIBUTES = Object.freeze([
  'id',
  'name',
  'email',
  'avatar',
  'role',
  'tier',
  'isSuperAdmin',
]);

module.exports = { PILL_ATTRIBUTES };
