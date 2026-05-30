// One-shot: ensures the local dev super-admin can log in.
// Target credentials:
//   Email:    superadmin@anistonav.com
//   Password: Anistonav@1234
//
// Run from repo root: node server/scripts/fix-superadmin-login.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/db');
require('../models');
const User = require('../models/User');

const TARGET_EMAIL = process.env.FIX_SUPERADMIN_EMAIL || 'superadmin@anistonav.com';
const TARGET_PASSWORD = process.env.FIX_SUPERADMIN_PASSWORD || 'Anistonav@1234';

// PRODUCTION SAFETY GUARD — this script rewrites a Tier-1 super-admin's email +
// password (and falls back to candidates[0] if the target email is absent, so it
// can hijack an existing prod super-admin). It must NEVER run against production.
// Refuses unless NODE_ENV !== 'production' OR the operator explicitly opts in with
// ALLOW_PROD_SUPERADMIN_FIX=true. There is intentionally no deploy/cron caller.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SUPERADMIN_FIX !== 'true') {
  console.error('[fix-superadmin-login] REFUSING to run with NODE_ENV=production.');
  console.error('[fix-superadmin-login] This rewrites a super-admin\'s credentials. Set ALLOW_PROD_SUPERADMIN_FIX=true to override (and supply FIX_SUPERADMIN_PASSWORD).');
  process.exit(1);
}

(async () => {
  try {
    // Find any existing Tier-1 super-admin, regardless of email.
    const candidates = await User.findAll({ where: { isSuperAdmin: true } });
    console.log(`Found ${candidates.length} super-admin user(s).`);
    for (const u of candidates) {
      console.log(`  - ${u.email}  authProvider=${u.authProvider}  hasLocalPassword=${u.hasLocalPassword}  isActive=${u.isActive}  accountStatus=${u.accountStatus}`);
    }

    // Prefer a user already at the target email; otherwise take the first
    // super-admin and rewrite its email.
    let user = candidates.find((u) => u.email === TARGET_EMAIL) || candidates[0];

    if (!user) {
      console.log(`No super-admin exists; creating one at ${TARGET_EMAIL}.`);
      user = await User.create({
        name: 'Super Admin',
        email: TARGET_EMAIL,
        password: TARGET_PASSWORD,
        role: 'admin',
        isSuperAdmin: true,
        tier: 1,
        isActive: true,
        accountStatus: 'approved',
        authProvider: 'local',
        hasLocalPassword: true,
        department: 'Administration',
      });
    } else {
      user.email = TARGET_EMAIL;
      user.password = TARGET_PASSWORD;
      user.hasLocalPassword = true;
      user.isActive = true;
      user.accountStatus = 'approved';
      user.authProvider = 'local';
      await user.save();
    }

    // Re-fetch from DB and verify the bcrypt hash actually matches.
    const fresh = await User.findOne({ where: { email: TARGET_EMAIL } });
    const ok = await bcrypt.compare(TARGET_PASSWORD, fresh.password);
    console.log('');
    console.log('==================================================');
    console.log(`Email:           ${fresh.email}`);
    console.log(`Password:        ${TARGET_PASSWORD}`);
    console.log(`isSuperAdmin:    ${fresh.isSuperAdmin}`);
    console.log(`tier:            ${fresh.tier}`);
    console.log(`isActive:        ${fresh.isActive}`);
    console.log(`accountStatus:   ${fresh.accountStatus}`);
    console.log(`authProvider:    ${fresh.authProvider}`);
    console.log(`hasLocalPassword:${fresh.hasLocalPassword}`);
    console.log(`bcrypt.compare:  ${ok ? 'PASS' : 'FAIL'}`);
    console.log('==================================================');

    if (!ok) {
      console.error('Hash verification FAILED. Something is wrong with the beforeUpdate hook.');
      process.exit(1);
    }

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Reset failed:', err);
    process.exit(1);
  }
})();
