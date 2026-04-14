/**
 * Director Plan & Time Plan Data Cleanup Script
 *
 * Safely deletes all records from:
 *   - director_plans  (Director's Daily Plan feature)
 *   - time_blocks     (Dashboard Time Plan / Time Planner feature)
 *
 * These tables are self-contained — no other tables reference them via FK.
 * Deleting their rows does NOT affect tasks, boards, users, dashboards, or any other module.
 *
 * ── STANDALONE CLI USAGE ──
 *   node cleanup-plan-data.js --dry-run       Preview what will be deleted (safe, no changes)
 *   node cleanup-plan-data.js --execute       Actually delete the data
 *
 * Production (Docker):
 *   docker exec aph-backend node cleanup-plan-data.js --dry-run
 *   docker exec aph-backend node cleanup-plan-data.js --execute
 *
 * ── AUTOMATIC STARTUP MODE ──
 * When imported by server.js, the exported runCleanup(sequelize) function is called.
 * It runs automatically during startup ONLY when BOTH env vars are set:
 *   RUN_PLAN_DATA_CLEANUP=true
 *   PLAN_DATA_CLEANUP_CONFIRM=YES_DELETE_PLAN_DATA
 *
 * Safety:
 *   - Default mode is dry-run (no flag = dry-run)
 *   - Requires explicit --execute flag (CLI) or two env vars (startup mode)
 *   - Shows environment and DB target before any action
 *   - Logs record counts before and after deletion
 *   - Wraps everything in a transaction (auto-rollback on error)
 *   - Auto-skips if tables are already empty (safe on every restart)
 *   - Non-blocking in startup mode — server starts even if cleanup fails
 */

const { Sequelize } = require('sequelize');

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

/**
 * Core cleanup logic — used by both CLI and startup modes.
 *
 * @param {Sequelize} seq  — Sequelize instance (already authenticated)
 * @param {object} opts
 * @param {boolean} opts.execute  — true = delete, false = dry-run
 * @param {string}  opts.mode     — 'cli' or 'startup' (for log labeling)
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
  console.log(`${prefix} Trigger     : ${mode === 'startup' ? 'Automatic (env-var gated)' : 'Manual CLI'}`);
  console.log(`${prefix} Environment : ${NODE_ENV}`);
  console.log(`${prefix} DB Host     : ${process.env.DB_HOST || 'localhost'}`);
  console.log(`${prefix} DB Name     : ${process.env.DB_NAME || 'aniston_project_hub'}`);
  console.log();

  if (execute && (NODE_ENV === 'production' || (process.env.DB_HOST && process.env.DB_HOST !== 'localhost'))) {
    console.log(`${prefix} *** WARNING: EXECUTING AGAINST PRODUCTION DATABASE ***`);
    console.log(`${prefix} *** Data will be permanently deleted.              ***`);
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
      return { skipped: true, reason: 'Tables already empty' };
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
 * Check env vars and run cleanup during server startup.
 * Called from server.js — non-blocking, never crashes the server.
 *
 * Required env vars (BOTH must be set):
 *   RUN_PLAN_DATA_CLEANUP=true
 *   PLAN_DATA_CLEANUP_CONFIRM=YES_DELETE_PLAN_DATA
 *
 * @param {Sequelize} seq — Sequelize instance (already connected)
 */
async function runStartupCleanup(seq) {
  const enabled = process.env.RUN_PLAN_DATA_CLEANUP;
  const confirm = process.env.PLAN_DATA_CLEANUP_CONFIRM;

  // Gate 1: Must be explicitly enabled
  if (enabled !== 'true') {
    return; // Silent skip — normal deploy, no cleanup requested
  }

  console.log('\n[Cleanup/Startup] RUN_PLAN_DATA_CLEANUP=true detected.');

  // Gate 2: Must have correct confirmation value
  if (confirm !== 'YES_DELETE_PLAN_DATA') {
    console.warn('[Cleanup/Startup] Missing or incorrect PLAN_DATA_CLEANUP_CONFIRM value.');
    console.warn('[Cleanup/Startup] Expected: PLAN_DATA_CLEANUP_CONFIRM=YES_DELETE_PLAN_DATA');
    console.warn('[Cleanup/Startup] Cleanup SKIPPED. Server will start normally.\n');
    return;
  }

  console.log('[Cleanup/Startup] Confirmation verified. Running cleanup...\n');

  try {
    const result = await runCleanup(seq, { execute: true, mode: 'startup' });

    if (result.skipped) {
      console.log(`[Cleanup/Startup] Skipped: ${result.reason}\n`);
    } else if (result.deleted) {
      console.log('[Cleanup/Startup] Cleanup completed successfully.');
      console.log('[Cleanup/Startup] IMPORTANT: Remove RUN_PLAN_DATA_CLEANUP and PLAN_DATA_CLEANUP_CONFIRM');
      console.log('[Cleanup/Startup]   from your environment variables to prevent re-runs.\n');
    } else if (result.error) {
      console.error(`[Cleanup/Startup] Cleanup failed: ${result.error}`);
      console.error('[Cleanup/Startup] Server will continue starting normally.\n');
    }
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
