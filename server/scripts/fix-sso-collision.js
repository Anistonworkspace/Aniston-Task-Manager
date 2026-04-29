/**
 * One-time data fix: clear stale teamsUserId on local-provider users that
 * duplicate another (microsoft-provider) user's teamsUserId.
 *
 * Background:
 *   The previous Op.or-based SSO lookup would link a Microsoft OID onto whatever
 *   row the OR matched first, including the seeded super-admin. That caused the
 *   super-admin's `teamsUserId` to silently get set to a regular user's OID.
 *   When the regular user then logged in via SSO, both rows matched the OR query
 *   and the older row (super-admin) was returned — escalating their session to
 *   super-admin.
 *
 * Strategy (conservative — only touches obvious duplicates):
 *   For every teamsUserId that appears on more than one row:
 *     - Keep it on the user whose authProvider is 'microsoft' (an OID semantically
 *       belongs to a Microsoft-linked account).
 *     - Clear it from the OTHER row(s) (typically a local-provider account whose
 *       OID was set by the buggy Op.or query).
 *   If the duplicates can't be disambiguated (multiple microsoft-provider users
 *   share an OID, or NO microsoft-provider user is in the group), the script
 *   PRINTS a warning and leaves them alone for manual review.
 *
 * Run with:
 *   node server/scripts/fix-sso-collision.js          # dry run (default)
 *   node server/scripts/fix-sso-collision.js --apply  # actually clear values
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');
require('../models');
const User = require('../models/User');

const APPLY = process.argv.includes('--apply');

(async () => {
  try {
    await sequelize.authenticate();

    const all = await User.findAll({
      attributes: [
        'id', 'name', 'email', 'role', 'isSuperAdmin',
        'authProvider', 'teamsUserId', 'password',
      ],
    });

    const byOid = new Map();
    for (const u of all) {
      if (!u.teamsUserId) continue;
      if (!byOid.has(u.teamsUserId)) byOid.set(u.teamsUserId, []);
      byOid.get(u.teamsUserId).push(u);
    }

    const dups = [...byOid.entries()].filter(([, list]) => list.length > 1);
    if (!dups.length) {
      console.log('✓ No duplicate teamsUserId values — nothing to fix.');
      process.exit(0);
    }

    console.log(`Found ${dups.length} duplicated teamsUserId group(s):\n`);
    const toClear = [];
    const skipped = [];

    for (const [oid, list] of dups) {
      console.log(`  teamsUserId = ${oid.slice(0, 6)}…${oid.slice(-4)} (${list.length} rows):`);
      for (const u of list) {
        const localPwd = !!u.password;
        console.log(
          `    id=${u.id} email=${u.email} role=${u.role} super=${u.isSuperAdmin} ` +
            `provider=${u.authProvider} hasLocalPassword=${localPwd}`
        );
      }

      // Decide which row to keep: the user whose authProvider is 'microsoft'
      // (an OID semantically belongs on the SSO-linked account).
      const keepers = list.filter((u) => u.authProvider === 'microsoft');
      if (keepers.length === 1) {
        const keep = keepers[0];
        for (const u of list) {
          if (u.id !== keep.id) toClear.push({ user: u, keeper: keep, oid });
        }
      } else {
        skipped.push({ oid, list, reason: keepers.length === 0
          ? 'no microsoft-provider user in the group'
          : `${keepers.length} microsoft-provider users tied — manual review` });
      }
      console.log('');
    }

    if (skipped.length) {
      console.log('=== SKIPPED (manual review) ===');
      for (const s of skipped) console.log(`  oid=${s.oid.slice(0, 6)}… reason: ${s.reason}`);
      console.log('');
    }

    if (!toClear.length) {
      console.log('Nothing the script can safely auto-fix. Review the skipped groups above.');
      process.exit(0);
    }

    console.log(`=== PLANNED CHANGES (${APPLY ? 'APPLY' : 'DRY RUN'}) ===`);
    for (const c of toClear) {
      console.log(
        `  Clear teamsUserId on user ${c.user.id} (${c.user.email}, ${c.user.authProvider}) — ` +
          `keeping OID on ${c.keeper.id} (${c.keeper.email})`
      );
    }

    if (!APPLY) {
      console.log('\nDry run only. Re-run with --apply to commit the changes.');
      process.exit(0);
    }

    let applied = 0;
    for (const c of toClear) {
      await c.user.update({ teamsUserId: null });
      applied += 1;
    }
    console.log(`\n✓ Applied: cleared teamsUserId on ${applied} user(s).`);
    process.exit(0);
  } catch (err) {
    console.error('[Fix] Failed:', err.message);
    process.exit(1);
  }
})();
