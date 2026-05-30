'use strict';

/**
 * LOCAL-ONLY test-user seed for the Tier-3 approval bug fix.
 *
 * Creates two test accounts wired up so the Tier-3 user is a sequential
 * approver in the approval chain when the Tier-4 user submits a task:
 *
 *   T3  assistant@aniston.com   /  Assistant@1234   (role: assistant_manager, tier: 3)
 *   T4  member3@aniston.com     /  Member3@1234     (role: member, tier: 4, managerId -> T3)
 *
 * How to test the fix after running this script:
 *   1. Log in as member3@aniston.com — pick or create a task assigned to
 *      yourself on any board you can see, mark it as ready for approval, and
 *      submit it (Submit for Approval).
 *   2. Log out, log in as assistant@aniston.com. Open Approvals & Requests —
 *      the task you just submitted should appear under your pending list with
 *      Approve / Reject / Request Changes buttons. Approve should now succeed
 *      (previously it returned "You do not have permission to perform this
 *      action").
 *
 * ── Production safety ─────────────────────────────────────────────────────
 *
 * This script HARD-REFUSES in production with NO override flag — there is no
 * env-var combination that will let it run when NODE_ENV=production. Pushing
 * this file to main and triggering a deploy will therefore never create these
 * accounts on the production database. To remove the script entirely after
 * testing, just delete the file.
 *
 * Usage:  node server/scripts/seed-tier3-test.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');
require('../models');
const User = require('../models/User');

const NODE_ENV = (process.env.NODE_ENV || 'development').toLowerCase();

if (NODE_ENV === 'production') {
  console.error(
    '[seed-tier3-test] REFUSING to run with NODE_ENV=production. ' +
    'This script is local-only — there is no override.'
  );
  process.exit(1);
}

const T3 = {
  name: 'Tier 3 Test (Asst Manager)',
  email: 'assistant@aniston.com',
  password: 'Assistant@1234',
  role: 'assistant_manager',
  tier: 3,
  department: 'Engineering',
  designation: 'Assistant Manager (Test)',
  hierarchyLevel: 'assistant_manager',
  isActive: true,
  accountStatus: 'approved',
  hasLocalPassword: true,
};

const T4 = {
  name: 'Tier 4 Test (Member)',
  email: 'member3@aniston.com',
  password: 'Member3@1234',
  role: 'member',
  tier: 4,
  department: 'Engineering',
  designation: 'Member (Test)',
  hierarchyLevel: 'member',
  isActive: true,
  accountStatus: 'approved',
  hasLocalPassword: true,
};

const LEGACY_EMAILS_TO_REMOVE = [
  'asstmgr@aniston.local',
  'member3@aniston.local',
];

async function upsertUser(spec) {
  const existing = await User.findOne({ where: { email: spec.email } });
  if (existing) {
    console.log(`[seed-tier3-test] Exists: ${spec.email} (id=${existing.id}, tier=${existing.tier}, role=${existing.role})`);
    return { user: existing, created: false };
  }
  const user = await User.create(spec);
  console.log(`[seed-tier3-test] Created: ${spec.email} (id=${user.id}, tier=${user.tier}, role=${user.role})`);
  return { user, created: true };
}

(async () => {
  try {
    await sequelize.authenticate();
    console.log(`[seed-tier3-test] DB connected. (env=${NODE_ENV})\n`);

    // Best-effort cleanup of an older .local naming used by the first version
    // of this script. Safe to skip if rows don't exist or FKs prevent delete.
    for (const email of LEGACY_EMAILS_TO_REMOVE) {
      const stale = await User.findOne({ where: { email } });
      if (!stale) continue;
      try {
        await stale.destroy();
        console.log(`[seed-tier3-test] Removed legacy account: ${email}`);
      } catch (err) {
        console.log(`[seed-tier3-test] Could not delete legacy ${email} (probably has FK refs); leaving it. (${err.message})`);
      }
    }

    const { user: t3 } = await upsertUser(T3);
    const { user: t4 } = await upsertUser(T4);

    if (t4.managerId !== t3.id) {
      await t4.update({ managerId: t3.id });
      console.log(`[seed-tier3-test] Linked: ${T4.email}.managerId -> ${T3.email}`);
    } else {
      console.log(`[seed-tier3-test] Already linked: ${T4.email}.managerId -> ${T3.email}`);
    }

    console.log('\n[seed-tier3-test] Done.\n');
    console.log('  Tier 3 login:  ' + T3.email + '   /  ' + T3.password);
    console.log('  Tier 4 login:  ' + T4.email + '     /  ' + T4.password);
    console.log('\n  T4 reports to T3 via managerId, so submissions by T4 will');
    console.log('  walk T3 in as a sequential approver in the approval chain.');
    process.exit(0);
  } catch (err) {
    console.error('[seed-tier3-test] Failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
