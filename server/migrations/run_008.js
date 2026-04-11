/**
 * Run migration 008: Permission Overrides
 * Usage: node server/migrations/run_008.js
 */
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../config/db');

async function run() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, '008_permission_overrides.sql'), 'utf8');
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      try {
        await sequelize.query(stmt);
        console.log('[OK]', stmt.substring(0, 80) + '...');
      } catch (err) {
        // Ignore "already exists" errors
        if (err.message.includes('already exists') || err.message.includes('duplicate')) {
          console.log('[SKIP]', stmt.substring(0, 80) + '... (already exists)');
        } else {
          console.error('[WARN]', stmt.substring(0, 80), '-', err.message);
        }
      }
    }
    console.log('\nMigration 008 complete.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

run();
