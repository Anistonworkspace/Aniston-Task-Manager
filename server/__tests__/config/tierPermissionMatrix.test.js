'use strict';

/**
 * Verification suite for the tier-keyed permission matrix
 * (server/config/permissionMatrix.js -> TIER_PERMISSIONS).
 *
 * These tests pin down the agreed product rules so we cannot silently drift:
 *   - Tier 1: full access — every action true.
 *   - Tier 2: broad access EXCEPT every `delete` action, plus admin_settings,
 *     integrations, api_keys, archive.manage, notifications.manage.
 *     `tasks.edit_locked_description` is shared with Tier 1 (decision #10
 *     revised — T1+T2 may rewrite an already-set task description).
 *   - Tier 3: subtree-scoped; matrix coarse, controllers enforce scope.
 *     Every destructive `delete` tightened to false except personal data
 *     (notes, time_plan).
 *   - Tier 4: identical to the previous member matrix (preserves existing
 *     behavior); audit-flagged escalation paths fixed in controllers, not here.
 *
 * No DB. No mocks. Pure data assertions.
 */

const {
  RESOURCES,
  RESOURCE_ACTIONS,
  TIER_PERMISSIONS,
  getTierPermissions,
  isTierBasePermission,
  ROLE_PERMISSIONS,
} = require('../../config/permissionMatrix');

const ALL_TIERS = [1, 2, 3, 4];

// ── Structural shape ─────────────────────────────────────────────────────

describe('TIER_PERMISSIONS shape', () => {
  it('contains exactly tiers 1, 2, 3, 4', () => {
    expect(Object.keys(TIER_PERMISSIONS).map(Number).sort()).toEqual([1, 2, 3, 4]);
  });

  it.each(ALL_TIERS)('Tier %i resolves a boolean for every RESOURCE (Phase 7: via umbrella synthesis)', (tier) => {
    // Phase 7 — newly added resources (comments, recurring_work, approvals,
    // calendar, search, backup, system, browser_notifications, task_links,
    // task_references) are not literally in TIER_PERMISSIONS — they're
    // synthesized via getTierPermissions. The test asserts every resource
    // is reachable via the canonical helper, not via direct property access.
    const flat = getTierPermissions(tier);
    for (const resource of Object.keys(RESOURCES)) {
      const someAction = (RESOURCE_ACTIONS[resource] || [])[0];
      if (!someAction) continue;
      const key = `${resource}.${someAction}`;
      expect(flat[key]).toBeDefined();
    }
  });

  it.each(ALL_TIERS)('Tier %i resolves a boolean for every action in RESOURCE_ACTIONS (Phase 7: via umbrella synthesis)', (tier) => {
    // Use direct key access (not toHaveProperty) because keys contain dots
    // which Jest treats as a nested path.
    const flat = getTierPermissions(tier);
    for (const [resource, actions] of Object.entries(RESOURCE_ACTIONS)) {
      for (const action of actions) {
        const key = `${resource}.${action}`;
        expect(flat[key]).toBeDefined();
        expect(typeof flat[key]).toBe('boolean');
      }
    }
  });

  it('does not introduce stray actions beyond RESOURCE_ACTIONS', () => {
    for (const tier of ALL_TIERS) {
      for (const [resource, actions] of Object.entries(TIER_PERMISSIONS[tier])) {
        const allowed = new Set(RESOURCE_ACTIONS[resource] || []);
        for (const action of Object.keys(actions)) {
          expect(allowed.has(action)).toBe(true);
        }
      }
    }
  });
});

// ── Tier 1: full access ──────────────────────────────────────────────────

