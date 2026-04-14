/**
 * Director Plan & Time Plan Data Cleanup — One-Time Auto-Cleanup Module
 *
 * Safely deletes all records from:
 *   - director_plans  (Director's Daily Plan / Director Dashboard schedule data)
 *   - time_blocks     (Dashboard Time Plan scheduling blocks)
 *
 * These tables are self-contained — no other tables reference them via FK.
 * Deleting their rows does NOT affect tasks, boards, users, dashboards, or any other module.
 *
 * ── AUTOMATIC STARTUP MODE (primary) ──
 * Called from server.js during startup. Uses a DB-based run-once guard:
 *   1. Creates system_flags table if not exists
 *   2. Checks if flag 'cleanup_plan_data_v1' is already completed
 *   3. If completed → silent skip (single SELECT, ~2ms)
 *   4. If not completed → delete data, mark completed
 *   5. If tables already empty → mark completed, skip future checks
 *
 * No env vars required. Fully automatic. Safe on every restart.
 *
 * ── STANDALONE CLI MODE (manual fallback) ──
 *   node cleanup-plan-data.js --dry-run       Preview (safe, no changes)
 *   node cleanup-plan-data.js --execute       Actually delete
 *
 * Production (Docker):
 *   docker exec aph-backend node cleanup-plan-data.js --dry-run
 *   docker exec aph-backend node cleanup-plan-data.js --execute
 */

const { Sequelize } = require('sequelize');

// ── Flag name — bump the version suffix to re-trigger a future cleanup ──
const FLAG_NAME = 'cleanup_plan_data_v1';

// ── Tables to clean ──
const TABLES = ['director_plans', 'time_blocks'];

// ── Helpers ──
function divider() {
  console.log('══════════════════════════════════════════════════════════');
}

async function getCount(seq, table, transaction) {
  const [[row]] = await seq.query(
    `SELECT COUNT(*)::int AS count FROM "${table}"`,
    { transaction }
  );
  return row.count;
}

async function getSampleRows(seq, table, transaction) {
  const [rows] = await seq.query(
    `SELECT * FROM "${table}" ORDER BY "createdAt" DESC LIMIT 5`,
    { transaction }
  );
  return rows;
}

async function tableExists(seq, table, transaction) {
  const [[row]] = await seq.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    { bind: [table], transaction }
  );
  return row.exists;
}

async function ensureSystemFlagsTable(seq) {
  await seq.query(`
    CREATE TABLE IF NOT EXISTS system_flags (
      flag VARCHAR(100) PRIMARY KEY,
      completed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      details JSONB DEFAULT '{}'
    )
  `);
}

async function isFlagCompleted(seq, flag) {
  const [[row]] = await seq.query(
    `SELECT flag, completed_at FROM system_flags WHERE flag = $1`,
    { bind: [flag] }
  );
  return row || null;
}

async function markFlagCompleted(seq, flag, details = {}) {
  await seq.query(
    `INSERT INTO system_flags (flag, completed_at, details)
     VALUES ($1, NOW(), $2)
     ON CONFLICT (flag) DO UPDATE SET completed_at = NOW(), details = $2`,
    { bind: [flag, JSON.stringify(details)] }
  );
}

/**
 * Core cleanup logic — used by both startup and CLI modes.
 *
 * @param {Sequelize} seq  — Sequelize instance (already authenticated)
 * @param {object} opts
 * @param {boolean} opts.execute  — true = delete, false = dry-run
 * @param {string}  opts.mode     — 'cli' or 'startup'
 * @returns {object} { skipped, deleted, error }
 */
