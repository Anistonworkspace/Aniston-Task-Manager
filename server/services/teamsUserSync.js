const axios = require('axios');
const { User, Department } = require('../models');
const { getTeamsConfig } = require('../config/teams');

/**
 * Get an app-level access token using client_credentials grant.
 * This does NOT require a user login — uses the app's own permissions.
 */
async function getAppToken() {
  const teamsConfig = await getTeamsConfig();
  if (!teamsConfig.isConfigured) {
    throw new Error('Teams integration is not configured.');
  }

  const res = await axios.post(
    `https://login.microsoftonline.com/${teamsConfig.tenantId}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: teamsConfig.clientId,
      client_secret: teamsConfig.clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return res.data.access_token;
}

/**
 * Fetch all users from Microsoft 365 tenant via Graph API.
 */
async function fetchM365Users() {
  const teamsConfig = await getTeamsConfig();
  const token = await getAppToken();

  let allUsers = [];
  let nextLink = `${teamsConfig.graphUrl}/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled&$top=100`;

  while (nextLink) {
    const res = await axios.get(nextLink, {
      headers: { Authorization: `Bearer ${token}` },
    });
    allUsers = allUsers.concat(res.data.value || []);
    nextLink = res.data['@odata.nextLink'] || null;
  }

  // Filter out system/service accounts (no email or disabled)
  return allUsers.filter(u => u.mail && u.accountEnabled !== false);
}

/**
 * Sync M365 users into the local database.
 * Creates new users for any M365 user not yet in the local DB.
 * Returns a summary of the sync operation.
 */
async function syncUsersFromM365() {
  const m365Users = await fetchM365Users();

  const results = { created: [], existing: [], failed: [], total: m365Users.length };

  for (const m365User of m365Users) {
    const email = m365User.mail.toLowerCase();

    try {
      // Resolve the local user DETERMINISTICALLY — same rule as the SSO callback
      // (see authController.microsoftCallback). OID-first, then email, with explicit
      // conflict detection. Never use Op.or here because it can match two different
      // local users and silently pick one.
      let existing = null;

      if (m365User.id) {
        const oidMatches = await User.findAll({ where: { teamsUserId: m365User.id } });
        if (oidMatches.length > 1) {
          throw new Error(
            `Refusing to sync: ${oidMatches.length} local users share teamsUserId for ${email}. ` +
              `Resolve duplicates before re-running the sync.`
          );
        }
        if (oidMatches.length === 1) {
          const candidate = oidMatches[0];
          if ((candidate.email || '').toLowerCase() !== email) {
            throw new Error(
              `Refusing to sync: M365 user ${email} maps to OID already on local user ` +
                `${candidate.id} (${candidate.email}). Manual review required.`
            );
          }
          existing = candidate;
        }
      }

      if (!existing) {
        const emailMatches = await User.findAll({ where: { email } });
        if (emailMatches.length > 1) {
          throw new Error(`Refusing to sync: duplicate local emails for ${email}.`);
        }
        if (emailMatches.length === 1) {
          const candidate = emailMatches[0];
          // Never overwrite a different existing teamsUserId on this row.
          if (candidate.teamsUserId && m365User.id && candidate.teamsUserId !== m365User.id) {
            throw new Error(
              `Refusing to sync: ${email} is already linked to a different Microsoft identity locally.`
            );
          }
          existing = candidate;
        }
      }

      if (existing) {
        // Update teamsUserId and authProvider if not set.
        //
        // Locally-edited fields are NEVER overwritten here:
        //   - name, department, designation, role, hierarchyLevel, title,
        //     departmentId, avatar — left untouched on existing rows. (Sync
        //     only seeds them on first create below.)
        //   - isActive — protected by `localStatusOverride`. If an admin has
        //     manually toggled the user's status from Admin Settings, sync
        //     will not silently re-activate the account.
        //   - accountStatus — same protection: respect manual deactivations.
        const updates = {};
        if (!existing.teamsUserId && m365User.id) updates.teamsUserId = m365User.id;
        // Only set authProvider to microsoft if user has NO local password
        // This prevents breaking local login for users who have both
        if (existing.authProvider !== 'microsoft' && !existing.password) updates.authProvider = 'microsoft';
        // Ensure synced M365 users are active and approved so they appear in assignment dropdowns
        if (!existing.isActive && !existing.localStatusOverride) updates.isActive = true;
        if (existing.accountStatus !== 'approved' && !existing.localStatusOverride) {
          updates.accountStatus = 'approved';
        }
        if (Object.keys(updates).length) await existing.update(updates);
        results.existing.push({ email, name: m365User.displayName, id: existing.id });
        continue;
      }

      // Create new user with Microsoft SSO (no password)
      const newUser = await User.create({
        name: m365User.displayName || email.split('@')[0],
        email,
        password: null,
        authProvider: 'microsoft',
        role: 'member',
        department: m365User.department || null,
        designation: m365User.jobTitle || null,
        teamsUserId: m365User.id,
        isActive: true,
        accountStatus: 'approved',
      });

      results.created.push({
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        department: newUser.department,
        designation: newUser.designation,
      });
    } catch (err) {
      results.failed.push({ email, name: m365User.displayName, error: err.message });
    }
  }

  // Auto-create Department records from synced user department strings
  try {
    const allUsers = await User.findAll({ attributes: ['id', 'department', 'departmentId'] });
    const uniqueDepts = [...new Set(allUsers.map(u => u.department).filter(Boolean))];
    for (const deptName of uniqueDepts) {
      const [dept] = await Department.findOrCreate({
        where: { name: deptName },
        defaults: { name: deptName, color: '#0073ea', isActive: true },
      });
      await User.update(
        { departmentId: dept.id },
        { where: { department: deptName, departmentId: null } }
      );
    }
    console.log(`[TeamsSync] Auto-created/linked ${uniqueDepts.length} departments`);
  } catch (deptErr) {
    console.error('[TeamsSync] Department sync error:', deptErr.message);
  }

  return results;
}

/**
 * Sync active/disabled status from M365 into local database.
 * Checks accountEnabled for all Microsoft-linked users and updates isActive accordingly.
 */
async function syncUserActiveStatus() {
  const teamsConfig = await getTeamsConfig();
  const token = await getAppToken();

  // Fetch ALL M365 users (including disabled ones — don't filter by accountEnabled)
  let allM365Users = [];
  let nextLink = `${teamsConfig.graphUrl}/users?$select=id,mail,accountEnabled&$top=100`;
  while (nextLink) {
    const res = await axios.get(nextLink, {
      headers: { Authorization: `Bearer ${token}` },
    });
    allM365Users = allM365Users.concat(res.data.value || []);
    nextLink = res.data['@odata.nextLink'] || null;
  }

  // Build a lookup map: teamsUserId → accountEnabled
  const m365StatusMap = new Map();
  for (const u of allM365Users) {
    if (u.id) m365StatusMap.set(u.id, u.accountEnabled !== false);
    if (u.mail) m365StatusMap.set(u.mail.toLowerCase(), u.accountEnabled !== false);
  }

  // Find all Microsoft-linked local users
  const localUsers = await User.findAll({
    where: { authProvider: 'microsoft' },
    attributes: ['id', 'email', 'teamsUserId', 'isActive', 'name', 'localStatusOverride'],
  });

  const results = { activated: [], deactivated: [], unchanged: 0, skippedManual: 0 };

  for (const user of localUsers) {
    // Skip users whose status has been manually overridden from Admin
    // Settings — Microsoft is no longer the source of truth for them.
    if (user.localStatusOverride) {
      results.skippedManual++;
      continue;
    }

    // Look up by teamsUserId first, then by email
    let m365Active = undefined;
    if (user.teamsUserId && m365StatusMap.has(user.teamsUserId)) {
      m365Active = m365StatusMap.get(user.teamsUserId);
    } else if (user.email && m365StatusMap.has(user.email.toLowerCase())) {
      m365Active = m365StatusMap.get(user.email.toLowerCase());
    }

    if (m365Active === undefined) {
      results.unchanged++;
      continue;
    }

    if (m365Active && !user.isActive) {
      await user.update({ isActive: true });
      results.activated.push({ id: user.id, name: user.name, email: user.email });
    } else if (!m365Active && user.isActive) {
      await user.update({ isActive: false });
      results.deactivated.push({ id: user.id, name: user.name, email: user.email });
    } else {
      results.unchanged++;
    }
  }

  console.log(
    `[TeamsSync] Status sync: ${results.activated.length} activated, ${results.deactivated.length} deactivated, ${results.unchanged} unchanged, ${results.skippedManual} skipped (manual override)`
  );
  return results;
}

module.exports = { getAppToken, fetchM365Users, syncUsersFromM365, syncUserActiveStatus };
