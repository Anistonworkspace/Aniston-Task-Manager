/**
 * Run migration 013: Per-user font_size_preference column on users.
 * Usage: node server/migrations/run_013.js
 */
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../config/db');

async function run() {
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '013_add_user_font_size_preference.sql'),
      'utf8'
    );

    // The CHECK constraint lives inside a DO $$ ... $$ block, which contains
    // semicolons we MUST NOT split on. Run the file as one statement; postgres
    // handles multi-statement scripts fine when sent through a single query.
    await sequelize.query(sql);
    console.log('[OK] users.font_size_preference column + CHECK constraint ensured.');

    console.log('\nMigration 013 complete.');
    process.exit(0);
  } catch (err) {
    if (err.message?.includes('already exists') || err.message?.includes('duplicate')) {
      console.log('[SKIP] column/constraint already present.');
      process.exit(0);
    }
    console.error('Migration 013 failed:', err);
    process.exit(1);
  }
}

run();