async function runCleanup(seq, opts = {}) {
  const execute = opts.execute || false;
  const mode = opts.mode || 'cli';
  const prefix = mode === 'startup' ? '[Cleanup/Startup]' : '[Cleanup]';
  const NODE_ENV = process.env.NODE_ENV || 'production';

  divider();
  console.log('  DIRECTOR PLAN & TIME PLAN DATA CLEANUP');
  divider();
  console.log();
  console.log(`${prefix} Mode        : ${execute ? 'EXECUTE (will delete data)' : 'DRY RUN (no changes)'}`);
  console.log(`${prefix} Trigger     : ${mode === 'startup' ? 'Automatic (DB flag guarded)' : 'Manual CLI'}`);
  console.log(`${prefix} Environment : ${NODE_ENV}`);
  console.log(`${prefix} DB Host     : ${process.env.DB_HOST || 'localhost'}`);
  console.log(`${prefix} DB Name     : ${process.env.DB_NAME || 'aniston_project_hub'}`);
  console.log();

  if (execute && (NODE_ENV === 'production' || (process.env.DB_HOST && process.env.DB_HOST !== 'localhost'))) {
    console.log(`${prefix} *** EXECUTING AGAINST PRODUCTION DATABASE ***`);
    console.log();
  }

  if (!execute) {
    console.log(`${prefix} --- DRY RUN MODE: No data will be modified. ---`);
    console.log();
  }

  const transaction = await seq.transaction();

  try {
    // ── Step 1: Verify tables exist ──
    console.log(`${prefix} [Step 1] Verifying tables exist...`);
    for (const table of TABLES) {
      const exists = await tableExists(seq, table, transaction);
      if (!exists) {
        console.warn(`${prefix} Table "${table}" does not exist. Skipping cleanup.`);
        await transaction.rollback();
        return { skipped: true, reason: `Table ${table} missing` };
      }
      console.log(`${prefix}   [OK] ${table} exists`);
    }
    console.log();

    // ── Step 2: Count records before deletion ──
    console.log(`${prefix} [Step 2] Record counts BEFORE cleanup:`);
    const beforeCounts = {};
    for (const table of TABLES) {
      const count = await getCount(seq, table, transaction);
      beforeCounts[table] = count;
      console.log(`${prefix}   ${table}: ${count} rows`);
    }
    console.log();

    const totalBefore = Object.values(beforeCounts).reduce((a, b) => a + b, 0);
    if (totalBefore === 0) {
      console.log(`${prefix} Both tables are already empty. Nothing to delete.`);
      await transaction.rollback();
      return { skipped: true, reason: 'Tables already empty', beforeCounts };
    }

    // ── Step 3: Show sample data ──
    console.log(`${prefix} [Step 3] Sample records (up to 5 most recent per table):`);
    for (const table of TABLES) {
      if (beforeCounts[table] === 0) {
        console.log(`${prefix}   [${table}] (empty)`);
        continue;
      }
      console.log(`${prefix}   [${table}]`);
      const samples = await getSampleRows(seq, table, transaction);
      for (const row of samples) {
        if (table === 'director_plans') {
          const catCount = Array.isArray(row.categories) ? row.categories.length : 0;
          const taskCount = Array.isArray(row.categories)
            ? row.categories.reduce((sum, c) => sum + (c.tasks?.length || 0), 0)
            : 0;
          console.log(`${prefix}     - id=${row.id}, date=${row.date}, directorId=${row.directorId}, categories=${catCount}, tasks=${taskCount}`);
        } else if (table === 'time_blocks') {
          console.log(`${prefix}     - id=${row.id}, date=${row.date}, userId=${row.userId}, ${row.startTime}-${row.endTime}, desc="${row.description || ''}"`);
        }
      }
    }
    console.log();

    // ── Step 4: Delete or skip ──
    if (!execute) {
      console.log(`${prefix} [Step 4] DRY RUN — Skipping deletion.`);
      console.log(`${prefix}   Would delete: ${beforeCounts.director_plans} director_plans + ${beforeCounts.time_blocks} time_blocks`);
      await transaction.rollback();
      divider();
      console.log('  DRY RUN COMPLETE — No data was modified.');
      divider();
      return { skipped: false, dryRun: true, beforeCounts };
    }

    console.log(`${prefix} [Step 4] Deleting records...`);
    const deletedCounts = {};
    for (const table of TABLES) {
      const [, meta] = await seq.query(
        `DELETE FROM "${table}"`,
        { transaction }
      );
      deletedCounts[table] = meta.rowCount || beforeCounts[table];
      console.log(`${prefix}   [DELETED] ${table}: ${deletedCounts[table]} rows removed`);
    }
    console.log();

    // ── Step 5: Verify after deletion ──
    console.log(`${prefix} [Step 5] Record counts AFTER cleanup:`);
    for (const table of TABLES) {
      const count = await getCount(seq, table, transaction);
      console.log(`${prefix}   ${table}: ${count} rows`);
      if (count !== 0) {
        console.error(`${prefix}   [WARNING] ${table} still has ${count} rows — something went wrong.`);
      }
    }
    console.log();

    await transaction.commit();

    divider();
    console.log('  CLEANUP COMPLETE — Director Plan & Time Plan data deleted.');
    divider();

    return { skipped: false, deleted: true, deletedCounts };

  } catch (err) {
    console.error(`\n${prefix} Unexpected error during cleanup:`, err.message);
    console.error(`${prefix} Rolling back transaction — no data was modified.`);
    try { await transaction.rollback(); } catch (_) { /* already rolled back */ }
    return { skipped: false, error: err.message };
  }
}

