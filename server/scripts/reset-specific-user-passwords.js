/**
 * Targeted local-password recovery for an explicit, allowlisted set of users.
 *
 * Why this exists:
 *   When a user forgets the local password they previously created from the
 *   profile / forgot-password flow, an admin needs a safe, surgical way to
 *   put that account back into a "set a new password via /reset-password"
 *   state — without ever touching tasks, boards, permissions, role,
 *   hierarchy, profile data, comments, attachments, watchers, approvals,
 *   workspaces, notifications, or any other related table.
 *
 *   This script does exactly that, for an allowlist of users you pass on
 *   the command line. It performs two things atomically per user:
 *
 *     1. Clears the local password hash and the has_local_password flag
 *        (so /api/auth/login can no longer accept any old/forgotten hash).
 *     2. Generates a fresh single-use, hashed, 24h-TTL password reset
 *        token — identical to what POST /api/auth/forgot-password would
 *        store, so POST /api/auth/reset-password works unchanged.
 *
 *   The raw token is printed once. Hand the resulting reset URL to the
 *   user over a secure channel (SSO chat, in-person, etc.) — it is NEVER
 *   logged anywhere on disk and never persisted server-side; only its
 *   sha256 hash is stored.
 *
 * Fields touched (and ONLY these):
 *   - password               → NULL
 *   - has_local_password     → false
 *   - password_changed_at    → unchanged (we did not change a password,
 *                              we cleared one — leaving the previous
 *                              timestamp keeps the audit trail honest)
 *   - password_reset_token   → sha256 hex of a freshly generated token
 *   - password_reset_expires → now + ttlHours
 *
 * Fields explicitly NOT touched: id, name, email, authProvider, avatar,
 * role, department, designation, departmentId, teams* (so SSO keeps
 * working), isActive, localStatusOverride, isSuperAdmin, accountStatus,
 * hierarchyLevel, title, fontSizePreference, createdAt, updatedAt — and
 * every related table (tasks, boards, board_members, workspaces,
 * permission_grants, task_assignees, task_owners, task_watchers,
 * comments, file_attachments, notifications, activities, worklogs,
 * meetings, time_blocks, etc.) is left untouched.
 *
 * Safety gates (all required, in this order):
 *   1. Environment flag: ALLOW_SPECIFIC_PASSWORD_RESET=true
 *   2. Production gate:  if NODE_ENV=production, you must ALSO pass
 *                        --allow-production explicitly. Without it the
 *                        script aborts before opening any DB session.
 *   3. Email allowlist:  every --email argument must look like a
 *                        recovery-eligible target (substring match
 *                        against the built-in NAME_ALLOWLIST). Override
 *                        with --allow-any if you need to recover a
 *                        third user — but you must justify it explicitly.
 *   4. Execute gate:     by default the script is DRY-RUN. Pass
 *                        --execute (or --yes) to actually write.
 *
 * Idempotency:
 *   Re-running the script on the same emails simply rotates the reset
 *   token (the password is already NULL the second time around, so that
 *   write is a no-op). This is the same shape as a user clicking
 *   "Forgot password" twice in a row.
 *
 * Usage (PowerShell, from server/):
 *   $env:ALLOW_SPECIFIC_PASSWORD_RESET="true"
 *   node scripts/reset-specific-user-passwords.js `
 *     --email mehta.sunny@anistonav.com `
 *     --email rawat.muskan@anistonav.com
 *   # ^ defaults to DRY-RUN. Add --execute to actually apply the change.
 *
 * Usage (bash, from server/):
 *   ALLOW_SPECIFIC_PASSWORD_RESET=true node scripts/reset-specific-user-passwords.js \
 *     --email mehta.sunny@anistonav.com \
 *     --email rawat.muskan@anistonav.com \
 *     --execute
 *
 * Production (Docker, manual one-shot):
 *   docker exec -i <server-container> sh -c "\
 *     ALLOW_SPECIFIC_PASSWORD_RESET=true \
 *     node scripts/reset-specific-user-passwords.js \
 *       --email mehta.sunny@anistonav.com \
 *       --email rawat.muskan@anistonav.com \
 *       --allow-production --execute"
 *
 * Production (Docker, one-time-via-deploy with strict validation + DB marker):
 *   This is the form invoked by .github/workflows/deploy.yml when the
 *   RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN repo variable is "true".
 *
 *   docker exec -i aph-backend sh -c "\
 *     ALLOW_SPECIFIC_PASSWORD_RESET=true \
 *     node scripts/reset-specific-user-passwords.js \
 *       --email mehta.sunny@anistonav.com \
 *       --email rawat.muskan@anistonav.com \
 *       --expected-email mehta.sunny@anistonav.com \
 *       --expected-email rawat.muskan@anistonav.com \
 *       --require-exact-count 2 \
 *       --client-url https://monday.anistonav.com \
 *       --maintenance-key password-reset-sunny-muskan-2026-05 \
 *       --executed-by github-actions \
 *       --ttl-hours 4 \
 *       --allow-production --execute"
 *
 *   The --maintenance-key flag uses a small system_maintenance_runs table
 *   (auto-created on first use) to record completion. Re-running the same
 *   key short-circuits with exit 0 and prints "already completed", so the
 *   deployment workflow can leave the env var on without ever resetting a
 *   second time.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const crypto = require('crypto');
const { sequelize } = require('../config/db');
require('../models'); // wires associations
const User = require('../models/User');

// ── Built-in name allowlist ───────────────────────────────────────────────
// An email passes if it contains at least one of these substrings (lowercase).
// This is a guardrail, not the auth boundary — the actual targets are still
// the explicit --email arguments. Override with --allow-any for genuine
// one-offs (and explain why in your runbook).
const NAME_ALLOWLIST = ['sunny', 'muskan'];

const TOKEN_TTL_HOURS_DEFAULT = 24;

function abort(reason, code = 2) {
  console.error(`[reset-specific-user-passwords] REFUSED: ${reason}`);
  process.exit(code);
}

function takeValue(argv, i, name) {
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) abort(`${name} requires a value.`);
  return v.trim();
}

function parseArgs(argv) {
  const args = {
    emails: [],
    expectedEmails: [],
    requireExactCount: null, // null = no check
    clientUrl: null, // null = use process.env.CLIENT_URL
    allowLocalhostUrl: false,
    maintenanceKey: null,
    executedBy: null,
    execute: false,
    allowAny: false,
    allowProduction: false,
    ttlHours: TOKEN_TTL_HOURS_DEFAULT,
    showUrls: true,
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--email') {
      args.emails.push(takeValue(argv, i, '--email').toLowerCase());
      i += 1;
    } else if (a.startsWith('--email=')) {
      args.emails.push(a.slice('--email='.length).trim().toLowerCase());
    } else if (a === '--expected-email') {
      args.expectedEmails.push(takeValue(argv, i, '--expected-email').toLowerCase());
      i += 1;
    } else if (a.startsWith('--expected-email=')) {
      args.expectedEmails.push(a.slice('--expected-email='.length).trim().toLowerCase());
    } else if (a === '--require-exact-count') {
      const v = parseInt(takeValue(argv, i, '--require-exact-count'), 10);
      if (!Number.isFinite(v) || v <= 0 || v > 50) abort('--require-exact-count must be 1..50.');
      args.requireExactCount = v;
      i += 1;
    } else if (a.startsWith('--require-exact-count=')) {
      const v = parseInt(a.slice('--require-exact-count='.length), 10);
      if (!Number.isFinite(v) || v <= 0 || v > 50) abort('--require-exact-count must be 1..50.');
      args.requireExactCount = v;
    } else if (a === '--client-url') {
      args.clientUrl = takeValue(argv, i, '--client-url');
      i += 1;
    } else if (a.startsWith('--client-url=')) {
      args.clientUrl = a.slice('--client-url='.length).trim();
    } else if (a === '--allow-localhost-url') {
      args.allowLocalhostUrl = true;
    } else if (a === '--maintenance-key') {
      args.maintenanceKey = takeValue(argv, i, '--maintenance-key');
      i += 1;
    } else if (a.startsWith('--maintenance-key=')) {
      args.maintenanceKey = a.slice('--maintenance-key='.length).trim();
    } else if (a === '--executed-by') {
      args.executedBy = takeValue(argv, i, '--executed-by');
      i += 1;
    } else if (a.startsWith('--executed-by=')) {
      args.executedBy = a.slice('--executed-by='.length).trim();
    } else if (a === '--execute' || a === '--yes') {
      args.execute = true;
    } else if (a === '--allow-any') {
      args.allowAny = true;
    } else if (a === '--allow-production') {
      args.allowProduction = true;
    } else if (a === '--ttl-hours') {
      const v = parseInt(takeValue(argv, i, '--ttl-hours'), 10);
      if (!Number.isFinite(v) || v <= 0 || v > 168) abort('--ttl-hours must be 1..168.');
      args.ttlHours = v;
      i += 1;
    } else if (a.startsWith('--ttl-hours=')) {
      const v = parseInt(a.slice('--ttl-hours='.length), 10);
      if (!Number.isFinite(v) || v <= 0 || v > 168) abort('--ttl-hours must be 1..168.');
      args.ttlHours = v;
    } else if (a === '--no-urls') {
      args.showUrls = false;
    } else {
      abort(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function isLocalhostUrl(u) {
  if (!u) return true;
  return /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(u);
}

async function ensureMaintenanceTable() {
  // Auto-create the marker table on first use. PostgreSQL 13+ ships
  // gen_random_uuid() in the core, so no extension is required on PG 16.
  // CREATE TABLE IF NOT EXISTS is a no-op on subsequent runs.
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS system_maintenance_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      executed_by VARCHAR(255),
      metadata JSONB
    );
  `);
}

async function maintenanceMarkerExists(key) {
  const [rows] = await sequelize.query(
    'SELECT id, executed_at, executed_by FROM system_maintenance_runs WHERE key = $1 LIMIT 1',
    { bind: [key] }
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

async function insertMaintenanceMarker({ key, executedBy, metadata, transaction }) {
  await sequelize.query(
    `INSERT INTO system_maintenance_runs (key, executed_by, metadata)
     VALUES ($1, $2, $3::jsonb)`,
    {
      bind: [key, executedBy || null, JSON.stringify(metadata || {})],
      transaction,
    }
  );
}

function printHelp() {
  console.log(`
Usage:
  ALLOW_SPECIFIC_PASSWORD_RESET=true \\
  node scripts/reset-specific-user-passwords.js \\
    --email <user1@domain> [--email <user2@domain> ...] \\
    [--execute] [--allow-any] [--allow-production] [--ttl-hours N] [--no-urls] \\
    [--expected-email <addr>] [--require-exact-count N] \\
    [--client-url <url>] [--allow-localhost-url] \\
    [--maintenance-key <key>] [--executed-by <label>]

Defaults to DRY-RUN. Pass --execute to actually apply.

Required env:
  ALLOW_SPECIFIC_PASSWORD_RESET=true   Hard safety flag.

Core flags:
  --email <addr>             Target email. Repeat for multiple users.
  --execute, --yes           Actually write to the DB. Without this it dry-runs.
  --allow-any                Skip the built-in name allowlist (sunny, muskan).
  --allow-production         Required if NODE_ENV=production.
  --ttl-hours N              Reset token lifetime in hours (default 24, max 168).
  --no-urls                  Suppress reset URL in stdout (for piping/logging).
                             The token is still generated.

Strict-deployment flags (recommended for CI/CD):
  --expected-email <addr>    The set of resolved users must equal the SET of
                             --expected-email arguments. Repeat per user.
                             Catches accidental email-typo / wrong-account.
  --require-exact-count N    The DB lookup must resolve to exactly N rows.
                             Catches "someone added a third matching user".
  --client-url <url>         Override CLIENT_URL for the printed reset URLs.
                             In production NODE_ENV the URL must NOT be
                             localhost/127.0.0.1/0.0.0.0 (override with
                             --allow-localhost-url at your own risk).
  --maintenance-key <key>    Insert a one-time row into system_maintenance_runs.
                             If a row with this key already exists, the script
                             exits 0 with "already completed — skipping" so
                             repeat deploys are safe no-ops. Auto-creates the
                             table on first run.
  --executed-by <label>      Free-form label stored in the marker row
                             (e.g. github-actions, ops@anistonav.com).
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // ── Safety gate 1: the env flag ────────────────────────────────────────
  if (process.env.ALLOW_SPECIFIC_PASSWORD_RESET !== 'true') {
    abort(
      'Missing safety flag. Re-run with ALLOW_SPECIFIC_PASSWORD_RESET=true in your environment.\n' +
        '  PowerShell: $env:ALLOW_SPECIFIC_PASSWORD_RESET="true"; node scripts/reset-specific-user-passwords.js ...\n' +
        '  bash:       ALLOW_SPECIFIC_PASSWORD_RESET=true node scripts/reset-specific-user-passwords.js ...'
    );
  }

  // ── Safety gate 2: production requires explicit opt-in ────────────────
  if (process.env.NODE_ENV === 'production' && !args.allowProduction) {
    abort(
      'NODE_ENV=production. Re-run with --allow-production to explicitly authorize a production reset.'
    );
  }

  // ── Safety gate 3: at least one email, all in the allowlist ───────────
  if (args.emails.length === 0) {
    abort('No --email targets provided. Pass at least one --email <addr>.');
  }
  // De-duplicate — repeating the same email would otherwise look like two updates.
  args.emails = [...new Set(args.emails)];

  if (!args.allowAny) {
    const offenders = args.emails.filter(
      (e) => !NAME_ALLOWLIST.some((needle) => e.includes(needle))
    );
    if (offenders.length > 0) {
      abort(
        `These emails do not match the built-in name allowlist [${NAME_ALLOWLIST.join(
          ', '
        )}]: ${offenders.join(', ')}\n` +
          '  Pass --allow-any to override (and document why in your runbook).'
      );
    }
  }

  // ── Resolve the effective CLIENT_URL and validate it ──────────────────
  // Precedence: --client-url flag > process.env.CLIENT_URL > localhost default.
  const effectiveClientUrl =
    args.clientUrl || process.env.CLIENT_URL || 'http://localhost:3000';

  if (
    process.env.NODE_ENV === 'production' &&
    !args.allowLocalhostUrl &&
    isLocalhostUrl(effectiveClientUrl)
  ) {
    abort(
      `CLIENT_URL resolves to "${effectiveClientUrl}" but NODE_ENV=production. ` +
        `Set CLIENT_URL to your real public origin (e.g. https://monday.anistonav.com) ` +
        `or pass --client-url, or pass --allow-localhost-url to override at your own risk.`
    );
  }

  // ── Print environment summary BEFORE touching anything ────────────────
  console.log('[reset-specific-user-passwords] Environment summary:');
  console.log(`  NODE_ENV         : ${process.env.NODE_ENV || '(unset)'}`);
  console.log(`  DB_HOST          : ${process.env.DB_HOST || 'localhost'}`);
  console.log(`  DB_NAME          : ${process.env.DB_NAME || 'aniston_project_hub'}`);
  console.log(`  CLIENT_URL (env) : ${process.env.CLIENT_URL || '(unset)'}`);
  console.log(`  CLIENT_URL (used): ${effectiveClientUrl}`);
  console.log(`  Targets          : ${args.emails.join(', ')}`);
  if (args.expectedEmails.length > 0) {
    console.log(`  Expected emails  : ${args.expectedEmails.join(', ')}`);
  }
  if (args.requireExactCount !== null) {
    console.log(`  Require count    : exactly ${args.requireExactCount}`);
  }
  if (args.maintenanceKey) {
    console.log(`  Maintenance key  : ${args.maintenanceKey}`);
  }
  console.log(`  Executed by      : ${args.executedBy || '(unset)'}`);
  console.log(`  TTL hours        : ${args.ttlHours}`);
  console.log(`  Mode             : ${args.execute ? 'EXECUTE (writes)' : 'DRY-RUN (read-only)'}`);
  console.log('');

  // ── Connect ───────────────────────────────────────────────────────────
  try {
    await sequelize.authenticate();
  } catch (err) {
    console.error('[reset-specific-user-passwords] DB connect failed:', err.message);
    process.exit(1);
  }
  console.log('[reset-specific-user-passwords] Connected to database.');

  // ── Maintenance marker: short-circuit on a successful past run ────────
  // This runs BEFORE the user lookup so a re-deploy is cheap and obviously
  // safe. We auto-create the table here so a first-time deploy works.
  if (args.maintenanceKey) {
    try {
      await ensureMaintenanceTable();
    } catch (err) {
      console.error(
        '[reset-specific-user-passwords] Failed to ensure system_maintenance_runs table:',
        err.message
      );
      process.exit(1);
    }
    const existing = await maintenanceMarkerExists(args.maintenanceKey);
    if (existing) {
      console.log('');
      console.log(
        `[reset-specific-user-passwords] Maintenance key "${args.maintenanceKey}" already executed at ` +
          `${new Date(existing.executed_at).toISOString()} by "${existing.executed_by || '(unknown)'}".`
      );
      console.log('[reset-specific-user-passwords] Already completed — skipping.');
      console.log(
        '  ↑ This is the safe re-run path. Disable RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN'
      );
      console.log('    in your CI variables to keep deployment logs quieter.');
      await sequelize.close();
      process.exit(0);
    }
  }

  // ── Look up every target FIRST so we can fail before any write ────────
  // We use findAll (not findOne) so duplicate-email anomalies surface
  // explicitly instead of silently picking one row.
  const lookups = [];
  for (const email of args.emails) {
    const matches = await User.findAll({ where: { email } });
    lookups.push({ email, matches });
  }

  let hadFatal = false;
  for (const { email, matches } of lookups) {
    if (matches.length === 0) {
      console.error(`  ✗ ${email}: NOT FOUND in users table.`);
      hadFatal = true;
    } else if (matches.length > 1) {
      console.error(
        `  ✗ ${email}: ${matches.length} rows match — duplicate email constraint violated. ` +
          `Investigate manually before re-running. Ids: [${matches.map((u) => u.id).join(', ')}]`
      );
      hadFatal = true;
    } else {
      const u = matches[0];
      console.log(
        `  ✓ ${email}: id=${u.id} name="${u.name}" authProvider=${u.authProvider} ` +
          `hasLocalPassword=${u.hasLocalPassword} hasPasswordHash=${!!u.password} ` +
          `hasResetTokenAlready=${!!u.passwordResetToken} active=${u.isActive} ` +
          `accountStatus=${u.accountStatus}`
      );
    }
  }

  if (hadFatal) {
    abort('One or more targets could not be resolved cleanly. No writes performed.', 3);
  }

  // ── Strict-deployment validation: exact-count and expected-email set ──
  if (args.requireExactCount !== null && lookups.length !== args.requireExactCount) {
    abort(
      `--require-exact-count expected ${args.requireExactCount} target(s) but ${lookups.length} were resolved. ` +
        `No writes performed.`,
      4
    );
  }

  if (args.expectedEmails.length > 0) {
    const expectedSet = new Set(args.expectedEmails);
    const resolvedSet = new Set(lookups.map((l) => l.email));
    const unexpected = [...resolvedSet].filter((e) => !expectedSet.has(e));
    const missing = [...expectedSet].filter((e) => !resolvedSet.has(e));
    if (unexpected.length > 0 || missing.length > 0 || expectedSet.size !== resolvedSet.size) {
      abort(
        `Resolved emails do not match the --expected-email set. ` +
          `Expected: [${[...expectedSet].sort().join(', ')}]. ` +
          `Resolved: [${[...resolvedSet].sort().join(', ')}]. ` +
          (unexpected.length > 0 ? `Unexpected: [${unexpected.join(', ')}]. ` : '') +
          (missing.length > 0 ? `Missing: [${missing.join(', ')}]. ` : '') +
          `No writes performed.`,
        4
      );
    }
  }

  if (!args.execute) {
    console.log('');
    console.log(
      '[reset-specific-user-passwords] DRY-RUN complete. Re-run with --execute to apply.'
    );
    await sequelize.close();
    process.exit(0);
  }

  // ── Apply changes inside a single transaction ─────────────────────────
  console.log('');
  console.log('[reset-specific-user-passwords] Applying changes inside a transaction...');

  const clientUrl = effectiveClientUrl;
  const ttlMs = args.ttlHours * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);
  const reports = [];

  const tx = await sequelize.transaction();
  try {
    // If a maintenance key was provided, re-check inside the transaction
    // (defense against TOCTOU between the earlier check and this point).
    // The UNIQUE constraint on `key` is the actual race-safe guarantee;
    // this read is for a clean error message.
    if (args.maintenanceKey) {
      const [rows] = await sequelize.query(
        'SELECT id FROM system_maintenance_runs WHERE key = $1 LIMIT 1',
        { bind: [args.maintenanceKey], transaction: tx }
      );
      if (rows && rows.length > 0) {
        throw new Error(
          `Maintenance key "${args.maintenanceKey}" was inserted by a concurrent run.`
        );
      }
    }

    for (const { email, matches } of lookups) {
      const user = matches[0];

      // Generate per-user token. We generate the raw token here, hash it
      // with sha256, and store ONLY the hash — exactly what
      // controllers/authController.js#forgotPassword does.
      const rawToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

      // Use bulk-update with hooks: false so the User.beforeUpdate hook
      // does NOT try to bcrypt.hash(null) when we set password=null.
      await User.update(
        {
          password: null,
          hasLocalPassword: false,
          passwordResetToken: hashedToken,
          passwordResetExpires: expiresAt,
        },
        {
          where: { id: user.id },
          hooks: false,
          transaction: tx,
        }
      );

      reports.push({
        email,
        userId: user.id,
        name: user.name,
        resetUrl: `${clientUrl}/reset-password?token=${rawToken}`,
      });
    }

    // Insert the maintenance marker INSIDE the same transaction so either
    // both the password updates AND the marker land, or neither does.
    if (args.maintenanceKey) {
      await insertMaintenanceMarker({
        key: args.maintenanceKey,
        executedBy: args.executedBy,
        metadata: {
          targets: lookups.map(({ email, matches }) => ({
            email,
            userId: matches[0].id,
          })),
          ttlHours: args.ttlHours,
          expiresAt: expiresAt.toISOString(),
          clientUrl,
          nodeEnv: process.env.NODE_ENV || null,
          dbHost: process.env.DB_HOST || null,
          dbName: process.env.DB_NAME || null,
        },
        transaction: tx,
      });
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    console.error('[reset-specific-user-passwords] Transaction rolled back:', err.message);
    try {
      await sequelize.close();
    } catch (_) {
      // ignore
    }
    process.exit(1);
  }

  // ── Verify post-state ─────────────────────────────────────────────────
  console.log('');
  console.log('[reset-specific-user-passwords] Post-state verification:');
  for (const r of reports) {
    const u = await User.findByPk(r.userId);
    const ok =
      u &&
      u.password === null &&
      u.hasLocalPassword === false &&
      typeof u.passwordResetToken === 'string' &&
      u.passwordResetToken.length === 64 && // sha256 hex
      u.passwordResetExpires instanceof Date &&
      u.passwordResetExpires.getTime() > Date.now();
    console.log(
      `  ${ok ? '✓' : '✗'} ${r.email}: password=${u && u.password === null ? 'NULL' : '(SET!)'} ` +
        `hasLocalPassword=${u ? u.hasLocalPassword : '?'} ` +
        `tokenLen=${u && u.passwordResetToken ? u.passwordResetToken.length : 0} ` +
        `expires=${u && u.passwordResetExpires ? u.passwordResetExpires.toISOString() : '(none)'}`
    );
    if (!ok) {
      console.error('    ↑ verification failed — this user did not reach the expected state.');
    }
  }

  // ── Print the reset URLs once. Do NOT log them to a file. ─────────────
  console.log('');
  console.log('[reset-specific-user-passwords] Hand each user the matching link below over a');
  console.log('  secure channel. Each link is single-use and expires at:');
  console.log(`    ${expiresAt.toISOString()}  (in ${args.ttlHours} hours)`);
  console.log('');
  for (const r of reports) {
    if (args.showUrls) {
      console.log(`  ${r.email}  →`);
      console.log(`    ${r.resetUrl}`);
    } else {
      console.log(`  ${r.email}  → (URL suppressed by --no-urls; token generated)`);
    }
  }
  console.log('');
  console.log('After the user opens their link they will be taken to /reset-password,');
  console.log('where the existing flow will set a new password and re-flip');
  console.log('has_local_password back to true. Microsoft SSO continues to work');
  console.log('throughout — only local-password login is affected.');

  await sequelize.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[reset-specific-user-passwords] FATAL:', err);
  try {
    sequelize.close();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
