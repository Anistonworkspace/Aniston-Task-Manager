'use strict';

/**
 * Centralized destructive-action gate (Phase 5a).
 *
 * THE single source of truth for "may this user perform a destructive
 * operation on this resource kind?" Used as a defense-in-depth check
 * AFTER the route guard / matrix permission, immediately BEFORE the
 * actual mutation in the controller.
 *
 * The PRIMARY job is to enforce decision #4 GLOBALLY:
 *   Tier 2 must not delete / archive / soft-delete / bulk-remove ANYTHING.
 *
 * Even if a PermissionGrant or a legacy code path would otherwise let a
 * Tier-2 user through, this function blocks them. Phase 5d wires it into
 * every controller that performs a destructive op; Phase 5a (this phase)
 * exposes it for that work plus unit tests.
 *
 * Tier semantics:
 *   Tier 1 → may delete anything.
 *   Tier 2 → NEVER. (Hard rule, no override.)
 *   Tier 3 → personal-data resources only, AND only when the controller
 *            has verified ownership (`isOwnResource: true`). Shared
 *            resources are not granted by this gate — for those, Tier 3
 *            relies on either the matrix (mostly false) or a separate
 *            controller-level own-resource check.
 *   Tier 4 → same as Tier 3.
 *
 * "Personal data" = data that belongs to a single user and has no shared
 * organizational meaning. Today that is notes, time-blocks, and own
 * notifications. Anything that affects shared org state (workspaces,
 * boards, groups, tasks, files, comments, users, …) is shared.
 *
 * IMPORTANT: this function is NOT the gate for the existing
 * "member archives own task" workflow. That path is governed by the
 * controller's own ownership check (taskController) so Tier 4 keeps its
 * current behavior (decision: do not silently break member workflow).
 * Controllers handling the member-archive-own-task path should NOT call
 * `assertCanDelete` for that operation.
 */

const {
  resolveTier,
  TIER_1,
  TIER_2,
  TierError,
} = require('../config/tiers');

// Resources whose deletion is purely a personal-scratch operation. Each
// row is owned by one user and has no shared organizational visibility,
// so deleting one does not affect anyone else.
const PERSONAL_KINDS = new Set([
  'note',
  'time_block',
  'notification',
]);

// Every resource kind we expect controllers to pass. Any kind not in this
// set OR PERSONAL_KINDS is treated as unknown and DENIED for T3/T4 (fail
// safe). T2 is denied regardless. T1 is allowed regardless (it's full
// access — unknown kinds reach this gate only if someone added a new
// resource without updating this list, in which case T1 still proceeds).
const SHARED_KINDS = new Set([
  'user',
  'workspace',
  'board',
  'group',
  'task',
  'subtask',
  'file',
  'comment',
  'meeting',
  'announcement',
  'label',
  'automation',
  'department',
  'permission_grant',
  'access_request',
  'api_key',
  'recurring_template',
  'help_request',
  'due_date_extension',
  'dependency',
  'workspace_member',
  'board_member',
  'webhook',
  'integration_config',
  // Phase 7 — additional shared kinds whose destructive paths are gated
  // through `assertCanDelete`. Each of these had a P0/P1 bypass in the
  // 2026-05-07 audit; adding them here is the prerequisite for the
  // controller-level gate calls.
  'worklog',
  'task_assignee',
  'task_owner',
  'manager_relation',
  'hierarchy_level',
  'feedback',
  'promotion',
  'dependency_request',
  'transcription_provider',
  'ai_provider',
  'ai_config',
  // Phase A (May 2026 RBAC hardening). taskLinkController.deleteLink had
  // no destructive tier gate; this kind is the prerequisite for the
  // controller-level assertCanDelete call. T2 is blocked from deleting
  // task links (decision #4 strict). Own-resource flag still lets T3/T4
  // delete links they themselves created.
  'task_link',
]);

const KNOWN_KINDS = new Set([...PERSONAL_KINDS, ...SHARED_KINDS]);

/**
 * Predicate: may this user perform a destructive op on a resource kind?
 *
 * Tier semantics:
 *   T1 → always allowed
 *   T2 → never allowed (decision #4 strict)
 *   T3 / T4 → allowed when isOwnResource=true and the kind is known.
 *             Caller MUST verify ownership (e.g. row.userId === req.user.id,
 *             or row.createdBy === req.user.id, or board/task creator)
 *             before passing isOwnResource: true.
 *
 * The PERSONAL_KINDS set is retained for documentation / audit but does
 * NOT change behavior at this layer — own-anything is the rule for T3/T4.
 * Privileged controllers that wish to deny T3/T4 even for owned shared
 * resources (e.g. taskController's manager/admin permanent-delete path)
 * pass isOwnResource: false explicitly.
 *
 * @param {object} user
 * @param {string} resourceKind             one of KNOWN_KINDS
 * @param {{isOwnResource?: boolean}} opts  caller MUST set isOwnResource:true
 *                                          when it has verified the actor
 *                                          owns the row being deleted
 * @returns {boolean}
 */
function canDelete(user, resourceKind, { isOwnResource = false } = {}) {
  // Fail-safe: a missing actor never has destructive authority, regardless
  // of any caller-claimed ownership flag.
  if (!user) return false;
  const tier = resolveTier(user);

  if (tier === TIER_1) return true;

  // Decision #4 strict: Tier 2 cannot delete anything, anywhere, ever.
  if (tier === TIER_2) return false;

  // T3 / T4: own resource only — the caller must have already verified
  // ownership and passed isOwnResource:true. Unknown resource kinds fail
  // closed.
  if (!KNOWN_KINDS.has(resourceKind)) return false;
  return isOwnResource === true;
}

/**
 * Throwing form. Returns void on success; throws TierError otherwise.
 * Use immediately before any destructive Sequelize mutation.
 *
 * @param {object} user
 * @param {string} resourceKind
 * @param {{isOwnResource?: boolean}} opts
 */
function assertCanDelete(user, resourceKind, opts = {}) {
  const tier = resolveTier(user);

  // Defensive: unknown resource kind is a programmer error. Surface it
  // loudly in non-production so it's caught in tests; in production we
  // fail closed (return 403) rather than crash.
  if (!KNOWN_KINDS.has(resourceKind)) {
    if (process.env.NODE_ENV !== 'production') {
      throw new TierError(
        `assertCanDelete called with unknown resourceKind="${resourceKind}". ` +
        `Add it to PERSONAL_KINDS or SHARED_KINDS in tierEnforcement.js.`,
        { status: 500, code: 'UNKNOWN_RESOURCE_KIND' }
      );
    }
    // Production fail-closed: deny.
    throw new TierError(
      'You do not have permission to perform this destructive operation.',
      { status: 403, code: 'DELETE_FORBIDDEN' }
    );
  }

  if (canDelete(user, resourceKind, opts)) return;

  const message = tier === TIER_2
    ? `Tier 2 cannot delete ${resourceKind}. Only Tier 1 may perform destructive operations.`
    : `You do not have permission to delete ${resourceKind}.`;
  const code = tier === TIER_2 ? 'TIER_2_NO_DELETE' : 'DELETE_FORBIDDEN';

  throw new TierError(message, { status: 403, code });
}

module.exports = {
  canDelete,
  assertCanDelete,
  PERSONAL_KINDS,
  SHARED_KINDS,
  KNOWN_KINDS,
};