describe('Tier 1 — full system access', () => {
  it('every declared (resource.action) is true — EXCEPT locked / no_surface system rules', () => {
    // Phase 7 — `locked` actions (e.g. approvals.approve_own) are FALSE for
    // Tier 1 too because they're system rules, not Tier-1 capabilities.
    // `no_surface` (e.g. backup.create) is also FALSE because there is no
    // app feature to enable. Everything else resolves true for Tier 1 via
    // the canonical resolver.
    const { getActionMeta } = require('../../config/permissionMatrix');
    const flat = getTierPermissions(1);
    for (const [resource, actions] of Object.entries(RESOURCE_ACTIONS)) {
      for (const action of actions) {
        const meta = getActionMeta(resource, action);
        const key = `${resource}.${action}`;
        if (meta.enforcement === 'locked' || meta.enforcement === 'no_surface') {
          expect(flat[key]).toBe(false);
        } else {
          expect(flat[key]).toBe(true);
        }
      }
    }
  });

  it('Tier 1 + Tier 2 have tasks.edit_locked_description = true (decision #10 revised)', () => {
    expect(TIER_PERMISSIONS[1].tasks.edit_locked_description).toBe(true);
    expect(TIER_PERMISSIONS[2].tasks.edit_locked_description).toBe(true);
    expect(TIER_PERMISSIONS[3].tasks.edit_locked_description).toBe(false);
    expect(TIER_PERMISSIONS[4].tasks.edit_locked_description).toBe(false);
  });
});

// ── Tier 2: NO destructive ops anywhere ─────────────────────────────────

