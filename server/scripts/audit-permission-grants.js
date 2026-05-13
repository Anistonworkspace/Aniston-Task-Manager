/* eslint-disable no-console */
/**
 * audit-permission-grants.js — Phase 6 RBAC cleanup utility.
 *
 * Scans the permission_grants table for rows that are stale or invalid
 * against the current canonical catalog (server/config/permissionMatrix.js)
 * and prints a structured report. NEVER deletes data — the only mutating
 * mode (--apply) soft-deactivates rows by setting isActive=false, and even
 * then only with explicit operator opt-in.
 *
 * Categories surfaced:
 *
 *   1. unknown_resource     — resourceType is not in RESOURCES catalog.
 *   2. unknown_action       — action is not in RESOURCE_ACTIONS[resourceType].
 *   3. legacy_no_action     — pre-Phase-5 rows with only permissionLevel and
 *                             no action. Engine still honours them via
 *                             mapLegacyLevelToActions; this surfaces them so
 *                             ops can plan a migration to action-based rows.
 *   4. non_grantable        — (resource, action) was granted but the
 *                             current catalog marks it NON_GRANTABLE
 *                             (e.g. *.delete, archive.manage). The row was
 *                             written under older rules; the engine will
 *                             still honour the deny/grant precedence but
 *                             the override should be reviewed by Tier 1.
 *   5. super_admin_target   — row targets a user with isSuperAdmin=true.
 *                             Super admin always bypasses; the row is
 *                             effectively dead and noise in the table.
 *   6. expired              — expiresAt < now, but isActive is still true.
 *                             Engine ignores them at read time; flagging
 *                             so ops can shrink the table.
 *
 * Usage:
 *
 *   # Default — dry run, print summary only.
 *   node server/scripts/audit-permission-grants.js
 *
 *   # Verbose — also print every flagged row (max 1000 rows).
 *   node server/scripts/audit-permission-grants.js --verbose
 *
 *   # Filter to specific categories.
 *   node server/scripts/audit-permission-grants.js --category=unknown_resource,non_grantable
 *
 *   # Apply — soft-deactivate flagged rows. NEVER deletes. Requires both
 *   # --apply AND --i-understand to land. Always logs before mutating.
 *   node server/scripts/audit-permission-grants.js --apply --i-understand
 *
 * Safety:
 *   - --apply without --i-understand is rejected.
 *   - The categories that --apply touches are limited to:
 *       expired, super_admin_target, unknown_resource, unknown_action
 *     because these are objectively dead. non_grantable and legacy_no_action
 *     are NEVER auto-deactivated — they need a human decision.
 *   - The script transacts each batch and prints the count actually mutated.
 *   - Rows are SOFT-deactivated (isActive=false, revokedAt=now,
 *     revokedBy=null). They remain queryable for audit.
 *
 * Output:
 *   Plain stdout, one line per category with counts + (in verbose mode)
 *   the row UUIDs. No JSON; designed for paste-into-incident-doc.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Op } = require('sequelize');
const { PermissionGrant, User, sequelize } = require('../models');
const {
  RESOURCES,
  RESOURCE_ACTIONS,
  GRANTABILITY,
} = require('../config/permissionMatrix');

// ── CLI flag parsing (tiny, no extra deps) ───────────────────────────────
const args = process.argv.slice(2);
const flags = {
  apply: args.includes('--apply'),
  iUnderstand: args.includes('--i-understand'),
  verbose: args.includes('--verbose') || args.includes('-v'),
  categoryArg: (args.find((a) => a.startsWith('--category=')) || '').split('=')[1] || '',
};
const categoryFilter = flags.categoryArg
  ? new Set(flags.categoryArg.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

// Categories the --apply path is allowed to soft-deactivate. Anything
// outside this set is REPORT-ONLY and requires a human review.
const APPLY_SAFE_CATEGORIES = new Set([
  'expired',
  'super_admin_target',
  'unknown_resource',
  'unknown_action',
]);

function isExpired(row) {
  if (!row.expiresAt) return false;
  return new Date(row.expiresAt).getTime() < Date.now();
}

function isNonGrantable(resource, action) {
  if (!action) return false; // legacy_no_action category covers this
  const g = GRANTABILITY[resource]?.[action];
  if (!g) return true; // unknown pair → treat as non-grantable for safety
  return Array.isArray(g.grantableBy) && g.grantableBy.length === 0;
}

async function main() {
  if (flags.apply && !flags.iUnderstand) {
    console.error(
      '\nRefusing to --apply without --i-understand.\n\n'
      + '  --apply will set isActive=false on rows in these categories only:\n'
      + '  ' + Array.from(APPLY_SAFE_CATEGORIES).join(', ') + '\n\n'
      + '  Run again with both flags:\n'
      + '    node server/scripts/audit-permission-grants.js --apply --i-understand\n'
    );
    process.exitCode = 1;
    return;
  }

  console.log('\n══ Permission Grants Audit ════════════════════════════════');
  console.log(`Mode:           ${flags.apply ? 'APPLY (soft-deactivate)' : 'DRY RUN'}`);
  console.log(`Verbose:        ${flags.verbose}`);
  console.log(`Category filter: ${categoryFilter ? Array.from(categoryFilter).join(',') : 'none (all)'}`);
  console.log('───────────────────────────────────────────────────────────\n');

  // Pull every row (active and inactive) so we can also flag expired+active
  // and super_admin targets. Tag with the target user's isSuperAdmin so we
  // can group accurately without N+1 lookups.
  const rows = await PermissionGrant.findAll({
    include: [{ model: User, as: 'user', attributes: ['id', 'isSuperAdmin'] }],
    raw: true,
    nest: true,
  });

  console.log(`Total rows scanned: ${rows.length}\n`);

  const buckets = {
    unknown_resource: [],
    unknown_action: [],
    legacy_no_action: [],
    non_grantable: [],
    super_admin_target: [],
    expired: [],
  };

  for (const row of rows) {
    // Active-only check for expired and super-admin (we only care about
    // rows that are currently in effect).
    if (row.isActive && row.user?.isSuperAdmin === true) {
      buckets.super_admin_target.push(row);
    }
    if (row.isActive && isExpired(row)) {
      buckets.expired.push(row);
    }
    if (!RESOURCES[row.resourceType]) {
      buckets.unknown_resource.push(row);
      continue; // a row with an unknown resource can't be further classified
    }
    if (!row.action && row.permissionLevel) {
      buckets.legacy_no_action.push(row);
      continue;
    }
    if (row.action && !(RESOURCE_ACTIONS[row.resourceType] || []).includes(row.action)) {
      buckets.unknown_action.push(row);
      continue;
    }
    if (row.action && row.effect === 'grant' && row.isActive && isNonGrantable(row.resourceType, row.action)) {
      buckets.non_grantable.push(row);
    }
  }

  // ── Report ─────────────────────────────────────────────────────────
  const labels = {
    unknown_resource:   'Unknown resource (not in catalog)',
    unknown_action:     'Unknown action for resource',
    legacy_no_action:   'Legacy rows (permissionLevel only, no action)',
    non_grantable:      'GRANTED but no longer grantable per catalog',
    super_admin_target: 'Row targets a super admin (dead row)',
    expired:            'Expired but still active',
  };

  let totalFlagged = 0;
  for (const [key, list] of Object.entries(buckets)) {
    if (categoryFilter && !categoryFilter.has(key)) continue;
    if (list.length === 0) {
      console.log(`✓ ${labels[key].padEnd(50)} 0`);
      continue;
    }
    totalFlagged += list.length;
    const safeFlag = APPLY_SAFE_CATEGORIES.has(key) ? '  (apply-safe)' : '  (review only)';
    console.log(`⚠ ${labels[key].padEnd(50)} ${String(list.length).padStart(4)}${safeFlag}`);
    if (flags.verbose) {
      for (const r of list.slice(0, 1000)) {
        console.log(`    ${r.id}  ${r.resourceType}.${r.action || r.permissionLevel || '<null>'}  effect=${r.effect}  userId=${r.userId}  expiresAt=${r.expiresAt || '-'}`);
      }
      if (list.length > 1000) {
        console.log(`    ... and ${list.length - 1000} more`);
      }
    }
  }

  console.log(`\nFlagged rows total: ${totalFlagged}\n`);

  if (!flags.apply) {
    console.log('Dry run complete. No changes applied.\n');
    console.log('Tip: rerun with --verbose to list every flagged row.\n');
    console.log('Tip: rerun with --apply --i-understand to soft-deactivate apply-safe rows.\n');
    return;
  }

  // ── Apply (soft-deactivate apply-safe categories) ─────────────────
  console.log('Applying soft-deactivation to apply-safe categories...\n');
  let totalMutated = 0;
  for (const key of APPLY_SAFE_CATEGORIES) {
    if (categoryFilter && !categoryFilter.has(key)) continue;
    const list = buckets[key];
    if (!list || list.length === 0) continue;
    const ids = list.map((r) => r.id);
    const t = await sequelize.transaction();
    try {
      const [count] = await PermissionGrant.update(
        { isActive: false, revokedAt: new Date() },
        { where: { id: { [Op.in]: ids } }, transaction: t },
      );
      await t.commit();
      console.log(`  ${labels[key]}: deactivated ${count}/${ids.length}`);
      totalMutated += count;
    } catch (err) {
      await t.rollback();
      console.error(`  ${labels[key]}: FAILED — ${err.message}`);
    }
  }
  console.log(`\nTotal rows deactivated: ${totalMutated}\n`);
  console.log('Categories NOT mutated (review-only):');
  for (const key of Object.keys(buckets)) {
    if (!APPLY_SAFE_CATEGORIES.has(key) && buckets[key].length > 0) {
      console.log(`  - ${labels[key]}: ${buckets[key].length}`);
    }
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error('FATAL', err);
    process.exitCode = 2;
  })
  .finally(async () => {
    try { await sequelize.close(); } catch { /* ignore */ }
  });
