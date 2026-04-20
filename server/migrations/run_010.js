/**
 * Run migration 010: Task calendar sync tracking columns
 * Usage: node server/migrations/run_010.js
 */
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../config/db');

async function run() {
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '010_add_task_calendar_sync_fields.sql'),
      'utf8'
    );
    // Strip full-line comments before splitting so a leading comment block
    // doesn't swallow the first statement (the pattern used by run_008.js).
    const stripped = sql
      .split(/\r?\n/)
      .filter(line => !/^\s*--/.test(line))
      .join('\n');
    const statements = stripped
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const stmt of statements) {
      try {
        await sequelize.query(stmt);
        console.log('[OK]', stmt.substring(0, 80) + (stmt.length > 80 ? '...' : ''));
      } catch (err) {
        if (err.message.includes('already exists') || err.message.includes('duplicate')) {
          console.log('[SKIP]', stmt.substring(0, 80), '(already exists)');
        } else {
          console.error('[WARN]', stmt.substring(0, 80), '-', err.message);
        }
      }
    }
    console.log('\nMigration 010 complete.');
    process.exit(0);
  } catch (err) {
    console.error('Migration 010 failed:', err);
    process.exit(1);
  }
}

run();
