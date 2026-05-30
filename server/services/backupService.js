/**
 * Database backup service.
 *
 * Responsibilities
 * ---------------
 *   1. Create gzipped plain-SQL dumps of the application database via the
 *      `pg_dump` CLI installed in the backend container.
 *   2. Validate each dump (file present, non-empty, gzip-decodable) before
 *      marking it `completed`.
 *   3. Restore a previously captured dump back into the live database via
 *      `psql`, taking a pre-restore safety dump first.
 *   4. Apply a configurable retention policy that NEVER deletes manual or
 *      pre_restore artefacts automatically.
 *
 * Why .sql.gz instead of pg_dump custom format (.dump)
 * ----------------------------------------------------
 *   • Single-tool restore — `gunzip -c file | psql DB`. Custom format would
 *     require pg_restore, expanding the recovery surface.
 *   • Matches the legacy `deploy/backup.sh` script already in the repo, so
 *     operators reading the host bind-mount get a uniform format.
 *   • Validation is `gzip -t`, which is trivial and proves the file is
 *     intact at the bit level. (Custom format has `pg_restore --list`, but
 *     also masks corruption inside individual TOC entries.)
 *
 * Security
 * --------
 *   • Filenames are generated server-side from a timestamp + 8 random hex
 *     bytes — never user-controlled. Stored in `backup_records.filename`
 *     UNIQUE.
 *   • Every filesystem-touching helper rejects paths that don't resolve
 *     inside the configured backup directory (path-traversal defence).
 *   • pg_dump / psql receive credentials via PGPASSWORD env var (not as
 *     command-line args, which would leak into `ps`). Arguments are passed
 *     as an array to spawn — no shell, no interpolation, no injection.
 *
 * Replica safety
 * --------------
 *   The cron caller wraps `runScheduledBackup()` in `withCronLock` so only
 *   one replica per tick performs a dump. Manual API-triggered backups have
 *   no such gate (each operator click is an intentional, named action). The
 *   filename random suffix prevents collisions even on rapid double-clicks.
 *
 * pg_dump version compatibility
 * -----------------------------
 *   pg_dump must match (or exceed) the server major version, hence the
 *   `postgresql16-client` install in deploy/Dockerfile.server. If a future
 *   upgrade bumps the postgres image to v17, that Dockerfile line must
 *   change too — there's a smoke test on boot (`assertPgToolsAvailable`)
 *   that surfaces the mismatch loudly in logs.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Op } = require('sequelize');
const { BackupRecord } = require('../models');
const safeLogger = require('../utils/safeLogger');

// ─── Configuration ──────────────────────────────────────────────────────
//
// All knobs are env-driven so ops can change retention or move the storage
// directory without a code deploy. Defaults match the docker-compose volume
// layout (`backup_data:/app/backups`) in production.

// Resolve the default backup directory.
//   - Honour DB_BACKUP_DIR when set (the production container sets this to
//     /app/backups, mounted from the `backup_data` Docker volume).
//   - In production with no override → /app/backups (the Linux image default).
//   - In development with no override → <repo>/backups. The previous default
//     of `/app/backups` resolved to `C:\app\backups` on Windows hosts, which
//     requires admin rights to create and confused first-time dev users.
//     The repo-relative path is always writable by the developer.
function resolveBackupRoot() {
  if (process.env.DB_BACKUP_DIR) return path.resolve(process.env.DB_BACKUP_DIR);
  if (process.env.NODE_ENV === 'production') return '/app/backups';
  // __dirname = .../server/services → go up two levels for the repo root,
  // then into ./backups. This works regardless of where node is launched from.
  return path.resolve(__dirname, '..', '..', 'backups');
}
const BACKUP_ROOT = resolveBackupRoot();
const DB_BACKUP_DIR = path.join(BACKUP_ROOT, 'database');
const PRE_RESTORE_DIR = path.join(BACKUP_ROOT, 'pre-restore');
const UPLOAD_INBOX_DIR = path.join(BACKUP_ROOT, 'uploads-inbox');

// Retention applies ONLY to scheduled backups. Manual / pre_restore / uploaded
// are never auto-pruned — operators decide their lifecycle.
const RETENTION_DAYS = Math.max(
  1,
  parseInt(process.env.DB_BACKUP_RETENTION_DAYS, 10) || 30
);

// pg_dump / psql binaries. Allow overriding via env for unusual install
// locations (e.g. when the alpine package puts them in /usr/libexec).
const PG_DUMP_BIN = process.env.PG_DUMP_BIN || 'pg_dump';
const PSQL_BIN = process.env.PSQL_BIN || 'psql';
const GZIP_BIN = process.env.GZIP_BIN || 'gzip';
const GUNZIP_BIN = process.env.GUNZIP_BIN || 'gunzip';

// ── Docker-exec mode (dev convenience) ──────────────────────────────────
//
// In production the backend container ships with postgresql16-client
// (see deploy/Dockerfile.server), so pg_dump / psql are on PATH and we
// spawn them directly. In local development on a Windows / macOS host
// the developer typically runs Postgres in a Docker container but does
// NOT install PostgreSQL client tools on the host — so `spawn pg_dump`
// fails with ENOENT.
//
// Setting `DB_BACKUP_VIA_DOCKER=<container_name>` makes the service shell
// every pg_dump / psql invocation through `docker exec`, using the
// PostgreSQL tools that already live inside the postgres container.
// Stdin/stdout pipes pass through `docker exec` transparently, so the
// streaming dump → gzip pipeline and the gunzip → psql restore pipeline
// both keep working without code changes elsewhere.
//
//   DB_BACKUP_VIA_DOCKER=aniston-postgres        # local dev
//   DB_BACKUP_VIA_DOCKER=                        # unset → direct (production)
const DOCKER_CONTAINER = process.env.DB_BACKUP_VIA_DOCKER || '';
const DOCKER_BIN = process.env.DOCKER_BIN || 'docker';

// ── Backup timeout ──────────────────────────────────────────────────────
// Hard ceiling on a single backup. Any run that exceeds this is killed
// (SIGTERM, then SIGKILL after a short grace period) and the row is
// marked failed. Prevents the "stuck Running forever" UX from any
// pipeline / process / kernel-level hang. Default 10 min in dev, 30 min
// production — a 5 GB DB on slow disk has been seen to take ~15 min on
// our EC2 t3.medium, so 30 leaves comfortable headroom.
const BACKUP_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.DB_BACKUP_TIMEOUT_MS, 10);
  if (Number.isFinite(raw) && raw > 5_000) return raw;
  return process.env.NODE_ENV === 'production' ? 30 * 60 * 1000 : 10 * 60 * 1000;
})();

// After SIGTERM, wait this long for the children to exit cleanly before
// escalating to SIGKILL. Keep short — these processes hold no useful
// state at this point.
const KILL_GRACE_MS = 5_000;

// ── Progress checkpoints ────────────────────────────────────────────────
// Maximum percentage the bytes-based estimate is allowed to claim. Beyond
// this, we wait for the pg_dump-exited / validation-done / completed
// checkpoints. Prevents the bar from claiming 99% while the dump is still
// streaming, which would feel broken when the run actually finishes.
const PROGRESS_STREAMING_CAP = 80;
// How often we write a progress update to the DB (ms). Higher = fewer
// UPDATE statements, but staler UI. 1 s is generous given the polling
// cadence is 2-3 s.
const PROGRESS_DB_THROTTLE_MS = 1000;

// Build the `spawn` argv that runs `pg_dump` (or any pg binary) — either
// directly or wrapped in `docker exec` depending on DOCKER_CONTAINER. Returns
// { bin, args } that can be passed to spawn(bin, args, ...).
//
// When using docker-exec mode we forward PGPASSWORD / PGHOST / PGUSER /
// PGDATABASE via `-e KEY=VALUE` flags so the binary inside the container
// sees the same env it would on the host. PGHOST=localhost inside the
// container points at the container's own Postgres (which is what we want
// in dev — pg_dump connects to the local instance, not back to the host).
function buildPgCommand(binaryName, args = [], dbEnv = {}, opts = {}) {
  // needsStdin: true → pass `-i` so docker keeps stdin attached for the
  // inner process (required for `psql` reading SQL on stdin).
  // needsStdin: false (default) → omit `-i`. Passing `-i` for pg_dump on
  // some Docker Desktop versions can leave the docker exec process
  // half-open waiting for an EOF that Node's `stdio: 'ignore'` never
  // delivers, causing the pipeline to hang after pg_dump exits cleanly.
  // That was the root cause of the original "stuck on Running forever"
  // bug — keep this default unless you explicitly need stdin.
  const needsStdin = opts && opts.needsStdin === true;
  if (DOCKER_CONTAINER) {
    // Inside the container, override PGHOST since 'postgres' / a remote
    // hostname won't resolve from within the postgres container itself.
    const envForContainer = {
      ...dbEnv,
      PGHOST: '127.0.0.1',
      PGPORT: '5432',
    };
    const envArgs = [];
    for (const [k, v] of Object.entries(envForContainer)) {
      if (v != null && v !== '') envArgs.push('-e', `${k}=${v}`);
    }
    const baseArgs = needsStdin ? ['exec', '-i'] : ['exec'];
    return {
      bin: DOCKER_BIN,
      args: [...baseArgs, ...envArgs, DOCKER_CONTAINER, binaryName, ...args],
      // env passed to the docker process itself doesn't need PG* vars,
      // because we forwarded them through `-e`.
      env: {},
    };
  }
  // Direct mode — let spawn inherit the env we hand it.
  return {
    bin: binaryName,
    args,
    env: dbEnv,
  };
}

// Filename validation regex. We generate these ourselves so the format is
// fixed; the regex is a defence-in-depth check before any path resolution.
// 32 hex chars (16 bytes) of randomness keeps collisions effectively impossible.
const FILENAME_RE = /^db_[a-z_]+_\d{8}_\d{6}_[a-f0-9]{16}\.sql\.gz$/;

// Cap on pg_dump child process output we keep in memory for the
// errorMessage column. Anything beyond this is logged to disk via
// safeLogger but truncated for the DB row.
const STDERR_KEEP_BYTES = 4 * 1024;

// ─── Directory bootstrap ─────────────────────────────────────────────────

async function ensureDirectories() {
  // mkdir -p semantics. We don't ever want to error out of a controller
  // because /app/backups didn't exist yet — first-boot operators shouldn't
  // have to chmod anything by hand. The Docker named volume guarantees
  // persistence, but a fresh dev clone or test run may not have the dirs.
  await fsp.mkdir(DB_BACKUP_DIR, { recursive: true });
  await fsp.mkdir(PRE_RESTORE_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_INBOX_DIR, { recursive: true });
}

// Resolve and validate that `unsafePath` is inside one of the allowed roots.
// Throws if the path escapes — this is the path-traversal gate every
// filesystem operation funnels through.
function assertInsideBackupRoot(unsafePath) {
  const resolved = path.resolve(unsafePath);
  const allowedRoots = [DB_BACKUP_DIR, PRE_RESTORE_DIR, UPLOAD_INBOX_DIR];
  const ok = allowedRoots.some((root) => {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    return resolved === root || resolved.startsWith(rootWithSep);
  });
  if (!ok) {
    const err = new Error('Path outside allowed backup directory');
    err.code = 'PATH_TRAVERSAL';
    throw err;
  }
  return resolved;
}

// ─── Filename generation ─────────────────────────────────────────────────

function buildFilename(trigger) {
  // trigger appears in the filename so operators eyeballing the directory
  // can tell what produced it. Trigger values are constrained to a small
  // whitelist by the CHECK constraint on the table, so this is safe to
  // interpolate.
  const safeTrigger = String(trigger || 'manual').replace(/[^a-z_]/gi, '').toLowerCase() || 'manual';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    '_' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  const rand = crypto.randomBytes(8).toString('hex');
  return `db_${safeTrigger}_${stamp}_${rand}.sql.gz`;
}

// ─── Child-process helpers ───────────────────────────────────────────────

// Run a command with `spawn` and return a promise that resolves with the
// exit code, the (trimmed) stderr text, and a captured-stdout buffer (only
// when `captureStdout: true` — otherwise stdout is piped wherever the
// caller asked).
//
// Why spawn + array args (not exec + shell): we never want shell
// interpolation on values that include credentials or filenames. spawn
// with an array invokes the binary directly via execvp.
function runChild(bin, args, { env = {}, stdout, stdin, captureStdout = false, captureStderr = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...env },
      stdio: [
        stdin ? 'pipe' : 'ignore',
        stdout ? 'pipe' : (captureStdout ? 'pipe' : 'ignore'),
        captureStderr ? 'pipe' : 'inherit',
      ],
    });

    let stderrChunks = [];
    let stderrLen = 0;
    let stdoutChunks = [];

    if (captureStderr && child.stderr) {
      child.stderr.on('data', (chunk) => {
        // Cap the captured stderr so a misbehaving pg_dump can't OOM us.
        if (stderrLen < STDERR_KEEP_BYTES * 4) {
          stderrChunks.push(chunk);
          stderrLen += chunk.length;
        }
      });
    }

    if (captureStdout && child.stdout) {
      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    } else if (stdout && child.stdout) {
      child.stdout.pipe(stdout);
    }

    if (stdin && child.stdin) {
      stdin.pipe(child.stdin);
      stdin.on('error', (err) => {
        // Swallow EPIPE — happens naturally when the child exits before
        // the upstream stream finishes (e.g. gunzip errored on a corrupt
        // file). The actual error surfaces via the child's exit code.
        if (err && err.code !== 'EPIPE') reject(err);
      });
    }

    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const stdoutBuf = captureStdout ? Buffer.concat(stdoutChunks) : null;
      resolve({ code, signal, stderr, stdout: stdoutBuf });
    });
  });
}

// Resolve DB connection details from env. server.js fail-fasts on missing
// DB_USER/DB_PASSWORD at boot, so we can rely on these being set in production.
function getDbEnv() {
  const env = {
    PGHOST: process.env.DB_HOST || 'localhost',
    PGPORT: String(process.env.DB_PORT || 5432),
    PGUSER: process.env.DB_USER || 'postgres',
    PGDATABASE: process.env.DB_NAME || 'aniston_project_hub',
  };
  if (process.env.DB_PASSWORD) {
    env.PGPASSWORD = process.env.DB_PASSWORD;
  }
  return env;
}

// One-time smoke test surfaced via the cron job startup. Tries `pg_dump --version`
// and `psql --version`; logs success/failure but never throws. The API endpoints
// would surface "ENOENT spawn pg_dump" themselves if either is missing — this is
// just early warning so ops see the problem in the boot log, not at 6 PM.
async function assertPgToolsAvailable() {
  const mode = DOCKER_CONTAINER ? `docker exec ${DOCKER_CONTAINER}` : 'direct';
  const dumpCmd = buildPgCommand(PG_DUMP_BIN, ['--version']);
  try {
    const { code, stderr } = await runChild(dumpCmd.bin, dumpCmd.args, { env: dumpCmd.env });
    if (code !== 0) {
      safeLogger.warn('[BackupService] pg_dump --version exited non-zero', { code, stderr, mode });
    } else {
      safeLogger.info('[BackupService] pg_dump available', { mode });
    }
  } catch (err) {
    const hint = DOCKER_CONTAINER
      ? `docker exec failed — is the "${DOCKER_CONTAINER}" container running?`
      : 'install postgresql-client OR set DB_BACKUP_VIA_DOCKER=<container_name> in your .env';
    safeLogger.warn(`[BackupService] pg_dump unavailable — ${hint}`, { err, mode });
  }
  const psqlCmd = buildPgCommand(PSQL_BIN, ['--version']);
  try {
    const { code, stderr } = await runChild(psqlCmd.bin, psqlCmd.args, { env: psqlCmd.env });
    if (code !== 0) {
      safeLogger.warn('[BackupService] psql --version exited non-zero', { code, stderr, mode });
    }
  } catch (err) {
    safeLogger.warn('[BackupService] psql unavailable — DB restores will fail', { err, mode });
  }
}

// ─── Core: create a backup ───────────────────────────────────────────────
//
// Streams pg_dump → gzip → file. Marks the BackupRecord row as completed
// only after the file passes validation. On any failure the row is marked
// `failed` with a redacted error message and the partial file is removed.
//
// `trigger` is one of: 'scheduled' | 'manual' | 'pre_restore'.
// (The 'uploaded' trigger comes through a separate path — see acceptUpload.)

async function createBackup({ trigger = 'manual', createdBy = null } = {}) {
  await ensureDirectories();

  if (!['scheduled', 'manual', 'pre_restore'].includes(trigger)) {
    throw new Error(`Invalid trigger: ${trigger}`);
  }

  // ── Concurrency lock ─────────────────────────────────────────────────
  // Only one in-flight backup at a time. Two simultaneous pg_dumps wouldn't
  // corrupt anything (Postgres serialises) but would double the IO + double
  // the disk usage for a window. We exempt `pre_restore` from this check
  // because a restore is always invoked with the user holding a real intent
  // and the safety dump is part of that atomic operation — refusing it
  // would block recovery.
  if (trigger !== 'pre_restore') {
    const inFlight = await BackupRecord.findOne({ where: { status: 'running' } });
    if (inFlight) {
      const err = new Error(
        `Another backup is already running (id=${inFlight.id}, started ${new Date(inFlight.createdAt).toISOString()}). Wait for it to finish, or it will be marked failed automatically after the timeout.`
      );
      err.code = 'BACKUP_ALREADY_RUNNING';
      err.runningBackupId = inFlight.id;
      throw err;
    }
  }

  const filename = buildFilename(trigger);
  const targetDir = trigger === 'pre_restore' ? PRE_RESTORE_DIR : DB_BACKUP_DIR;
  const fullPath = path.join(targetDir, filename);
  assertInsideBackupRoot(fullPath);

  // Record row up front (status=running, 0% progress) so the UI can show
  // the in-flight operation and so a server crash mid-backup leaves an
  // auditable trace.
  const record = await BackupRecord.create({
    filename,
    path: fullPath,
    trigger,
    status: 'running',
    createdBy,
    progressPercent: 0,
  });

  // Look up the most recent completed backup of the same DB to use as a
  // size anchor for the bytes-based progress estimate. If none exists, we
  // fall back to staged checkpoints only.
  const sizeAnchor = await BackupRecord.findOne({
    where: { status: 'completed' },
    order: [['createdAt', 'DESC']],
    attributes: ['sizeBytes'],
  }).catch(() => null);
  const anchorBytes = sizeAnchor?.sizeBytes ? Number(sizeAnchor.sizeBytes) : 0;

  safeLogger.info('[BackupService] backup started', {
    id: record.id, filename, trigger, createdBy,
    mode: DOCKER_CONTAINER ? `docker exec ${DOCKER_CONTAINER}` : 'direct',
    sizeAnchorBytes: anchorBytes,
    timeoutMs: BACKUP_TIMEOUT_MS,
  });

  // Throttled progress writer — never writes more than once per
  // PROGRESS_DB_THROTTLE_MS even when called per-chunk. The most recent
  // value always wins; older values in flight are coalesced.
  let lastPersistedPct = 0;
  let lastWriteAt = 0;
  let pendingPct = null;
  let writeInFlight = false;
  async function updateProgress(pct) {
    const clamped = Math.max(0, Math.min(100, Math.floor(pct)));
    if (clamped <= lastPersistedPct) return; // monotonic
    pendingPct = clamped;
    const now = Date.now();
    if (writeInFlight) return; // coalesce — a write is already on its way
    if (now - lastWriteAt < PROGRESS_DB_THROTTLE_MS && clamped < 100) return;
    writeInFlight = true;
    try {
      const val = pendingPct;
      pendingPct = null;
      lastWriteAt = Date.now();
      lastPersistedPct = val;
      await BackupRecord.update({ progressPercent: val }, { where: { id: record.id } });
    } catch (_) {
      // Non-fatal — progress updates are advisory.
    } finally {
      writeInFlight = false;
      if (pendingPct != null && pendingPct > lastPersistedPct) {
        // A newer value arrived while we were writing — flush it after a
        // tiny delay so we keep honouring the throttle.
        setTimeout(() => updateProgress(pendingPct), PROGRESS_DB_THROTTLE_MS);
      }
    }
  }

  // Open the output file. We write through gzip so the file is immediately
  // readable as a valid .sql.gz on disk — no intermediate raw .sql artefact.
  const writeStream = fs.createWriteStream(fullPath, { mode: 0o600 });

  // ── Spawn pg_dump (direct or via docker exec) ────────────────────────
  // pg_dump writes plain SQL on stdout. We never need stdin → it's
  // 'ignore' on our side and docker exec only gets the -i flag when stdin
  // is actually required (psql restore path), avoiding a hang where docker
  // keeps the channel half-open waiting for an EOF that never comes.
  const dumpArgs = [
    '--format=plain',
    '--no-owner',
    '--no-privileges',
    '--clean',
    '--if-exists',
    process.env.DB_NAME || 'aniston_project_hub',
  ];
  const dbEnv = getDbEnv();
  const dumpCmd = buildPgCommand(PG_DUMP_BIN, dumpArgs, dbEnv, { needsStdin: false });

  let dump, gzip;
  let timedOut = false;
  let timeoutHandle = null;
  let killEscalationHandle = null;

  // Kill helper — invoked from the timeout path AND from the error path
  // so a hung pg_dump is always reaped, never left as a zombie pinning
  // the next backup slot.
  function killChildren(reason) {
    safeLogger.warn('[BackupService] killing backup children', { id: record.id, reason });
    try { if (dump && dump.exitCode == null) dump.kill('SIGTERM'); } catch (_) { /* ignore */ }
    try { if (gzip && gzip.exitCode == null) gzip.kill('SIGTERM'); } catch (_) { /* ignore */ }
    killEscalationHandle = setTimeout(() => {
      try { if (dump && dump.exitCode == null) dump.kill('SIGKILL'); } catch (_) { /* ignore */ }
      try { if (gzip && gzip.exitCode == null) gzip.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, KILL_GRACE_MS);
  }

  try {
    await updateProgress(5);

    dump = spawn(dumpCmd.bin, dumpCmd.args, {
      env: { ...process.env, ...dumpCmd.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gzip = spawn(GZIP_BIN, ['-c'], { stdio: ['pipe', 'pipe', 'pipe'] });

    // Bounded stderr capture for diagnostic preservation. Cap so an
    // infinitely-chatty child can't OOM the process.
    const dumpStderr = [];
    let dumpStderrLen = 0;
    const gzipStderr = [];
    let gzipStderrLen = 0;
    dump.stderr.on('data', (c) => {
      if (dumpStderrLen < STDERR_KEEP_BYTES * 4) { dumpStderr.push(c); dumpStderrLen += c.length; }
    });
    gzip.stderr.on('data', (c) => {
      if (gzipStderrLen < STDERR_KEEP_BYTES * 4) { gzipStderr.push(c); gzipStderrLen += c.length; }
    });

    await updateProgress(10);

    // ── CRITICAL: register all stream-completion listeners BEFORE
    // ── piping starts. If we wait until after `await Promise.all([...])`
    // ── to attach the writeStream 'finish' handler, the children can
    // ── complete + the writeStream can flush before our listener exists.
    // ── That was the original stuck-on-Running bug — `finish` fired but
    // ── no one was listening, so the Promise never resolved.
    const dumpProm = new Promise((resolve, reject) => {
      dump.on('error', reject);
      dump.on('close', (code, signal) => resolve({ code, signal }));
    });
    const gzipProm = new Promise((resolve, reject) => {
      gzip.on('error', reject);
      gzip.on('close', (code, signal) => resolve({ code, signal }));
    });
    const writeProm = new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Bytes-tracked progress estimate. We tap gzip.stdout (the
    // compressed bytes about to hit disk) because that's the unit our
    // size-anchor record stored. Estimate scales 10→PROGRESS_STREAMING_CAP
    // across [0, anchorBytes]; if no anchor exists, we hold at 30% and
    // let the staged checkpoints carry the bar to 85+ on exit.
    let bytesWritten = 0;
    gzip.stdout.on('data', (chunk) => {
      bytesWritten += chunk.length;
      if (anchorBytes > 0) {
        const frac = Math.min(1, bytesWritten / anchorBytes);
        const pct = 10 + Math.floor((PROGRESS_STREAMING_CAP - 10) * frac);
        updateProgress(pct);
      } else if (bytesWritten > 0 && lastPersistedPct < 30) {
        updateProgress(30);
      }
    });

    // Wire the pipes AFTER all listeners are attached.
    dump.stdout.pipe(gzip.stdin);
    gzip.stdout.pipe(writeStream);

    // Hard timeout. Triggers killChildren which propagates errors out
    // through the dump/gzip Promises and we land in the catch below.
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChildren(`timeout after ${BACKUP_TIMEOUT_MS} ms`);
    }, BACKUP_TIMEOUT_MS);

    // Now safely await — listeners are already in place.
    const [dumpResult, gzipResult] = await Promise.all([dumpProm, gzipProm]);
    await writeProm;

    clearTimeout(timeoutHandle); timeoutHandle = null;
    if (killEscalationHandle) { clearTimeout(killEscalationHandle); killEscalationHandle = null; }

    if (timedOut) {
      throw new Error(`Backup exceeded ${BACKUP_TIMEOUT_MS / 1000}s timeout and was killed.`);
    }
    if (dumpResult.code !== 0) {
      const stderr = Buffer.concat(dumpStderr).toString('utf8').trim();
      throw new Error(`pg_dump exited ${dumpResult.code}: ${stderr.slice(0, STDERR_KEEP_BYTES)}`);
    }
    if (gzipResult.code !== 0) {
      const stderr = Buffer.concat(gzipStderr).toString('utf8').trim();
      throw new Error(`gzip exited ${gzipResult.code}: ${stderr.slice(0, STDERR_KEEP_BYTES)}`);
    }

    await updateProgress(90);

    // Validate: file exists and is non-empty. A 0-byte .sql.gz is the
    // classic "pg_dump auth failed silently" failure mode.
    const stat = await fsp.stat(fullPath);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`Backup file invalid: size=${stat.size}`);
    }

    // Integrity check: `gzip -t` decodes the entire stream and exits
    // non-zero on any CRC mismatch or truncation.
    const gzipTest = await runChild(GZIP_BIN, ['-t', fullPath]);
    if (gzipTest.code !== 0) {
      throw new Error(`gzip integrity check failed: ${gzipTest.stderr.slice(0, STDERR_KEEP_BYTES)}`);
    }

    record.sizeBytes = stat.size;
    record.status = 'completed';
    record.completedAt = new Date();
    record.progressPercent = 100;
    await record.save();

    safeLogger.info('[BackupService] backup completed', {
      id: record.id, filename, sizeBytes: stat.size, trigger,
      durationMs: Date.now() - new Date(record.createdAt).getTime(),
    });

    return record;
  } catch (err) {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    if (killEscalationHandle) { clearTimeout(killEscalationHandle); killEscalationHandle = null; }
    // Make absolutely sure no orphan child is left holding file handles
    // or the concurrency slot.
    if (!timedOut) killChildren('error path cleanup');

    // Make sure the file handle is closed before we try to unlink.
    try { writeStream.destroy(); } catch (_) { /* ignore */ }

    // Clean up any partial file. Keep the row (status=failed) so the UI
    // can show the failure rather than silently dropping it.
    try { await fsp.unlink(fullPath); } catch (_) { /* ignore */ }

    // Rewrite the classic "spawn pg_dump ENOENT" / "spawn docker ENOENT"
    // into a setup-actionable message. The raw ENOENT is correct but
    // tells the operator nothing about *how* to fix it.
    let message;
    if (err && err.code === 'ENOENT') {
      if (DOCKER_CONTAINER) {
        message = `docker exec not found on PATH. Install Docker CLI, or unset DB_BACKUP_VIA_DOCKER and install postgresql-client locally.`;
      } else {
        message = `pg_dump not found on PATH. In dev, set DB_BACKUP_VIA_DOCKER=<postgres_container_name> in your .env (e.g. "aniston-postgres") to use the pg tools inside the running Postgres container. In production, the backend image installs postgresql16-client automatically.`;
      }
    } else {
      message = (err && err.message) ? err.message.slice(0, STDERR_KEEP_BYTES) : 'Unknown backup failure';
    }
    record.status = 'failed';
    record.errorMessage = message;
    record.completedAt = new Date();
    try { await record.save(); } catch (_) { /* secondary failure */ }

    safeLogger.error('[BackupService] backup failed', {
      id: record.id, filename, trigger, err, timedOut,
      dockerContainer: DOCKER_CONTAINER || null,
    });

    // Attach the actionable message onto the thrown error so the
    // controller can surface it back to the Tier-1 operator.
    const friendly = new Error(message);
    friendly.code = err && err.code;
    friendly.cause = err;
    throw friendly;
  }
}

