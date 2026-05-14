#!/usr/bin/env node
/**
 * server/scripts/diagnose-toast-corruption.js
 *
 * READ-ONLY diagnostic. Identifies users.* rows whose out-of-line (TOAST)
 * columns are physically corrupt at the heap level — the
 *   "unexpected chunk number N (expected M) for toast value V in pg_toast_XXXXX"
 * and "attempted to delete invisible tuple" errors observed on 2026-05-14.
 *
 * Strategy:
 *   1. Resolve the TOAST table OID backing `users` and the baseline row count.
 *   2. Force a per-row read of each suspect column (teamsAccessToken,
 *      teamsRefreshToken, avatar, passwordResetToken). A bad TOAST chunk only
 *      fails when its column is actually fetched, so we test columns
 *      independently to avoid one bad column masking another.
 *   3. Print a per-column affected-row list (id + email).
 *
 * This script does NOT write to any table, run VACUUM, REINDEX, or transactions
 * with any locks beyond SELECT. Safe to run any time, including against
 * production. Pair with repair-toast-corruption.js once results are reviewed.
 *
 * Usage (from inside the backend Docker container, or on the EC2 host with
 * DB_* env vars set):
 *
 *   node server/scripts/diagnose-toast-corruption.js
 *   node server/scripts/diagnose-toast-corruption.js --json > toast-affected.json
 */

'use strict';

const { sequelize } = require('../models');

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');

const TOKEN_COLUMNS = [
  // (column name, label). All TEXT/large-STRING columns on `users` that are
  // candidates for TOAST storage.
  ['teamsAccessToken', 'teamsAccessToken'],
  ['teamsRefreshToken', 'teamsRefreshToken'],
  ['avatar', 'avatar'],
  ['password_reset_token', 'passwordResetToken'],
];

function log(...a) { if (!asJson) console.log(...a); }
function err(...a) { console.error(...a); }

async function main() {
  // 1) Confirm DB + TOAST mapping.
  const [[meta]] = await sequelize.query(
    `SELECT current_database() AS db,
            c.oid              AS rel_oid,
            c.reltoastrelid    AS toast_oid,
            t.relname          AS toast_name
       FROM pg_class c
       LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
      WHERE c.relname = 'users'`,
    { raw: true }
  );

  if (!meta) {
    err('ERROR: users table not found.');
    process.exit(2);
  }

  log(`DB              : ${meta.db}`);
  log(`users OID       : ${meta.rel_oid}`);
  log(`TOAST table     : ${meta.toast_name || '(none — no TOAST candidates yet)'}`);

  const [[counts]] = await sequelize.query(
    `SELECT COUNT(*)::int                                                  AS total,
            COUNT(*) FILTER (WHERE "teamsUserId" IS NOT NULL)::int         AS linked,
            COUNT(*) FILTER (WHERE "teamsAccessToken" IS NOT NULL)::int    AS has_atk,
            COUNT(*) FILTER (WHERE "teamsRefreshToken" IS NOT NULL)::int   AS has_rtk,
            COUNT(*) FILTER (WHERE "isActive")::int                        AS active
       FROM users`,
    { raw: true }
  );

  log('');
  log(`users total            : ${counts.total}`);
  log(`linked to Microsoft    : ${counts.linked}`);
  log(`has teamsAccessToken   : ${counts.has_atk}`);
  log(`has teamsRefreshToken  : ${counts.has_rtk}`);
  log(`active                 : ${counts.active}`);
  log('');

  // 2) Per-column probe. We use a parameterised, single-row SELECT per user so
  // each fetch fails or succeeds independently.
  const [rows] = await sequelize.query(
    `SELECT id, email FROM users ORDER BY "createdAt" ASC`,
    { raw: true }
  );

  const affected = {}; // { [columnLabel]: [{ id, email, sqlstate, message }] }
  for (const [, label] of TOKEN_COLUMNS) affected[label] = [];

  log('Probing TOAST-eligible columns row-by-row...');
  let progressEvery = Math.max(1, Math.floor(rows.length / 20));

  for (let i = 0; i < rows.length; i++) {
    const u = rows[i];
    for (const [col, label] of TOKEN_COLUMNS) {
      try {
        // length() forces actual de-TOASTing of the cell.
        await sequelize.query(
          `SELECT length("${col}") FROM users WHERE id = :id`,
          { replacements: { id: u.id }, raw: true }
        );
      } catch (e) {
        affected[label].push({
          id: u.id,
          email: u.email,
          sqlstate: e.original && e.original.code,
          message: (e.original && e.original.message) || e.message,
        });
      }
    }
    if (!asJson && (i + 1) % progressEvery === 0) {
      log(`  ...checked ${i + 1} / ${rows.length}`);
    }
  }

  log('');
  log('=== AFFECTED ROWS BY COLUMN ===');
  for (const [, label] of TOKEN_COLUMNS) {
    const list = affected[label];
    log(`\n[${label}] corrupt rows: ${list.length}`);
    for (const row of list) {
      log(`  - id=${row.id} email=${row.email} sqlstate=${row.sqlstate} msg=${row.message}`);
    }
  }

  const allAffectedIds = new Set();
  for (const [, label] of TOKEN_COLUMNS) for (const r of affected[label]) allAffectedIds.add(r.id);

  log('');
  log(`Unique affected user IDs: ${allAffectedIds.size}`);

  const summary = {
    db: meta.db,
    toastTable: meta.toast_name,
    counts,
    totalAffected: allAffectedIds.size,
    affectedIds: [...allAffectedIds],
    byColumn: affected,
    generatedAt: new Date().toISOString(),
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    log('');
    log('Next steps:');
    log('  1. Take a backup:  pg_dump -Fc -f /tmp/users_repair_$(date -u +%Y%m%dT%H%M%SZ).dump');
    log('  2. Review the affected-row list above with your DBA.');
    log('  3. Run:  node server/scripts/repair-toast-corruption.js   (dry-run)');
    log('  4. If the dry-run report is correct, re-run with --apply --allow-production.');
  }

  await sequelize.close();
}

main().catch((e) => {
  err('FATAL:', e.message);
  err(e.stack);
  process.exit(1);
});
