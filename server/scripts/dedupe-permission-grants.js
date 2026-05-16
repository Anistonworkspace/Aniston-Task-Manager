/* eslint-disable no-console */
/**
 * dedupe-permission-grants.js — Phase A (May 2026 RBAC hardening) helper.
 *
 * Detects duplicate ACTIVE permission_grants rows and either reports them
 * (dry-run, default) or safely deactivates older duplicates (--apply).
 * Use this BEFORE applying migration 017_permission_grants_unique.sql,
 * which adds a partial UNIQUE index that will fail to install if
 * duplicates exist.
 *
 * "Duplicate" definition: two rows where ALL of the following match AND
 * both are isActive=true:
 *   - userId
 *   - resourceType
 *   - resourceId         (NULL counts as matching another NULL)
 *   - action             (NULL counts as matching another NULL)
 *   - effect
 *
 * Strategy:
 *   - Group by the duplicate tuple.
 *   - Keep the NEWEST row in each group (createdAt DESC) — that's the
 *     last update the operator performed, so it's the row the UI shows
 *     after the most recent grant/deny click.
 *   - Soft-deactivate the older siblings: isActive=false, revokedAt=NOW(),
 *     notes appended with an audit trail string. The rows remain in the
 *     table for forensic queries.
 *
 * The script NEVER hard-deletes. Migration 017 will refuse to apply
 * while duplicates remain — running this with --apply is the only path
 * forward and it is itself idempotent.
 *
 * Usage:
 *   node server/scripts/dedupe-permission-grants.js          # dry-run
 *   node server/scripts/dedupe-permission-grants.js --apply  # deactivate
 *   node server/scripts/dedupe-permission-grants.js --verbose
 */

'use strict';

const { sequelize } = require('../config/db');
require('../models');

const apply = process.argv.includes('--apply');
const verbose = process.argv.includes('--verbose');

async function findDuplicateGroups() {
  // We need both the duplicate tuple AND the ordered row ids inside each
  // group so we can keep the newest and deactivate the older ones.
  const [groups] = await sequelize.query(`
    SELECT
      "userId",
      "resourceType",
      COALESCE("resourceId"::text, '<global>') AS "resourceIdLabel",
      COALESCE(action, '<legacy>')              AS "actionLabel",
      effect,
      COUNT(*)                                  AS row_count,
      array_agg(id ORDER BY "createdAt" DESC)   AS ids
    FROM permission_grants
    WHERE "isActive" = true
    GROUP BY "userId", "resourceType",
             COALESCE("resourceId"::text, '<global>'),
             COALESCE(action, '<legacy>'),
             effect
    HAVING COUNT(*) > 1
    ORDER BY row_count DESC, "userId" ASC
  `);
  return groups || [];
}

async function deactivateOlder(groups) {
  let deactivatedCount = 0;
  let groupsHandled = 0;
  // Process each group in its own short transaction so a partial failure
  // doesn't leave the table in a half-cleaned state.
  for (const g of groups) {
    const ids = g.ids;
    if (!Array.isArray(ids) || ids.length < 2) continue;
    const [keep, ...older] = ids; // newest first; deactivate the rest
    const t = await sequelize.transaction();
    try {
      const auditNote = ` [auto-deactivated as duplicate by dedupe-permission-grants on ${new Date().toISOString()}; kept row=${keep}]`;
      const [, meta] = await sequelize.query(
        `UPDATE permission_grants
           SET "isActive" = false,
               "revokedAt" = NOW(),
               notes = COALESCE(notes, '') || :note
         WHERE id IN (:ids) AND "isActive" = true`,
        {
          replacements: { ids: older, note: auditNote },
          transaction: t,
        }
      );
      await t.commit();
      const affected = meta?.rowCount ?? meta?.affectedRows ?? older.length;
      deactivatedCount += affected;
      groupsHandled += 1;
      if (verbose) {
        console.log(
          `  user=${g.userId} resource=${g.resourceType} action=${g.actionLabel} effect=${g.effect}` +
          ` kept=${keep} deactivated=${older.length}`
        );
      }
    } catch (err) {
      await t.rollback();
      console.error(
        `  [error] failed to deactivate duplicates for user=${g.userId} resource=${g.resourceType} action=${g.actionLabel}:`,
        err.message
      );
    }
  }
  return { deactivatedCount, groupsHandled };
}

async function main() {
  console.log('[dedupe-permission-grants] scanning permission_grants for duplicate ACTIVE tuples…');
  const groups = await findDuplicateGroups();

  if (groups.length === 0) {
    console.log('[dedupe-permission-grants] no duplicates found. Safe to apply migration 017.');
    await sequelize.close();
    process.exit(0);
  }

  const totalRowsToDeactivate = groups.reduce((sum, g) => sum + (Number(g.row_count) - 1), 0);
  console.log(
    `[dedupe-permission-grants] found ${groups.length} duplicate group(s) covering ${totalRowsToDeactivate} ` +
    `row(s) to deactivate (newest in each group is kept).`
  );

  if (verbose) {
    for (const g of groups) {
      console.log(
        `  • user=${g.userId} resource=${g.resourceType} ` +
        `resourceId=${g.resourceIdLabel} action=${g.actionLabel} ` +
        `effect=${g.effect} count=${g.row_count}`
      );
    }
  }

  if (!apply) {
    console.log('');
    console.log('[dedupe-permission-grants] dry-run only. Re-run with --apply to deactivate older duplicates.');
    console.log('  This is REVERSIBLE — rows are soft-deactivated (isActive=false), not deleted.');
    await sequelize.close();
    process.exit(0);
  }

  console.log('[dedupe-permission-grants] applying deactivations…');
  const { deactivatedCount, groupsHandled } = await deactivateOlder(groups);
  console.log(
    `[dedupe-permission-grants] done. ${deactivatedCount} row(s) deactivated across ${groupsHandled} group(s).`
  );
  console.log('[dedupe-permission-grants] you can now run migration 017_permission_grants_unique.sql.');
  await sequelize.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[dedupe-permission-grants] unhandled error:', err);
  process.exit(1);
});