// ─── Core: restore from a backup ─────────────────────────────────────────
//
// Two callers:
//   1. /admin/backups/database/:id/restore — restore from a known record.
//   2. /admin/backups/database/restore-upload — restore from a freshly
//      uploaded file (which we first persist as an `uploaded` record).
//
// Both paths share the same internal restore step here. Each invocation
// FIRST creates a `pre_restore` safety backup of the live DB so a
// recovery is always possible if the chosen artefact turns out to be
// damaged or for the wrong schema version.

async function restoreFromRecord({ recordId, actingUser, options = {} }) {
  const record = await BackupRecord.findByPk(recordId);
  if (!record) {
    const err = new Error('Backup not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (record.status !== 'completed') {
    const err = new Error('Backup is not in a completed state');
    err.code = 'BACKUP_NOT_READY';
    throw err;
  }

  const resolved = assertInsideBackupRoot(record.path);

  // 1) Pre-restore safety dump. If this fails we abort BEFORE touching
  // the live DB. The pre_restore record carries createdBy=actingUser so
  // audits can trace who triggered the recovery.
  safeLogger.warn('[BackupService] restore initiated', {
    recordId, filename: record.filename, by: actingUser?.id,
  });

  let preRestore = null;
  if (options.skipPreRestoreBackup !== true) {
    preRestore = await createBackup({
      trigger: 'pre_restore',
      createdBy: actingUser?.id || null,
    });
  }

  // 2) Stream the file through gunzip → psql.
  // psql exits non-zero if any statement errors (we pass --set ON_ERROR_STOP=1).
  // The dump was created with --clean --if-exists so existing objects are
  // dropped and recreated cleanly.
  const dbEnv = getDbEnv();
  const psqlArgs = [
    '--set', 'ON_ERROR_STOP=1',
    '--quiet',
    process.env.DB_NAME || 'aniston_project_hub',
  ];

  // gunzip runs locally — it just decompresses the file from disk and
  // streams plain SQL on stdout. No DB involvement here.
  const gunzip = spawn(GUNZIP_BIN, ['-c', resolved], { stdio: ['ignore', 'pipe', 'pipe'] });
  // psql runs either directly or via `docker exec -i <container> psql ...`,
  // controlled by DB_BACKUP_VIA_DOCKER. Stdin is the SQL stream — psql
  // executes each statement against the database. ON_ERROR_STOP=1 aborts
  // the entire script if any statement errors. `needsStdin: true` adds
  // the `-i` flag in docker-exec mode so the container keeps stdin open
  // for the SQL stream.
  const psqlCmd = buildPgCommand(PSQL_BIN, psqlArgs, dbEnv, { needsStdin: true });
  const psql = spawn(psqlCmd.bin, psqlCmd.args, {
    env: { ...process.env, ...psqlCmd.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const gunzipStderr = [];
  const psqlStderr = [];
  const psqlStdout = [];
  let gunzipLen = 0;
  let psqlErrLen = 0;
  gunzip.stderr.on('data', (c) => {
    if (gunzipLen < STDERR_KEEP_BYTES * 4) { gunzipStderr.push(c); gunzipLen += c.length; }
  });
  psql.stderr.on('data', (c) => {
    if (psqlErrLen < STDERR_KEEP_BYTES * 4) { psqlStderr.push(c); psqlErrLen += c.length; }
  });
  psql.stdout.on('data', (c) => psqlStdout.push(c));

  gunzip.stdout.pipe(psql.stdin);
  gunzip.stdout.on('error', () => { /* swallow EPIPE */ });

  const [gunzipResult, psqlResult] = await Promise.all([
    new Promise((resolve, reject) => {
      gunzip.on('error', reject);
      gunzip.on('close', (code, signal) => resolve({ code, signal }));
    }),
    new Promise((resolve, reject) => {
      psql.on('error', reject);
      psql.on('close', (code, signal) => resolve({ code, signal }));
    }),
  ]);

  if (gunzipResult.code !== 0) {
    const stderr = Buffer.concat(gunzipStderr).toString('utf8').trim();
    safeLogger.error('[BackupService] restore: gunzip failed', { recordId, code: gunzipResult.code });
    const err = new Error(`gunzip failed during restore: ${stderr.slice(0, STDERR_KEEP_BYTES)}`);
    err.code = 'RESTORE_FAILED';
    err.preRestoreId = preRestore?.id || null;
    throw err;
  }
  if (psqlResult.code !== 0) {
    const stderr = Buffer.concat(psqlStderr).toString('utf8').trim();
    safeLogger.error('[BackupService] restore: psql failed', { recordId, code: psqlResult.code });
    const err = new Error(`psql failed during restore: ${stderr.slice(0, STDERR_KEEP_BYTES)}`);
    err.code = 'RESTORE_FAILED';
    err.preRestoreId = preRestore?.id || null;
    throw err;
  }

  record.restoredAt = new Date();
  await record.save();

  safeLogger.warn('[BackupService] restore completed', {
    recordId, filename: record.filename, by: actingUser?.id, preRestoreId: preRestore?.id,
  });

  return { record, preRestoreId: preRestore?.id || null };
}

// ─── Uploads: persist + validate ──────────────────────────────────────────
//
// Saves an operator-supplied .sql.gz into the uploads-inbox directory and
// records it as `trigger=uploaded`. Validates the gzip stream before
// returning so the operator can't trigger a restore against a corrupt file.

async function acceptUpload({ tempPath, originalName, actingUser }) {
  await ensureDirectories();

  const safeOriginalName = String(originalName || '').slice(0, 255);
  if (!/\.(sql\.gz|gz)$/i.test(safeOriginalName)) {
    const err = new Error('Uploaded file must end in .sql.gz');
    err.code = 'BAD_EXTENSION';
    throw err;
  }

  const filename = buildFilename('uploaded');
  const dest = path.join(UPLOAD_INBOX_DIR, filename);
  assertInsideBackupRoot(dest);

  // Move (or copy across devices) the multer temp file into the inbox.
  try {
    await fsp.rename(tempPath, dest);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      // Cross-device rename — fall back to streaming copy + unlink.
      await new Promise((resolve, reject) => {
        const rd = fs.createReadStream(tempPath);
        const wr = fs.createWriteStream(dest, { mode: 0o600 });
        rd.on('error', reject);
        wr.on('error', reject);
        wr.on('finish', resolve);
        rd.pipe(wr);
      });
      try { await fsp.unlink(tempPath); } catch (_) { /* ignore */ }
    } else {
      throw err;
    }
  }
  // Force perms in case the multer default was permissive.
  try { await fsp.chmod(dest, 0o600); } catch (_) { /* not fatal */ }

  // gzip integrity check before we ever expose this as a restore target.
  const gzipTest = await runChild(GZIP_BIN, ['-t', dest]);
  if (gzipTest.code !== 0) {
    try { await fsp.unlink(dest); } catch (_) { /* ignore */ }
    const err = new Error(`Uploaded file failed gzip integrity check: ${gzipTest.stderr.slice(0, 256)}`);
    err.code = 'BAD_GZIP';
    throw err;
  }

  const stat = await fsp.stat(dest);
  if (stat.size === 0) {
    try { await fsp.unlink(dest); } catch (_) { /* ignore */ }
    const err = new Error('Uploaded file is empty');
    err.code = 'EMPTY_FILE';
    throw err;
  }

  const record = await BackupRecord.create({
    filename,
    path: dest,
    sizeBytes: stat.size,
    trigger: 'uploaded',
    status: 'completed',
    completedAt: new Date(),
    errorMessage: `original=${safeOriginalName}`, // audit trail for the operator-supplied name
    createdBy: actingUser?.id || null,
  });

  safeLogger.info('[BackupService] upload accepted', {
    id: record.id, filename, sizeBytes: stat.size, by: actingUser?.id, original: safeOriginalName,
  });

  return record;
}

// ─── Delete ──────────────────────────────────────────────────────────────

async function deleteBackup({ recordId, actingUser }) {
  const record = await BackupRecord.findByPk(recordId);
  if (!record) {
    const err = new Error('Backup not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  // The path-traversal gate: we ONLY ever delete files whose stored path
  // resolves inside one of our backup directories. A tampered row (e.g.
  // someone reaching the DB directly and pointing `path` at /etc/passwd)
  // is rejected here before any filesystem call.
  let resolved;
  try {
    resolved = assertInsideBackupRoot(record.path);
  } catch (err) {
    safeLogger.error('[BackupService] delete blocked — record path outside backup root', {
      recordId, path: record.path,
    });
    throw err;
  }

  try {
    await fsp.unlink(resolved);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // File already gone (e.g. manual cleanup on disk). Delete the row anyway
    // so the UI reflects reality.
    safeLogger.warn('[BackupService] file already gone; removing row', { recordId, path: resolved });
  }

  await record.destroy();
  safeLogger.info('[BackupService] backup deleted', {
    recordId, filename: record.filename, by: actingUser?.id,
  });
  return { id: recordId };
}

// ─── Resolve a record for download ───────────────────────────────────────
//
// Returns a validated absolute path the controller can stream. Throws
// PATH_TRAVERSAL if the stored path is suspicious. Caller is responsible
// for setting Content-Disposition / Content-Type and piping the file.

async function getDownloadInfo({ recordId }) {
  const record = await BackupRecord.findByPk(recordId);
  if (!record) {
    const err = new Error('Backup not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (record.status !== 'completed') {
    const err = new Error('Backup is not in a completed state');
    err.code = 'BACKUP_NOT_READY';
    throw err;
  }
  const resolved = assertInsideBackupRoot(record.path);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) {
    const err = new Error('Backup file missing on disk');
    err.code = 'FILE_MISSING';
    throw err;
  }
  return { record, absolutePath: resolved, sizeBytes: stat.size };
}

// ─── Retention pass ──────────────────────────────────────────────────────
//
// Called from the daily cron after a successful scheduled run. Deletes
// `trigger=scheduled` rows older than RETENTION_DAYS. Manual / pre_restore /
// uploaded backups are preserved indefinitely — that's the explicit
// product requirement.

async function applyRetentionPolicy() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await BackupRecord.findAll({
    where: {
      trigger: 'scheduled',
      createdAt: { [Op.lt]: cutoff },
    },
    order: [['createdAt', 'ASC']],
  });

  let deleted = 0;
  for (const record of candidates) {
    try {
      await deleteBackup({ recordId: record.id, actingUser: null });
      deleted++;
    } catch (err) {
      safeLogger.warn('[BackupService] retention delete failed', {
        recordId: record.id, err,
      });
    }
  }
  if (deleted > 0) {
    safeLogger.info('[BackupService] retention pass complete', { deleted, retentionDays: RETENTION_DAYS });
  }
  return { deleted, retentionDays: RETENTION_DAYS };
}

// ─── Listing (with optional filesystem reconciliation) ───────────────────

// ─── Startup recovery ─────────────────────────────────────────────────────
//
// Any BackupRecord row left in `status='running'` after the server boots
// is by definition orphaned: the only Node process that could complete it
// is the one that just started, and it doesn't have references to those
// old in-flight pipelines. Mark them failed so the UI doesn't show a
// permanent spinner and the concurrency lock above can grant a fresh
// backup slot.
//
// We use an age window (default: anything older than 60 s) so that a
// near-instant restart that happens *while* a brand-new row is being
// inserted doesn't immediately flip it. In practice the row insert and
// the spawn happen back-to-back, so 60 s is overwhelmingly safe.
async function recoverStaleRunningBackups({ minAgeSeconds = 60 } = {}) {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000);
  const stale = await BackupRecord.findAll({
    where: {
      status: 'running',
      createdAt: { [Op.lt]: cutoff },
    },
  });
  if (stale.length === 0) return { recovered: 0 };

  for (const row of stale) {
    row.status = 'failed';
    row.errorMessage = 'Backup process was interrupted before completion (server restart or crash).';
    row.completedAt = new Date();
    // Best-effort cleanup of the partial file. The file may or may not
    // exist depending on how far the original run got. Path is validated
    // via assertInsideBackupRoot so a tampered row can't make us delete
    // anything outside the backup directories.
    try {
      const resolved = assertInsideBackupRoot(row.path);
      await fsp.unlink(resolved).catch(() => {});
    } catch (_) { /* path outside backup root — skip cleanup */ }
    try { await row.save(); } catch (_) { /* secondary failure */ }
  }
  safeLogger.warn('[BackupService] stale running backups recovered', {
    count: stale.length, ids: stale.map((r) => r.id),
  });
  return { recovered: stale.length };
}

async function listBackups({ limit = 100, offset = 0 } = {}) {
  const records = await BackupRecord.findAll({
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  // We could reconcile against the filesystem here (e.g. mark records
  // FILE_MISSING if the file vanished). That's heavier than every list
  // call needs. The download endpoint surfaces FILE_MISSING when actually
  // streaming — that's sufficient signal for the UI.
  return records;
}

module.exports = {
  // Config & paths (exported for the controller / tests)
  BACKUP_ROOT,
  DB_BACKUP_DIR,
  PRE_RESTORE_DIR,
  UPLOAD_INBOX_DIR,
  RETENTION_DAYS,
  BACKUP_TIMEOUT_MS,
  FILENAME_RE,

  // Operations
  ensureDirectories,
  assertPgToolsAvailable,
  createBackup,
  restoreFromRecord,
  acceptUpload,
  deleteBackup,
  getDownloadInfo,
  applyRetentionPolicy,
  listBackups,
  recoverStaleRunningBackups,
};
