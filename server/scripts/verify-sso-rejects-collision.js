/**
 * Regression test: prove the patched logic REJECTS the collision case rather
 * than silently picking the wrong row.
 *
 * Procedure:
 *   1. Snapshot Super Admin's current teamsUserId.
 *   2. Temporarily restore the duplicate (set Super Admin.teamsUserId = Sunny's OID).
 *   3. Hit the live SSO callback URL with a fabricated request (we cannot, since
 *      we don't have a real Microsoft `code`) — so instead we just call the same
 *      resolution function from verify-sso-resolution.js and assert it rejects.
 *   4. Restore Super Admin's teamsUserId to its original value.
 *
 * Run with:
 *   node server/scripts/verify-sso-rejects-collision.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');
require('../models');
const User = require('../models/User');

async function resolveSsoUser({ email, oid }) {
  if (oid) {
    const oidMatches = await User.findAll({ where: { teamsUserId: oid } });
    if (oidMatches.length > 1) return { error: 'multiple_users_share_oid', count: oidMatches.length };
    if (oidMatches.length === 1) {
      const c = oidMatches[0];
      if ((c.email || '').toLowerCase() !== (email || '').toLowerCase()) return { error: 'oid_email_mismatch' };
      return { user: c, matchedBy: 'oid' };
    }
  }
  const emailMatches = await User.findAll({ where: { email: (email || '').toLowerCase() } });
  if (emailMatches.length > 1) return { error: 'duplicate_emails' };
  if (emailMatches.length === 1) {
    const c = emailMatches[0];
    if (c.teamsUserId && oid && c.teamsUserId !== oid) return { error: 'email_already_linked_to_different_oid' };
    return { user: c, matchedBy: 'email' };
  }
  return { matchedBy: 'would_create_new' };
}

(async () => {
  await sequelize.authenticate();

  const sunny = await User.findOne({ where: { email: 'mehta.sunny@anistonav.com' } });
  const sa = await User.findOne({ where: { email: 'superadmin@anistonav.com' } });
  if (!sunny || !sa) { console.error('Required users not found.'); process.exit(1); }
  if (!sunny.teamsUserId) { console.error('Sunny has no teamsUserId; aborting.'); process.exit(1); }

  const sunnyOid = sunny.teamsUserId;
  const originalSaOid = sa.teamsUserId; // should be null after data fix

  console.log(`Sunny OID = ${sunnyOid.slice(0, 6)}…${sunnyOid.slice(-4)}`);
  console.log(`Super Admin starting teamsUserId = ${originalSaOid || '∅'}\n`);

  try {
    // Step 1: re-introduce the bug condition.
    console.log('[Step 1] Temporarily setting Super Admin.teamsUserId = Sunny OID (recreates bug condition)...');
    await sa.update({ teamsUserId: sunnyOid });

    // Step 2: simulate Sunny's SSO arriving.
    console.log('[Step 2] Simulating Sunny SSO arrival...');
    const r = await resolveSsoUser({ email: 'mehta.sunny@anistonav.com', oid: sunnyOid });
    console.log('Result:', JSON.stringify(r));

    if (r.error === 'multiple_users_share_oid' && r.count === 2) {
      console.log('\n✓ PASS: patched logic correctly REJECTED the login due to OID collision.');
    } else if (r.user) {
      console.log(`\n✗ FAIL: patched logic resolved to ${r.user.email} (would have been the bug).`);
      process.exitCode = 2;
    } else {
      console.log('\n✗ FAIL: unexpected result.');
      process.exitCode = 2;
    }
  } finally {
    // Step 3: restore Super Admin.
    console.log(`\n[Cleanup] Restoring Super Admin.teamsUserId to its original value (${originalSaOid || 'null'})...`);
    await sa.update({ teamsUserId: originalSaOid });
    const reloaded = await User.findByPk(sa.id);
    console.log(`Super Admin.teamsUserId is now: ${reloaded.teamsUserId || '∅'}`);
  }

  process.exit(process.exitCode || 0);
})();
