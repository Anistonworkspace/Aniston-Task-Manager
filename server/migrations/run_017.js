/**
 * run_017.js — Backfill: encrypt at-rest Microsoft Teams OAuth tokens.
 *
 * Migrates User.teamsAccessToken and User.teamsRefreshToken from plaintext
 * to AES-256-GCM ciphertext (format: iv_hex:authTag_hex:ciphertext_hex),
 * using server/utils/encryption.js.
 *
 * Idempotent. Already-encrypted rows are skipped. Re-running prints a
 * summary with zero plaintext rows once the backfill has completed.
 *
 * Usage (in container):
 *   docker exec aph-backend node migrations/run_017.js
 *
 * Production gate (must be set explicitly to acknowledge the operation):
 *   ALLOW_PROD_TEAMS_TOKEN_ENCRYPT_BACKFILL=true
 *
 * Required env:
 *   ENCRYPTION_KEY  (64-char hex, AES-256)
 *   DB_*            (same as the app)
 *
 * This script is NOT invoked from server.js at boot. It must be run
 * manually during a maintenance window after the code change that
 * starts writing encrypted tokens has been deployed.
 */

require('dotenv').config();

const { sequelize } = require('../config/db');
const { User } = require('../models');
const {
  encryptTeamsToken,
  isEncryptedTeamsToken,
} = require('../utils/teamsTokenStorage');

const PROD_GATE = 'ALLOW_PROD_TEAMS_TOKEN_ENCRYPT_BACKFILL';

function preflightBanner() {
  /* eslint-disable no-console */
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  Migration 017 — Encrypt Teams OAuth tokens at rest');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  This script will rewrite users.teamsAccessToken and');
  console.log('  users.teamsRefreshToken in place: plaintext → AES-256-GCM ciphertext.');
  console.log('');
  console.log('  SAFETY CHECKLIST:');
  console.log('    [ ] You have a fresh pg_dump snapshot of the users table.');
  console.log('    [ ] ENCRYPTION_KEY is set and is the SAME key the app uses at runtime.');
  console.log('         (If keys diverge, every encrypted token becomes unreadable.)');
  console.log('    [ ] Code is already deployed with:');
  console.log('         - writes wrapped in encryptTeamsToken()');
  console.log('         - reads wrapped in decryptTeamsTokenSafe() (dual-path).');
  console.log('    [ ] You are running this in a maintenance window OR you have');
  console.log('         verified that the dual-path reader keeps live traffic safe.');
  console.log('');
  console.log('  This script is idempotent: already-encrypted rows are skipped.');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('');
  /* eslint-enable no-console */
}

async function run() {
  preflightBanner();

  if (process.env.NODE_ENV === 'production' && process.env[PROD_GATE] !== 'true') {
    console.error(
      `[run_017] Refusing to run in production without ${PROD_GATE}=true. ` +
      'Set the env var to confirm you have taken a pg_dump and intend to proceed.'
    );
    process.exit(2);
  }

  if (!process.env.ENCRYPTION_KEY) {
    console.error('[run_017] ENCRYPTION_KEY is not set. Aborting.');
    process.exit(3);
  }

  try {
    await sequelize.authenticate();
  } catch (err) {
    console.error('[run_017] Database connection failed:', err.message);
    process.exit(4);
  }

  let scanned = 0;
  let accessEncrypted = 0;
  let refreshEncrypted = 0;
  let accessSkipped = 0;
  let refreshSkipped = 0;
  let rowsUpdated = 0;
  let errored = 0;

  // Stream candidates: any user with at least one non-NULL token field.
  const { Op } = require('sequelize');
  const users = await User.findAll({
    where: {
      [Op.or]: [
        { teamsAccessToken: { [Op.ne]: null } },
        { teamsRefreshToken: { [Op.ne]: null } },
      ],
    },
    attributes: ['id', 'email', 'teamsAccessToken', 'teamsRefreshToken'],
  });

  console.log(`[run_017] Candidate users with non-NULL token columns: ${users.length}`);

  for (const u of users) {
    scanned += 1;
    const updates = {};

    try {
      if (u.teamsAccessToken) {
        if (isEncryptedTeamsToken(u.teamsAccessToken)) {
          accessSkipped += 1;
        } else {
          updates.teamsAccessToken = encryptTeamsToken(u.teamsAccessToken);
          accessEncrypted += 1;
        }
      }

      if (u.teamsRefreshToken) {
        if (isEncryptedTeamsToken(u.teamsRefreshToken)) {
          refreshSkipped += 1;
        } else {
          updates.teamsRefreshToken = encryptTeamsToken(u.teamsRefreshToken);
          refreshEncrypted += 1;
        }
      }

      if (Object.keys(updates).length > 0) {
        await u.update(updates);
        rowsUpdated += 1;
        console.log(
          `[run_017] Encrypted user=${u.id} (${u.email}) ` +
            `[${updates.teamsAccessToken ? 'access' : ''}` +
            `${updates.teamsAccessToken && updates.teamsRefreshToken ? '+' : ''}` +
            `${updates.teamsRefreshToken ? 'refresh' : ''}]`
        );
      }
    } catch (err) {
      errored += 1;
      console.error(`[run_017] Failed for user=${u.id} (${u.email}):`, err.message);
    }
  }

  console.log('');
  console.log('───────────────── Migration 017 summary ─────────────────');
  console.log(`  Users scanned                       : ${scanned}`);
  console.log(`  Rows updated                        : ${rowsUpdated}`);
  console.log(`  teamsAccessToken  encrypted (new)   : ${accessEncrypted}`);
  console.log(`  teamsAccessToken  already encrypted : ${accessSkipped}`);
  console.log(`  teamsRefreshToken encrypted (new)   : ${refreshEncrypted}`);
  console.log(`  teamsRefreshToken already encrypted : ${refreshSkipped}`);
  console.log(`  Errors                              : ${errored}`);
  console.log('─────────────────────────────────────────────────────────');
  console.log('');

  if (errored > 0) {
    console.log('[run_017] Completed with errors. Investigate and re-run (idempotent).');
    process.exit(1);
  }

  if (accessEncrypted === 0 && refreshEncrypted === 0) {
    console.log('[run_017] No plaintext rows found. Backfill is already complete.');
  } else {
    console.log(
      '[run_017] Backfill complete. After verifying in every environment, ' +
      'open a follow-up PR to remove the dual-path reader fallback in ' +
      'server/utils/teamsTokenStorage.js (decryptTeamsTokenSafe).'
    );
  }

  process.exit(0);
}

run().catch((err) => {
  console.error('[run_017] Fatal error:', err);
  process.exit(99);
});
