const axios = require('axios');
const { User, Department } = require('../models');
const { Op } = require('sequelize');
const teamsConfig = require('../config/teams');

/**
 * Get an app-level access token using client_credentials grant.
 * This does NOT require a user login — uses the app's own permissions.
 */
async function getAppToken() {
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
      // Check if user already exists by email or teamsUserId
      const existing = await User.findOne({
        where: {
          [Op.or]: [
            { email },
            ...(m365User.id ? [{ teamsUserId: m365User.id }] : []),
          ],
        },
      });

      if (existing) {
        // Update teamsUserId if not set
        if (!existing.teamsUserId && m365User.id) {
          await existing.update({ teamsUserId: m365User.id });
        }
        results.existing.push({ email, name: m365User.displayName, id: existing.id });
        continue;
      }

      // Create new user
      const newUser = await User.create({
        name: m365User.displayName || email.split('@')[0],
        email,
        password: 'Welcome@1234',
        role: 'member',
        department: m365User.department || null,
        designation: m365User.jobTitle || null,
        teamsUserId: m365User.id,
        isActive: true,
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

module.exports = { getAppToken, fetchM365Users, syncUsersFromM365 };