describe('Tier 2 — broad management, NO destructive ops (decision #4)', () => {
  // Decision #4 carveouts — documented exceptions to the strict-T2-no-delete
  // rule. Each entry MUST link to the product decision that authorised it.
  // Adding to this list is a deliberate policy change, not a bug fix.
  const TIER_2_DELETE_CARVEOUTS = new Set([
    // labels — May 2026 product decision: managers may curate their team's
    // label library end-to-end, including deletion. Labels are easily-
    // recreatable metadata, not work product. Controller-level
    // `canManageBoard` and `permissionEngine.hasPermission` still gate per
    // request; this carveout only widens the base default.
    'labels',
    // status_templates — Phase 2 product decision (mirrors labels): status
    // tile groups are board-config metadata, not work product. Tasks created
    // from a template snapshot the statuses into their own `statusConfig`
    // JSONB, so deletion never breaks historical tasks. T1/T2 manage the
    // library end-to-end. See server/config/permissionMatrix.js
    // GRANTABILITY block for the matching grantability rule.
    'status_templates',
  ]);

  it('every `delete` action is FALSE across every resource (except documented carveouts)', () => {
    const violations = [];
    for (const [resource, actions] of Object.entries(TIER_PERMISSIONS[2])) {
      if (TIER_2_DELETE_CARVEOUTS.has(resource)) continue;
      if ('delete' in actions && actions.delete !== false) {
        violations.push(`Tier 2 must not have ${resource}.delete = true`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('labels.delete + status_templates.delete are the only T2 destructive carveouts (regression guard)', () => {
    expect(TIER_PERMISSIONS[2].labels.delete).toBe(true);
    expect(TIER_PERMISSIONS[2].status_templates.delete).toBe(true);
    // If you find yourself adding a new entry to TIER_2_DELETE_CARVEOUTS,
    // make sure you've got an explicit product decision recorded.
    expect(TIER_2_DELETE_CARVEOUTS.size).toBe(2);
  });

  it('archive.manage is FALSE (manage = restore + permanent-delete = destructive)', () => {
    expect(TIER_PERMISSIONS[2].archive.manage).toBe(false);
  });

  it('notifications.manage is FALSE (clear-all = destructive)', () => {
    expect(TIER_PERMISSIONS[2].notifications.manage).toBe(false);
  });

  it('admin_settings, integrations, api_keys are Tier 1 only', () => {
    expect(TIER_PERMISSIONS[2].admin_settings.view).toBe(false);
    expect(TIER_PERMISSIONS[2].admin_settings.manage).toBe(false);
    expect(TIER_PERMISSIONS[2].integrations.view).toBe(false);
    expect(TIER_PERMISSIONS[2].integrations.manage).toBe(false);
    expect(TIER_PERMISSIONS[2].api_keys.view).toBe(false);
    expect(TIER_PERMISSIONS[2].api_keys.create).toBe(false);
    expect(TIER_PERMISSIONS[2].api_keys.delete).toBe(false);
    expect(TIER_PERMISSIONS[2].api_keys.manage).toBe(false);
  });

  it('feedback.{view,create,manage} = TRUE (decision #5: T1+T2 access)', () => {
    expect(TIER_PERMISSIONS[2].feedback.view).toBe(true);
    expect(TIER_PERMISSIONS[2].feedback.create).toBe(true);
    expect(TIER_PERMISSIONS[2].feedback.manage).toBe(true);
  });

  it('keeps every non-destructive management action = TRUE', () => {
    // Spot-check the meaningful ones.
    expect(TIER_PERMISSIONS[2].users.create).toBe(true);
    expect(TIER_PERMISSIONS[2].users.edit).toBe(true);
    expect(TIER_PERMISSIONS[2].users.manage).toBe(true);
    expect(TIER_PERMISSIONS[2].workspaces.create).toBe(true);
    expect(TIER_PERMISSIONS[2].workspaces.edit).toBe(true);
    expect(TIER_PERMISSIONS[2].workspaces.manage_members).toBe(true);
    expect(TIER_PERMISSIONS[2].boards.create).toBe(true);
    expect(TIER_PERMISSIONS[2].boards.edit).toBe(true);
    expect(TIER_PERMISSIONS[2].boards.manage_members).toBe(true);
    expect(TIER_PERMISSIONS[2].boards.manage_settings).toBe(true);
    expect(TIER_PERMISSIONS[2].boards.export).toBe(true);
    expect(TIER_PERMISSIONS[2].tasks.create).toBe(true);
    expect(TIER_PERMISSIONS[2].tasks.edit).toBe(true);
    expect(TIER_PERMISSIONS[2].tasks.assign_others).toBe(true);
    expect(TIER_PERMISSIONS[2].tasks.set_priority).toBe(true);
    expect(TIER_PERMISSIONS[2].tasks.approve).toBe(true);
    expect(TIER_PERMISSIONS[2].roles.manage).toBe(true);  // still grants permissions; engine enforces scope
    expect(TIER_PERMISSIONS[2].org_chart.manage).toBe(true);
  });
});

// ── Tier 3: subtree-scoped, no destructive ─────────────────────────────

describe('Tier 3 — subtree-scoped (was assistant_manager)', () => {
  it('admin/system surfaces are denied', () => {
    expect(TIER_PERMISSIONS[3].admin_settings.view).toBe(false);
    expect(TIER_PERMISSIONS[3].admin_settings.manage).toBe(false);
    expect(TIER_PERMISSIONS[3].integrations.view).toBe(false);
    expect(TIER_PERMISSIONS[3].integrations.manage).toBe(false);
    expect(TIER_PERMISSIONS[3].api_keys.view).toBe(false);
    expect(TIER_PERMISSIONS[3].roles.manage).toBe(false);
    expect(TIER_PERMISSIONS[3].archive.view).toBe(false);
    expect(TIER_PERMISSIONS[3].automations.view).toBe(false);
  });

  it('boards.create = true; controllers enforce subtree scope (decision #7)', () => {
    expect(TIER_PERMISSIONS[3].boards.create).toBe(true);
  });

  it('every shared-resource `delete` is FALSE (decision #4 default-deny)', () => {
    expect(TIER_PERMISSIONS[3].tasks.delete).toBe(false);
    expect(TIER_PERMISSIONS[3].subtasks.delete).toBe(false);
    expect(TIER_PERMISSIONS[3].task_comments.delete).toBe(false);
    expect(TIER_PERMISSIONS[3].task_files.delete).toBe(false);
    expect(TIER_PERMISSIONS[3].meetings.delete).toBe(false);
    expect(TIER_PERMISSIONS[3].dependencies.delete).toBe(false);
    expect(TIER_PERMISSIONS[3].boards.delete).toBe(false);
    expect(TIER_PERMISSIONS[3].workspaces.delete).toBe(false);
  });

  it('personal-data delete is preserved for own scratch data', () => {
    // Notes and time blocks are personal — owner-scoped delete is fine.
    expect(TIER_PERMISSIONS[3].notes.delete).toBe(true);
    expect(TIER_PERMISSIONS[3].time_plan.delete).toBe(true);
  });

  it('approve = false (matches prior assistant_manager)', () => {
    expect(TIER_PERMISSIONS[3].tasks.approve).toBe(false);
  });

  it('tasks.edit_locked_description = false (T1+T2-only override)', () => {
    expect(TIER_PERMISSIONS[3].tasks.edit_locked_description).toBe(false);
  });
});

// ── Tier 4: identical to legacy member ─────────────────────────────────

describe('Tier 4 — identical to legacy member matrix', () => {
  it('matches every (resource, action) in ROLE_PERMISSIONS.member', () => {
    const member = ROLE_PERMISSIONS.member;
    const t4 = TIER_PERMISSIONS[4];
    const violations = [];
    for (const [resource, actions] of Object.entries(member)) {
      for (const [action, allowed] of Object.entries(actions)) {
        if (t4[resource]?.[action] !== allowed) {
          violations.push(`T4.${resource}.${action} = ${t4[resource]?.[action]} but member = ${allowed}`);
        }
      }
    }
    // Tier 4 may declare extras (e.g. tasks.edit_locked_description) that
    // member never had — those are checked separately.
    expect(violations).toEqual([]);
  });

  it('tasks.set_priority = false (decision #9)', () => {
    expect(TIER_PERMISSIONS[4].tasks.set_priority).toBe(false);
  });

  it('tasks.assign_others = false', () => {
    expect(TIER_PERMISSIONS[4].tasks.assign_others).toBe(false);
  });

  it('boards.create = true (decision #8: kept; controllers enforce reachability)', () => {
    expect(TIER_PERMISSIONS[4].boards.create).toBe(true);
  });

  it('tasks.edit_locked_description = false', () => {
    expect(TIER_PERMISSIONS[4].tasks.edit_locked_description).toBe(false);
  });

  it('personal-data delete preserved (notes + own time blocks)', () => {
    expect(TIER_PERMISSIONS[4].notes.delete).toBe(true);
    expect(TIER_PERMISSIONS[4].time_plan.delete).toBe(true);
  });

  it('tasks.delete = false (controller has separate own-task-archive path)', () => {
    expect(TIER_PERMISSIONS[4].tasks.delete).toBe(false);
  });
});

// ── Helpers: getTierPermissions / isTierBasePermission ───────────────────

describe('getTierPermissions', () => {
  it.each(ALL_TIERS)('returns flat "resource.action" map for Tier %i', (tier) => {
    const flat = getTierPermissions(tier);
    expect(flat['tasks.create']).toBe(TIER_PERMISSIONS[tier].tasks.create);
    expect(flat['boards.delete']).toBe(TIER_PERMISSIONS[tier].boards.delete);
  });

  it('falls back to Tier 4 for unknown tiers', () => {
    const flat = getTierPermissions(99);
    expect(flat['tasks.create']).toBe(TIER_PERMISSIONS[4].tasks.create);
  });

  it('every value is a boolean', () => {
    for (const tier of ALL_TIERS) {
      const flat = getTierPermissions(tier);
      for (const [, v] of Object.entries(flat)) {
        expect(typeof v).toBe('boolean');
      }
    }
  });
});

describe('isTierBasePermission', () => {
  it('returns true for Tier 1 on any declared action', () => {
    expect(isTierBasePermission(1, 'workspaces', 'delete')).toBe(true);
    expect(isTierBasePermission(1, 'tasks', 'edit_locked_description')).toBe(true);
  });

  it('returns false for Tier 2 on any delete', () => {
    expect(isTierBasePermission(2, 'tasks', 'delete')).toBe(false);
    expect(isTierBasePermission(2, 'workspaces', 'delete')).toBe(false);
    expect(isTierBasePermission(2, 'boards', 'delete')).toBe(false);
    expect(isTierBasePermission(2, 'users', 'delete')).toBe(false);
    expect(isTierBasePermission(2, 'task_files', 'delete')).toBe(false);
  });

  it('returns false for unknown tier', () => {
    expect(isTierBasePermission(99, 'tasks', 'view')).toBe(false);
  });

  it('returns false for unknown resource or action', () => {
    expect(isTierBasePermission(1, 'nope', 'view')).toBe(false);
    expect(isTierBasePermission(1, 'tasks', 'fly')).toBe(false);
  });
});

// ── Cross-tier sanity: critical security invariants ──────────────────────

describe('cross-tier invariants', () => {
  it('every Tier 1 right is at least equal to every other tier on `delete` actions (T1 has them all)', () => {
    for (const tier of [2, 3, 4]) {
      for (const [resource, actions] of Object.entries(TIER_PERMISSIONS[tier])) {
        if (actions.delete === true) {
          // It's fine for lower tiers to have personal-data deletes; just
          // ensure Tier 1 also has them (no permission gap above).
          expect(TIER_PERMISSIONS[1][resource].delete).toBe(true);
        }
      }
    }
  });

  it('only Tier 1 + Tier 2 have tasks.edit_locked_description = true', () => {
    const granted = ALL_TIERS.filter(t => TIER_PERMISSIONS[t].tasks.edit_locked_description);
    expect(granted).toEqual([1, 2]);
  });

  it('admin_settings is reachable only by Tier 1', () => {
    expect(ALL_TIERS.filter(t => TIER_PERMISSIONS[t].admin_settings.view)).toEqual([1]);
    expect(ALL_TIERS.filter(t => TIER_PERMISSIONS[t].admin_settings.manage)).toEqual([1]);
  });

  it('integrations is reachable only by Tier 1', () => {
    expect(ALL_TIERS.filter(t => TIER_PERMISSIONS[t].integrations.view)).toEqual([1]);
    expect(ALL_TIERS.filter(t => TIER_PERMISSIONS[t].integrations.manage)).toEqual([1]);
  });

  it('api_keys is reachable only by Tier 1', () => {
    expect(ALL_TIERS.filter(t => TIER_PERMISSIONS[t].api_keys.view)).toEqual([1]);
    expect(ALL_TIERS.filter(t => TIER_PERMISSIONS[t].api_keys.create)).toEqual([1]);
    expect(ALL_TIERS.filter(t => TIER_PERMISSIONS[t].api_keys.manage)).toEqual([1]);
  });

  it('archive.manage is Tier 1 only', () => {
    expect(ALL_TIERS.filter(t => TIER_PERMISSIONS[t].archive.manage)).toEqual([1]);
  });

  it('Tier 2 is a NON-DELETE superset of Tier 4 on shared resources', () => {
    // For every (resource, non-delete action) where Tier 4 has true, Tier 2
    // must also have true. This catches accidental tightenings of T2 below T4.
    for (const [resource, actions] of Object.entries(TIER_PERMISSIONS[4])) {
      for (const [action, allowed] of Object.entries(actions)) {
        if (action === 'delete') continue;
        if (allowed === true) {
          // The few admin-system surfaces are intentionally T1-only and T4
          // already has them false, so this loop body never fires for them.
          expect(TIER_PERMISSIONS[2][resource][action]).toBe(true);
        }
      }
    }
  });
});

// ── Label hygiene: matrix must NOT leak old role names anywhere ─────────

describe('label hygiene', () => {
  it('TIER_PERMISSIONS keys are numeric tier IDs only — no role-name strings', () => {
    const keys = Object.keys(TIER_PERMISSIONS);
    for (const k of keys) {
      expect(['1', '2', '3', '4']).toContain(k);
    }
  });
});
