/**
 * Run migration 016: Per-user language column on users.
 * Usage: node server/migrations/run_016.js
 */
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../config/db');

async function run() {
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '016_add_user_language.sql'),
      'utf8'
    );

    // The CHECK constraint lives inside a DO $$ ... $$ block. Run the file
    // as a single query so postgres handles the statement boundaries itself.
    await sequelize.query(sql);
    console.log('[OK] users.language column + CHECK constraint ensured.');

    console.log('\nMigration 016 complete.');
    process.exit(0);
  } catch (err) {
    if (err.message?.includes('already exists') || err.message?.includes('duplicate')) {
      console.log('[SKIP] column/constraint already present.');
      process.exit(0);
    }
    console.error('Migration 016 failed:', err);
    process.exit(1);
  }
}

run();
