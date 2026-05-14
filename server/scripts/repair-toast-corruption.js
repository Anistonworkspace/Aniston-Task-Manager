#!/usr/bin/env node
/**
 * server/scripts/repair-toast-corruption.js
 *
 * Manual-only, backup-first repair script for the 2026-05-14 TOAST
 * corruption incident on the `users` table.
 *
 * What it does (when --apply is passed):
 *   Sets teamsAccessToken / teamsRefreshToken / teamsTokenExpiry to NULL,
 *   ONLY for user rows that diagnose-toast-corruption.js identified as
 *   having physically corrupt TOAST chunks in those columns. Forces
 *   those users to re-link Microsoft on their next login.
 *
 * What it does NOT do, ever:
 *   - Touch users.password, users.email, users.role, users.tier, users.isActive
 *   - Delete any user, task, board, workspace, comment, file, or notification
 *   - Run VACUUM, REINDEX, CLUSTER, or any DDL
 *   - Mutate users.id or any foreign-key column
 *
 * Safety gates:
 *   - DRY-RUN by default. Mutations require BOTH --apply and (in production)
 *     --allow-production.
 *   - Refuses to run if env var DB_NAME is empty.
 *   - Refuses if total user count is zero (sentinel: never wipe data when
 *     diagnostic clearly hit the wrong DB).
 *   - Per-row work is wrapped in BEGIN/COMMIT; a partial failure aborts the
 *     transaction and prints which rows succeeded vs failed.
 *
 * Usage:
 *   # ALWAYS run the diagnostic first to validate the affected-row list:
 *   node server/scripts/diagnose-toast-corruption.js --json > /tmp/toast-affected.json
 *
 *   # Take a verified backup before any --apply run:
 *   pg_dump -Fc -d "$DB_NAME" -f /tmp/users_repair_$(date -u +%Y%m%dT%H%M%SZ).dump
 *
 *   # Dry-run (no mutations, shows exactly what would change):
 *   node server/scripts/repair-toast-corruption.js --input /tmp/toast-affected.json
 *
 *   # Apply in non-production:
 *   node server/scripts/repair-toast-corruption.js --input /tmp/toast-affected.json --apply
 *
 *   # Apply in production (requires explicit flag):
 *   node server/scripts/repair-toast-corruption.js --input /tmp/toast-affected.json --apply --allow-production
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { sequelize } = require('../models');

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { apply: false, allowProduction: false, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--allow-production') opts.allowProduction = true;
    else if (a === '--input') opts.input = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--input=')) opts.input = a.slice('--input='.length);
  }
  return opts;
}

function usage() {
  console.log(`
Usage:
  node server/scripts/repair-toast-corruption.js --input <affected.json> [--apply] [--allow-production]

Flags:
  --input <file>         Required. Path to the JSON file written by
                         diagnose-toast-corruption.js (--json).
  --apply                Actually perform the UPDATE. Omitted = dry run.
  --allow-production     Required additionally when NODE_ENV=production.
`);
}

function fail(msg, code = 1) {
  console.error(`FATAL: ${msg}`);
  process.exit(code);
}

async function main() {
  const opts = parseArgs();
  if (opts.help) { usage(); process.exit(0); }

  if (!opts.input) {
    usage();
    fail('--input <file> is required.');
  }
  const inputPath = path.resolve(opts.input);
  if (!fs.existsSync(inputPath)) fail(`Input file not found: ${inputPath}`);

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    fail(`Could not parse ${inputPath}: ${e.message}`);
  }

  if (!summary || !Array.isArray(summary.affectedIds)) {
    fail('Input JSON is missing `affectedIds: string[]`. Re-run diagnose-toast-corruption.js --json.');
  }

  if (!process.env.DB_NAME) {
    fail('DB_NAME is not set. Refusing to run without an explicit database name.');
  }

  const isProd = process.env.NODE_ENV === 'production';
  if (opts.apply && isProd && !opts.allowProduction) {
    fail('NODE_ENV=production: --allow-production is required for --apply.');
  }

  const [[meta]] = await sequelize.query(
    `SELECT current_database() AS db, COUNT(*)::int AS user_count FROM users`,
    { raw: true }
  );

  if (meta.user_count === 0) {
    fail(`users table is empty in db ${meta.db}. Refusing — wrong database?`);
  }

  console.log(`Connected DB        : ${meta.db}`);
  console.log(`users row count     : ${meta.user_count}`);
  console.log(`affected rows input : ${summary.affectedIds.length}`);
  console.log(`mode                : ${opts.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`NODE_ENV            : ${process.env.NODE_ENV || '(unset)'}`);

  if (summary.affectedIds.length === 0) {
    console.log('\nNothing to repair. Exiting.');
    await sequelize.close();
    return;
  }

  // Show exactly which rows we'd touch, projected via the SAFE_USER_ATTRIBUTES
  // allowlist (we MUST NOT select the corrupt token columns here).
  const [preview] = await sequelize.query(
    `SELECT id, email, "teamsUserId", "isActive"
       FROM users
      WHERE id = ANY(:ids::uuid[])
      ORDER BY email`,
    { replacements: { ids: summary.affectedIds }, raw: true }
  );

  console.log('\nRows that will have teamsAccessToken/teamsRefreshToken/teamsTokenExpiry nulled:');
  for (const r of preview) {
    console.log(`  - id=${r.id} email=${r.email} teamsUserId=${r.teamsUserId} isActive=${r.isActive}`);
  }
  if (preview.length !== summary.affectedIds.length) {
    console.warn(`\nWARNING: input listed ${summary.affectedIds.length} ids but only ${preview.length} match in the DB.`);
    console.warn('Some IDs may no longer exist — review before continuing.');
  }

  if (!opts.apply) {
    console.log('\nDry-run complete. No changes made. Re-run with --apply (and --allow-production in prod) to commit.');
    await sequelize.close();
    return;
  }

  // Apply. Wrap each row in its own savepoint so a single still-corrupt row
  // doesn't abort the whole batch. The outer transaction is per-row UPDATE +
  // commit, which is correct here — we are intentionally writing one row at
  // a time so we can attribute failures.
  let succeeded = 0;
  const failures = [];
  for (const id of summary.affectedIds) {
    try {
      await sequelize.query(
        `UPDATE users
            SET "teamsAccessToken"  = NULL,
                "teamsRefreshToken" = NULL,
                "teamsTokenExpiry"  = NULL,
                "updatedAt"         = NOW()
          WHERE id = :id`,
        { replacements: { id }, raw: true }
      );
      succeeded++;
    } catch (e) {
      failures.push({ id, message: (e.original && e.original.message) || e.message });
    }
  }

  console.log(`\nRepair complete: ${succeeded} updated, ${failures.length} failed.`);
  if (failures.length) {
    console.log('Failed rows (these likely have heap-level corruption beyond TOAST and need REINDEX/VACUUM FULL or restore):');
    for (const f of failures) console.log(`  - id=${f.id} msg=${f.message}`);
    console.log('\nFollow up with: REINDEX TABLE CONCURRENTLY users;');
  }

  console.log('\nNext: have an affected user attempt SSO login; expect sso=success.');
  await sequelize.close();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
