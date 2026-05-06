/**
 * Run migration 014: Add users.tier column + CHECK + index, backfill from
 * legacy (role, isSuperAdmin). Additive and idempotent.
 *
 * Usage:
 *   node server/migrations/run_014.js
 *
 * Recommended pre-check first (read-only, prints distribution):
 *   psql -U postgres -d aniston_project_hub -f server/migrations/014_pre_check.sql
 *
 * Rollback:
 *   psql -U postgres -d aniston_project_hub -f server/migrations/014_add_user_tier_rollback.sql
 */
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../config/db');

async function run() {
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '014_add_user_tier.sql'),
      'utf8'
    );

    // The migration contains a DO $$ ... $$ block whose semicolons must NOT
    // be split. Postgres handles multi-statement scripts fine when sent as a
    // single query, matching the pattern used by run_013.
    await sequelize.query(sql);
    console.log('[OK] users.tier column + CHECK + index ensured; backfill applied.');

    // Sanity report: print the resulting distribution so the operator can
    // visually confirm the backfill worked. Read-only.
    const [rows] = await sequelize.query(
      'SELECT tier, COUNT(*)::int AS user_count FROM users GROUP BY tier ORDER BY tier;'
    );
    console.log('\n[Tier distribution after migration]');
    for (const r of rows) {
      console.log(`  Tier ${r.tier}: ${r.user_count} user(s)`);
    }

    console.log('\nMigration 014 complete.');
    process.exit(0);
  } catch (err) {
    if (err.message?.includes('already exists') || err.message?.includes('duplicate')) {
      console.log('[SKIP] tier column / constraint / index already present.');
      process.exit(0);
    }
    console.error('Migration 014 failed:', err);
    process.exit(1);
  }
}

run();
