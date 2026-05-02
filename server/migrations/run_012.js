/**
 * Run migration 012: Dependency Request system
 * Usage: node server/migrations/run_012.js
 *
 * Idempotent — safe to invoke repeatedly. Mirrors the boot auto-migration
 * block in server.js so manual runs and fresh-boot installs stay in sync.
 */
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../config/db');

// Split a SQL script on `;` while keeping DO $$ ... END $$ blocks together,
// because those contain internal semicolons that the naive splitter in
// run_010.js would chop in half.
function splitStatements(sql) {
  const stripped = sql
    .split(/\r?\n/)
    .filter(line => !/^\s*--/.test(line))
    .join('\n');

  const statements = [];
  let buffer = '';
  let inDollarBlock = false;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    const next = stripped[i + 1];
    if (ch === '$' && next === '$') {
      buffer += '$$';
      i += 1;
      inDollarBlock = !inDollarBlock;
      continue;
    }
    if (ch === ';' && !inDollarBlock) {
      const stmt = buffer.trim();
      if (stmt.length > 0) statements.push(stmt);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  const tail = buffer.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

async function run() {
  try {
    const sql = fs.readFileSync(
      path.join(__dirname, '012_create_dependency_requests.sql'),
      'utf8'
    );
    const statements = splitStatements(sql);

    for (const stmt of statements) {
      try {
        await sequelize.query(stmt);
        console.log('[OK]', stmt.substring(0, 80) + (stmt.length > 80 ? '...' : ''));
      } catch (err) {
        if (
          err.message.includes('already exists') ||
          err.message.includes('duplicate')
        ) {
          console.log('[SKIP]', stmt.substring(0, 80), '(already exists)');
        } else {
          console.error('[WARN]', stmt.substring(0, 80), '-', err.message);
        }
      }
    }
    console.log('\nMigration 012 complete.');
    process.exit(0);
  } catch (err) {
    console.error('Migration 012 failed:', err);
    process.exit(1);
  }
}

run();
