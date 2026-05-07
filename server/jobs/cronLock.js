const { sequelize } = require('../models');

/**
 * Distributed lock for cron jobs that must execute on only ONE backend
 * replica per tick.
 *
 * Why this exists
 * ---------------
 * `node-cron` schedules run inside the Node process that started them.
 * If we ever scale `aph-backend` past 1 replica (k8s, ECS, swarm), every
 * replica will independently fire every cron tick. For idempotent jobs
 * (e.g. reminderJob, which checks "did I already notify today?") that's
 * just wasted DB queries. For NON-idempotent jobs (recurringTaskJob,
 * missedRecurringTaskJob, vacuum) duplicate ticks produce real damage:
 * duplicate task instances, double VACUUMs holding locks, etc.
 *
 * How it works
 * ------------
 * `pg_try_advisory_xact_lock(int8)` attempts to take an exclusive lock
 * scoped to the current transaction. The lock is released automatically
 * on COMMIT/ROLLBACK — no chance of leaking a permanent lock if a worker
 * crashes mid-tick. Concurrent replicas all call the same key; exactly
 * one wins. Postgres docs:
 *   https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
 *
 * The lock keyspace is the entire bigint range, so we hash a job name
 * to a stable signed-bigint via FNV-1a. Two different job names will
 * not collide unless both hash to the same 64-bit value (~vanishing
 * probability for the small set of job names we have).
 *
 * Usage
 * -----
 *   await withCronLock('vacuumAnalyze', async () => {
 *     await sequelize.query('VACUUM ANALYZE');
 *   });
 *
 * Single-replica deploys are unaffected: the lock is always acquirable
 * by the lone replica, so the wrapper is a no-op overhead-wise.
 */

// FNV-1a 64-bit hash → signed BigInt that fits in Postgres bigint.
// Plain JS numbers can't represent 64-bit ints reliably, so we use BigInt.
function hashJobName(name) {
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = FNV_OFFSET;
  for (let i = 0; i < name.length; i++) {
    h = (h ^ BigInt(name.charCodeAt(i))) & MASK;
    h = (h * FNV_PRIME) & MASK;
  }
  // Convert unsigned 64-bit to signed 64-bit so it fits Postgres bigint
  // (range -2^63 .. 2^63 - 1).
  return h >= (1n << 63n) ? h - (1n << 64n) : h;
}

/**
 * Run `fn` exactly once across all replicas for a given job name + tick.
 * If another replica is already running this tick, returns null without
 * executing `fn`. Errors thrown by `fn` propagate after the lock releases.
 *
 * @param {string} jobName  Stable identifier for the job. Different
 *                          schedules of the same job MUST share the same
 *                          name (so they all contend for the same key).
 * @param {() => Promise<T>} fn  The work to perform if the lock is acquired.
 * @returns {Promise<T|null>}
 */
async function withCronLock(jobName, fn) {
  const lockKey = hashJobName(jobName).toString();
  let acquired = false;
  return await sequelize.transaction(async (t) => {
    const [rows] = await sequelize.query(
      'SELECT pg_try_advisory_xact_lock(CAST(:k AS bigint)) AS got',
      { transaction: t, replacements: { k: lockKey } }
    );
    acquired = !!(rows && rows[0] && rows[0].got);
    if (!acquired) {
      // Another replica owns this tick. Stay silent at INFO; only log at
      // DEBUG-style verbosity so we don't spam logs when scaled out.
      if (process.env.DEBUG_CRON_LOCK) {
        console.log(`[CronLock] ${jobName} skipped (another replica is running it).`);
      }
      return null;
    }
    return await fn();
  }).catch((err) => {
    if (acquired) {
      console.error(`[CronLock] ${jobName} threw inside locked block:`, err && err.message);
    } else {
      console.error(`[CronLock] ${jobName} could not acquire lock:`, err && err.message);
    }
    // Re-throw so the caller can decide. Lock has been released by the
    // failing transaction in either case.
    throw err;
  });
}

module.exports = { withCronLock };
