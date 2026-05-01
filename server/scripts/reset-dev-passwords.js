/**
 * Dev-only password reset for known local test accounts.
 *
 * Why this exists:
 *   Test/MCP automation occasionally needs to log in as Super Admin or as a
 *   member account whose password isn't documented. Running ad-hoc bcrypt
 *   updates from a one-shot `node -e` is brittle (working-directory issues
 *   make `require('bcryptjs')` fail when run from the repo root because
 *   bcryptjs lives under server/node_modules). This script runs from the
 *   correct cwd and uses the model's beforeUpdate hook so hashing matches
 *   what login expects (bcryptjs, 12 salt rounds).
 *
 * Safety:
 *   - Refuses to run if NODE_ENV === 'production'.
 *   - Refuses unless ALLOW_DEV_PASSWORD_RESET=true is set in the environment.
 *   - Only touches password + the strict minimum of fields needed for login
 *     (has_local_password when authProvider='microsoft'). Does NOT change
 *     role, isSuperAdmin, hierarchy, permissions, accountStatus, isActive,
 *     or any unrelated columns.
 *   - Targets a hard-coded allowlist of local dev emails. Adding/removing
 *     accounts requires editing this file (intentional friction).
 *   - Logs which users were updated by name+email; never logs hashes.
 *
 * Usage (from repo root, Windows PowerShell):
 *
 *   $env:ALLOW_DEV_PASSWORD_RESET="true"; npm --prefix server run reset:dev-passwords
 *
 * Or from inside server/:
 *
 *   $env:ALLOW_DEV_PASSWORD_RESET="true"; npm run reset:dev-passwords
 *
 * After running, restart the backend (so any in-memory caches refresh) and
 * use the credentials printed at the top of the output.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');
require('../models'); // wires associations
const User = require('../models/User');

// Allowlist of accounts this script may reset. Hard-coded by design — the
// script is for known local dev users only, not a generic password tool.
const DEV_ACCOUNTS = [
  {
    email: 'superadmin@anistonav.com',
    label: 'Super Admin',
    // Matches the original seed password in server/seed-users.js so a fresh
    // seed and a re-run of this script land on the same credentials.
    password: 'Anistonav@1234',
  },
  {
    email: 'mehta.sunny@anistonav.com',
    label: 'Sunny Mehta (member)',
    password: 'Member@12345',
  },
];

function abort(reason) {
  console.error(`[reset-dev-passwords] REFUSED: ${reason}`);
  process.exit(2);
}

(async () => {
  // ── Safety gates ─────────────────────────────────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    abort('NODE_ENV=production. This script will never run against production.');
  }
  if (process.env.ALLOW_DEV_PASSWORD_RESET !== 'true') {
    abort(
      'Missing safety flag. Re-run with ALLOW_DEV_PASSWORD_RESET=true in your environment.\n' +
      '  PowerShell: $env:ALLOW_DEV_PASSWORD_RESET="true"; npm --prefix server run reset:dev-passwords'
    );
  }

  try {
    await sequelize.authenticate();
    console.log('[reset-dev-passwords] Connected to database.');
    console.log(`[reset-dev-passwords] Target accounts: ${DEV_ACCOUNTS.length}`);

    let updated = 0;
    let missing = 0;

    for (const acct of DEV_ACCOUNTS) {
      const user = await User.findOne({ where: { email: acct.email } });
      if (!user) {
        console.warn(`[reset-dev-passwords]   - SKIPPED (not in DB): ${acct.label} <${acct.email}>`);
        missing += 1;
        continue;
      }

      // Build the patch. Always reset password. For Microsoft-provisioned
      // accounts we also need has_local_password=true so the login flow
      // actually checks the password hash (see authController login: it
      // returns "Invalid email or password" for microsoft users without a
      // local password regardless of how good the hash is).
      const patch = { password: acct.password };
      if (user.authProvider === 'microsoft' && !user.hasLocalPassword) {
        patch.hasLocalPassword = true;
      }

      // .update() goes through beforeUpdate, which calls bcrypt.hash(pw, 12).
      // Important: do NOT use raw queries here — that would skip hashing and
      // leave a plaintext password in the password column.
      await user.update(patch);

      updated += 1;
      console.log(`[reset-dev-passwords]   - RESET: ${acct.label} <${acct.email}>`);
    }

    console.log('');
    console.log('[reset-dev-passwords] Summary');
    console.log(`  Updated: ${updated}`);
    console.log(`  Missing: ${missing}`);
    console.log('');
    console.log('Use these credentials to log in (DEV ONLY):');
    for (const a of DEV_ACCOUNTS) {
      console.log(`  ${a.label.padEnd(22)} ${a.email.padEnd(34)}  password: ${a.password}`);
    }
    console.log('');
    console.log('If you have a stale browser session, log out (or clear sessionStorage) before signing back in.');

    await sequelize.close();
    process.exit(updated > 0 ? 0 : 1);
  } catch (err) {
    console.error('[reset-dev-passwords] FAILED:', err.message);
    try { await sequelize.close(); } catch (_) {}
    process.exit(1);
  }
})();
