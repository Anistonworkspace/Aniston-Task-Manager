/**
 * Verifies the patched SSO user-resolution logic against the live DB.
 *
 * This does NOT call Microsoft. It replicates the same resolution rules that
 * `microsoftCallback` now uses (OID-first, email fallback, conflict detection)
 * and runs them against scenarios for the actual users in the database. The
 * point is to prove that the patched logic returns the correct user for each
 * scenario — including the original bug case (Sunny's SSO must NOT resolve
 * to Super Admin).
 *
 * Run with:
 *   node server/scripts/verify-sso-resolution.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');
require('../models');
const User = require('../models/User');

// Mirrors the resolution rules in authController.microsoftCallback (post-fix).
async function resolveSsoUser({ email, oid }) {
  const result = { user: null, matchedBy: null, error: null };

  if (oid) {
    const oidMatches = await User.findAll({ where: { teamsUserId: oid } });
    if (oidMatches.length > 1) {
      result.error = `multiple_users_share_oid (${oidMatches.length})`;
      return result;
    }
    if (oidMatches.length === 1) {
      const candidate = oidMatches[0];
      if ((candidate.email || '').toLowerCase() !== (email || '').toLowerCase()) {
        result.error = `oid_email_mismatch (db=${candidate.email}, sso=${email})`;
        return result;
      }
      result.user = candidate;
      result.matchedBy = 'oid';
      return result;
    }
  }

  const emailMatches = await User.findAll({ where: { email: (email || '').toLowerCase() } });
  if (emailMatches.length > 1) {
    result.error = `duplicate_emails (${emailMatches.length})`;
    return result;
  }
  if (emailMatches.length === 1) {
    const candidate = emailMatches[0];
    if (candidate.teamsUserId && oid && candidate.teamsUserId !== oid) {
      result.error = 'email_already_linked_to_different_oid';
      return result;
    }
    result.user = candidate;
    result.matchedBy = 'email';
    return result;
  }

  result.matchedBy = 'would_create_new';
  return result;
}

const SUNNY_OID = 'a09a78XX-XXXX-XXXX-XXXX-XXXXXXXX3355'; // placeholder; we'll look it up
const SCENARIOS = [
  // The original bug case: Sunny's SSO identity. With the data fix applied,
  // OID is now only on Sunny's row. With the code fix, lookup is OID-first.
  // EXPECTED: matchedBy='oid', user=Sunny, role='member'.
  {
    name: 'Sunny Mehta SSO (original bug case)',
    sso: { email: 'mehta.sunny@anistonav.com', oid: '__USE_SUNNY_OID__' },
    expect: { matchedBy: 'oid', email: 'mehta.sunny@anistonav.com', isSuperAdmin: false },
  },
  // Super Admin's email arrives with NO OID — first-time link path.
  // EXPECTED: matchedBy='email', user=Super Admin, role='admin'.
  {
    name: 'Super Admin email-only (no OID)',
    sso: { email: 'superadmin@anistonav.com', oid: '' },
    expect: { matchedBy: 'email', email: 'superadmin@anistonav.com', isSuperAdmin: true },
  },
  // Attacker scenario: someone else's id_token brings Sunny's email but a fake OID.
  // With the patched logic, the fake OID does not match anyone, then email matches
  // Sunny — but Sunny already has a different teamsUserId, so the fix REJECTS.
  // EXPECTED: error='email_already_linked_to_different_oid'.
  {
    name: 'Spoofed OID with Sunny email (must reject)',
    sso: { email: 'mehta.sunny@anistonav.com', oid: '11111111-2222-3333-4444-555555555555' },
    expect: { error: 'email_already_linked_to_different_oid' },
  },
  // Brand-new SSO user: nobody in DB.
  // EXPECTED: matchedBy='would_create_new'.
  {
    name: 'Brand-new SSO user',
    sso: { email: 'new.user@anistonav.com', oid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    expect: { matchedBy: 'would_create_new' },
  },
  // Mixed-case email: must normalise.
  // EXPECTED: matched via OID for Sunny.
  {
    name: 'Mixed-case email (normalised)',
    sso: { email: 'Mehta.Sunny@anistonav.com', oid: '__USE_SUNNY_OID__' },
    expect: { matchedBy: 'oid', email: 'mehta.sunny@anistonav.com' },
  },
];

(async () => {
  await sequelize.authenticate();

  // Resolve Sunny's actual OID from the DB so the test mirrors reality.
  const sunny = await User.findOne({ where: { email: 'mehta.sunny@anistonav.com' } });
  if (!sunny || !sunny.teamsUserId) {
    console.error('Sunny user not found or has no teamsUserId in DB — cannot run verification.');
    process.exit(1);
  }
  const sunnyOid = sunny.teamsUserId;
  console.log(`Using real Sunny OID from DB for tests: ${sunnyOid.slice(0, 6)}…${sunnyOid.slice(-4)}\n`);

  let passed = 0;
  let failed = 0;
  for (const s of SCENARIOS) {
    const oid = s.sso.oid === '__USE_SUNNY_OID__' ? sunnyOid : s.sso.oid;
    const r = await resolveSsoUser({ email: s.sso.email, oid });

    const got = {
      matchedBy: r.matchedBy,
      email: r.user?.email,
      isSuperAdmin: r.user?.isSuperAdmin,
      error: r.error,
    };

    const ok = Object.entries(s.expect).every(([k, v]) => got[k] === v);
    console.log(`${ok ? '✓' : '✗'} ${s.name}`);
    console.log(`    sso  : email=${s.sso.email}, oid=${oid ? oid.slice(0, 6) + '…' : '∅'}`);
    console.log(`    got  : ${JSON.stringify(got)}`);
    console.log(`    want : ${JSON.stringify(s.expect)}`);
    console.log('');
    if (ok) passed += 1; else failed += 1;
  }

  console.log(`Summary: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 2);
})();