/**
 * Automatic one-time cleanup on server startup.
 * Uses system_flags DB table as a persistent run-once guard.
 * No env vars required.
 *
 * @param {Sequelize} seq — Sequelize instance (already connected)
 */
async function runStartupCleanup(seq) {
  try {
    // Ensure the guard table exists
    await ensureSystemFlagsTable(seq);

    // Check if this cleanup has already been completed
    const existing = await isFlagCompleted(seq, FLAG_NAME);
    if (existing) {
      // Already ran — silent skip, no log noise on normal restarts
      return;
    }

    console.log(`\n[Cleanup/Startup] One-time cleanup "${FLAG_NAME}" has not run yet. Starting...`);

    const result = await runCleanup(seq, { execute: true, mode: 'startup' });

    if (result.error) {
      console.error(`[Cleanup/Startup] Cleanup failed: ${result.error}`);
      console.error('[Cleanup/Startup] Will retry on next restart.\n');
      return;
    }

    // Mark completed — whether data was deleted or tables were already empty
    const details = result.skipped
      ? { status: 'skipped', reason: result.reason }
      : { status: 'deleted', counts: result.deletedCounts };

    await markFlagCompleted(seq, FLAG_NAME, details);
    console.log(`[Cleanup/Startup] Marked "${FLAG_NAME}" as completed. Will not run again.\n`);

  } catch (err) {
    console.error('[Cleanup/Startup] Fatal cleanup error:', err.message);
    console.error('[Cleanup/Startup] Server will continue starting normally.\n');
  }
}

// ── CLI Mode (run as standalone script) ──
if (require.main === module) {
  const DB_HOST = process.env.DB_HOST || 'postgres';
  const DB_PORT = process.env.DB_PORT || 5432;
  const DB_NAME = process.env.DB_NAME || 'aniston_project_hub';
  const DB_USER = process.env.DB_USER || 'postgres';
  const DB_PASSWORD = process.env.DB_PASSWORD || 'changeme';

  const seq = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
    host: DB_HOST, port: DB_PORT, dialect: 'postgres', logging: false,
  });

  const args = process.argv.slice(2);
  const executeMode = args.includes('--execute');

  (async () => {
    try {
      await seq.authenticate();
      console.log('[DB] Connected successfully.\n');
    } catch (err) {
      console.error('[DB] Connection failed:', err.message);
      process.exit(1);
    }

    const result = await runCleanup(seq, { execute: executeMode, mode: 'cli' });
    await seq.close();
    process.exit(result.error ? 1 : 0);
  })();
}

module.exports = { runCleanup, runStartupCleanup };
