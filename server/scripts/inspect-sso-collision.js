/**
 * Audit script: inspect users for SSO identity collisions.
 *
 * Reports:
 *  - Users whose email or teamsUserId is duplicated.
 *  - Super-admin / privileged accounts and what teamsUserId is on them.
 *  - Sunny Mehta's row (or any candidate match) for visual comparison.
 *
 * Read-only — does not modify anything. Run with:
 *   node server/scripts/inspect-sso-collision.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');
require('../models');
const User = require('../models/User');
const { Op } = require('sequelize');

const mask = (v) => (v ? `${String(v).slice(0, 4)}…${String(v).slice(-4)} (len=${String(v).length})` : '∅');

(async () => {
  try {
    await sequelize.authenticate();

    const allUsers = await User.findAll({
      attributes: ['id', 'name', 'email', 'role', 'isSuperAdmin', 'authProvider', 'teamsUserId', 'createdAt'],
      order: [['createdAt', 'ASC']],
    });

    console.log(`\n[Audit] ${allUsers.length} users in database.\n`);

    // 1. Duplicate emails (case-insensitive)
    const byEmail = new Map();
    for (const u of allUsers) {
      const key = (u.email || '').toLowerCase();
      if (!byEmail.has(key)) byEmail.set(key, []);
      byEmail.get(key).push(u);
    }
    const dupEmails = [...byEmail.entries()].filter(([, list]) => list.length > 1);
    if (dupEmails.length) {
      console.log('=== DUPLICATE EMAILS ===');
      for (const [email, list] of dupEmails) {
        console.log(`  ${email} → ${list.length} users:`);
        for (const u of list) console.log(`    id=${u.id} role=${u.role} super=${u.isSuperAdmin} teamsUserId=${mask(u.teamsUserId)}`);
      }
      console.log('');
    } else {
      console.log('✓ No duplicate emails.\n');
    }

    // 2. Duplicate teamsUserId
    const byOid = new Map();
    for (const u of allUsers) {
      if (!u.teamsUserId) continue;
      if (!byOid.has(u.teamsUserId)) byOid.set(u.teamsUserId, []);
      byOid.get(u.teamsUserId).push(u);
    }
    const dupOids = [...byOid.entries()].filter(([, list]) => list.length > 1);
    if (dupOids.length) {
      console.log('=== DUPLICATE teamsUserId ===');
      for (const [oid, list] of dupOids) {
        console.log(`  ${mask(oid)} → ${list.length} users:`);
        for (const u of list) console.log(`    id=${u.id} email=${u.email} role=${u.role} super=${u.isSuperAdmin}`);
      }
      console.log('');
    } else {
      console.log('✓ No duplicate teamsUserId.\n');
    }

    // 3. Privileged accounts
    const privileged = allUsers.filter((u) => u.isSuperAdmin || u.role === 'admin');
    console.log('=== PRIVILEGED ACCOUNTS (super-admin / admin) ===');
    for (const u of privileged) {
      console.log(
        `  id=${u.id} name="${u.name}" email=${u.email} role=${u.role} super=${u.isSuperAdmin} ` +
          `provider=${u.authProvider} teamsUserId=${mask(u.teamsUserId)}`
      );
    }
    console.log('');

    // 4. Look for Sunny Mehta (or any "sunny")
    const candidates = await User.findAll({
      where: { [Op.or]: [{ name: { [Op.iLike]: '%sunny%' } }, { email: { [Op.iLike]: '%sunny%' } }] },
      attributes: ['id', 'name', 'email', 'role', 'isSuperAdmin', 'authProvider', 'teamsUserId'],
    });
    console.log('=== "sunny" matches ===');
    if (!candidates.length) {
      console.log('  (none — Sunny Mehta has not been synced/created in this DB yet)');
    } else {
      for (const u of candidates) {
        console.log(
          `  id=${u.id} name="${u.name}" email=${u.email} role=${u.role} super=${u.isSuperAdmin} ` +
            `provider=${u.authProvider} teamsUserId=${mask(u.teamsUserId)}`
        );
      }
    }
    console.log('');

    process.exit(0);
  } catch (err) {
    console.error('[Audit] Failed:', err.message);
    process.exit(1);
  }
})();
