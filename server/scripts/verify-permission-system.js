/**
 * Backend verification for the new permission/RBAC system.
 *
 * Hits the live API on PORT (or 5000) and runs scenarios A–H from the spec.
 *
 * Pre-reqs:
 *   1. node server/scripts/add-permission-effect.js   (DDL migration)
 *   2. server is running (npm run dev or node server/server.js)
 *   3. seeded test users exist (admin@, manager@, john@, sara@)
 *
 * Run:
 *   node server/scripts/verify-permission-system.js
 *
 * Exit code: 0 if all scenarios pass, 1 otherwise.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const BASE = process.env.VERIFY_BASE_URL || `http://localhost:${process.env.PORT || 5000}/api`;

// Admin must exist (we use it to bootstrap the rest). Other accounts are
// created on-demand by the verify script via /api/users so the run is
// idempotent against any database state.
const ADMIN = { email: 'admin@aniston.com', password: 'Admin@1234' };

const TEST_USERS = {
  manager: { email: 'verify-mgr@aniston.test',     password: 'Verify@1234', name: 'Verify Manager', role: 'manager'   },
  john:    { email: 'verify-john@aniston.test',    password: 'Verify@1234', name: 'Verify John',    role: 'member'    },
  sara:    { email: 'verify-sara@aniston.test',    password: 'Verify@1234', name: 'Verify Sara',    role: 'member'    },
};

const results = [];
let totalPass = 0, totalFail = 0;

function record(name, ok, info) {
  if (ok) totalPass++; else totalFail++;
  results.push({ name, ok, info });
  const prefix = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${prefix} ${name}${info ? ` — ${info}` : ''}`);
}

async function http(method, urlPath, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function login(account) {
  const { status, data } = await http('POST', '/auth/login', null, account);
  // Server returns either { token, user } at top-level or { data: { token, user } }.
  const token = data?.token || data?.data?.token;
  const user = data?.user || data?.data?.user;
  if (status !== 200 || !token) {
    throw new Error(`Login failed for ${account.email}: ${status} ${JSON.stringify(data)}`);
  }
  return { token, user };
}

async function ensureUser(adminToken, spec) {
  // Try to log in first — if it works the user already exists with that pwd.
  try {
    return await login({ email: spec.email, password: spec.password });
  } catch (_) { /* fall through to create */ }

  // Create via admin endpoint.
  const create = await http('POST', '/users', adminToken, {
    name: spec.name,
    email: spec.email,
    password: spec.password,
    role: spec.role,
  });
  if (create.status !== 201 && create.status !== 200) {
    // User exists but password mismatched — reset it via admin.
    const list = await http('GET', '/users', adminToken);
    const users = list.data?.data?.users || list.data?.users || [];
    const existing = users.find(u => u.email === spec.email);
    if (!existing) {
      throw new Error(`Cannot ensure user ${spec.email}: ${create.status} ${JSON.stringify(create.data)}`);
    }
    const reset = await http('PUT', `/users/${existing.id}/password`, adminToken, { password: spec.password });
    if (reset.status !== 200) {
      throw new Error(`Password reset failed for ${spec.email}: ${reset.status} ${JSON.stringify(reset.data)}`);
    }
  }
  return await login({ email: spec.email, password: spec.password });
}

async function main() {
  console.log(`\n=== Permission System Verification — ${BASE} ===\n`);

  console.log('[setup] Logging in admin and provisioning test users...');
  const sessions = { admin: await login(ADMIN) };
  console.log(`  admin: id=${sessions.admin.user.id} role=${sessions.admin.user.role}`);
  for (const [k, spec] of Object.entries(TEST_USERS)) {
    sessions[k] = await ensureUser(sessions.admin.token, spec);
    console.log(`  ${k}: id=${sessions[k].user.id} role=${sessions[k].user.role}`);
  }

  // Pick a board to write tasks against. The first board the admin can see.
  const boardsRes = await http('GET', '/boards', sessions.admin.token);
  const board = (boardsRes.data?.boards || boardsRes.data?.data?.boards || [])[0];
  if (!board) {
    console.error('No boards available — seed at least one board before running.');
    process.exit(1);
  }
  console.log(`  using board: ${board.id} "${board.name}"`);

  // ───────────────────────────────────────────────────────────────────────
  // Scenario A: Member default task creation (self only).
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nA. Member default task creation');
  {
    const create = await http('POST', '/tasks', sessions.john.token, {
      title: `[verify] member self-task ${Date.now()}`,
      boardId: board.id,
      dueDate: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      priority: 'high',
      status: 'not_started',
    });
    const ok = create.status === 201;
    record('member can create task', ok, ok ? `id=${create.data?.data?.task?.id}` : `${create.status} ${create.data?.message}`);
    if (ok) {
      const t = create.data.data.task;
      const assignedToSelf = t.assignedTo === sessions.john.user.id ||
        (Array.isArray(t.taskAssignees) && t.taskAssignees.some(ta => (ta.userId || ta.user?.id) === sessions.john.user.id));
      record('task auto-assigned to self', assignedToSelf, `assignedTo=${t.assignedTo}`);
      const setPriority = t.priority === 'high';
      record('member-set priority preserved', setPriority, `priority=${t.priority}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Scenario B: Member cannot assign others.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nB. Member cannot assign others (API)');
  {
    const create = await http('POST', '/tasks', sessions.john.token, {
      title: `[verify] member-tries-assign ${Date.now()}`,
      boardId: board.id,
      dueDate: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      assignedTo: sessions.sara.user.id,
    });
    const ok = create.status === 403;
    record('POST /tasks with another user as assignedTo → 403', ok, `${create.status} ${create.data?.message}`);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Scenario C: Grant assign_others to member, then assign succeeds.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nC. Grant tasks.assign_others to member → can assign sara');
  let grantCId = null;
  {
    const grant = await http('POST', '/permissions', sessions.admin.token, {
      userId: sessions.john.user.id,
      resourceType: 'tasks',
      action: 'assign_others',
      effect: 'grant',
      reason: 'verify-script',
    });
    record('admin can grant tasks.assign_others to member',
      grant.status === 201 || grant.status === 200,
      `${grant.status}`);
    grantCId = grant.data?.data?.permission?.id;

    // Re-login member to refresh permission cache (token unchanged but engine
    // reads from DB on each request, so a re-login isn't strictly needed).
    const create = await http('POST', '/tasks', sessions.john.token, {
      title: `[verify] member-assigns-sara ${Date.now()}`,
      boardId: board.id,
      dueDate: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      assignedTo: sessions.sara.user.id,
    });
    record('member can now assign sara', create.status === 201, `${create.status} ${create.data?.message}`);
  }
  // Cleanup grant so we don't poison subsequent runs.
  if (grantCId) await http('DELETE', `/permissions/${grantCId}`, sessions.admin.token);

  // ───────────────────────────────────────────────────────────────────────
  // Scenario D: Manager feedback default access.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nD. Manager feedback default');
  {
    const list = await http('GET', '/feedback', sessions.manager.token);
    record('manager can GET /feedback (200)', list.status === 200, `${list.status}`);
    const stats = await http('GET', '/feedback/stats', sessions.manager.token);
    record('manager can GET /feedback/stats', stats.status === 200, `${stats.status}`);

    const me = await http('GET', '/auth/me/permissions', sessions.manager.token);
    const view = me.data?.data?.granularPermissions?.['feedback.view'];
    const manage = me.data?.data?.granularPermissions?.['feedback.manage'];
    record('manager granular feedback.view = true', view === true, `view=${view}`);
    record('manager granular feedback.manage = true', manage === true, `manage=${manage}`);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Scenario E: Grant feedback.view and feedback.manage to member.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nE. Grant feedback to member, then revoke');
  let grantViewId = null, grantManageId = null;
  {
    // Member should be denied initially.
    const before = await http('GET', '/feedback', sessions.john.token);
    record('member without grant → /feedback 403', before.status === 403, `${before.status}`);

    const grantView = await http('POST', '/permissions', sessions.admin.token, {
      userId: sessions.john.user.id,
      resourceType: 'feedback',
      action: 'view',
      effect: 'grant',
    });
    grantViewId = grantView.data?.data?.permission?.id;
    record('grant feedback.view to member', grantView.status === 201 || grantView.status === 200, `${grantView.status}`);

    const after = await http('GET', '/feedback', sessions.john.token);
    record('member with feedback.view grant → /feedback 200', after.status === 200, `${after.status}`);

    // Manage actions still 403 with only view.
    // (Pick any feedback id — there may not be one; pick stats endpoint instead since it needs view, which they now have, so check delete on a non-existent id.)
    const tryManage = await http('PUT', `/feedback/00000000-0000-0000-0000-000000000000`, sessions.john.token, { status: 'reviewed' });
    record('member with only view → PUT /feedback denied (403)', tryManage.status === 403, `${tryManage.status}`);

    const grantManage = await http('POST', '/permissions', sessions.admin.token, {
      userId: sessions.john.user.id,
      resourceType: 'feedback',
      action: 'manage',
      effect: 'grant',
    });
    grantManageId = grantManage.data?.data?.permission?.id;
    record('grant feedback.manage to member', grantManage.status === 201 || grantManage.status === 200, `${grantManage.status}`);

    const tryManage2 = await http('PUT', `/feedback/00000000-0000-0000-0000-000000000000`, sessions.john.token, { status: 'reviewed' });
    // 404 (not found) means we passed the auth gate. 403 would be wrong.
    record('member with manage → PUT /feedback passes auth (404 expected for fake id)',
      tryManage2.status === 404, `${tryManage2.status}`);
  }
  // Cleanup
  if (grantViewId) await http('DELETE', `/permissions/${grantViewId}`, sessions.admin.token);
  if (grantManageId) await http('DELETE', `/permissions/${grantManageId}`, sessions.admin.token);

  // ───────────────────────────────────────────────────────────────────────
  // Scenario F: Deny override blocks manager's default tasks.assign_others.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nF. Deny tasks.assign_others on manager');
  let denyId = null;
  {
    // Sanity: manager currently can assign sara.
    const before = await http('POST', '/tasks', sessions.manager.token, {
      title: `[verify] mgr-assigns-pre ${Date.now()}`,
      boardId: board.id,
      dueDate: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      assignedTo: sessions.sara.user.id,
    });
    record('manager can assign sara (baseline)', before.status === 201, `${before.status} ${before.data?.message}`);

    const deny = await http('POST', '/permissions', sessions.admin.token, {
      userId: sessions.manager.user.id,
      resourceType: 'tasks',
      action: 'assign_others',
      effect: 'deny',
      reason: 'verify-script-deny',
    });
    denyId = deny.data?.data?.permission?.id;
    record('admin can issue DENY override on manager', deny.status === 201 || deny.status === 200, `${deny.status} ${deny.data?.message}`);

    const after = await http('POST', '/tasks', sessions.manager.token, {
      title: `[verify] mgr-assigns-post ${Date.now()}`,
      boardId: board.id,
      dueDate: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      assignedTo: sessions.sara.user.id,
    });
    record('manager with deny → assignment 403', after.status === 403, `${after.status} ${after.data?.message}`);

    // Effective preview should show manager.tasks.assign_others=false now.
    const eff = await http('GET', `/permissions/effective/${sessions.manager.user.id}`, sessions.admin.token);
    const granular = eff.data?.data?.effective?.permissions || {};
    record('effective preview shows tasks.assign_others=false', granular['tasks.assign_others'] === false, `value=${granular['tasks.assign_others']}`);

    const denials = eff.data?.data?.effective?.denials || [];
    const matched = denials.find(d => d.resource === 'tasks' && d.action === 'assign_others');
    record('preview includes deny entry for tasks.assign_others', !!matched, matched ? `id=${matched.id}` : 'missing');
  }
  // Revoke deny
  if (denyId) {
    await http('DELETE', `/permissions/${denyId}`, sessions.admin.token);
    const restored = await http('POST', '/tasks', sessions.manager.token, {
      title: `[verify] mgr-after-revoke ${Date.now()}`,
      boardId: board.id,
      dueDate: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      assignedTo: sessions.sara.user.id,
    });
    record('after revoke deny → manager can assign again', restored.status === 201, `${restored.status} ${restored.data?.message}`);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Scenario G: Effective preview matches behavior.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nG. Effective preview matches behavior');
  {
    const eff = await http('GET', `/permissions/effective/${sessions.john.user.id}`, sessions.admin.token);
    const g = eff.data?.data?.effective?.permissions || {};
    record('member tasks.create=true (default)', g['tasks.create'] === true, `value=${g['tasks.create']}`);
    record('member tasks.assign=true (self)', g['tasks.assign'] === true, `value=${g['tasks.assign']}`);
    record('member tasks.assign_others=false (default)', g['tasks.assign_others'] === false, `value=${g['tasks.assign_others']}`);
    record('member feedback.view=false (default)', g['feedback.view'] === false, `value=${g['feedback.view']}`);

    const effM = await http('GET', `/permissions/effective/${sessions.manager.user.id}`, sessions.admin.token);
    const gm = effM.data?.data?.effective?.permissions || {};
    record('manager feedback.manage=true (default)', gm['feedback.manage'] === true, `value=${gm['feedback.manage']}`);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Scenario H: Regression — super admin still works, admin can grant.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\nH. Regression checks');
  {
    const list = await http('GET', '/permissions', sessions.admin.token);
    record('admin can list /permissions', list.status === 200, `${list.status}`);

    // Manager cannot create deny override (only admin can).
    const mgrDeny = await http('POST', '/permissions', sessions.manager.token, {
      userId: sessions.john.user.id,
      resourceType: 'tasks',
      action: 'assign_others',
      effect: 'deny',
    });
    record('manager attempting to create DENY → 403', mgrDeny.status === 403, `${mgrDeny.status} ${mgrDeny.data?.message}`);

    // Member cannot grant anything.
    const memGrant = await http('POST', '/permissions', sessions.john.token, {
      userId: sessions.sara.user.id,
      resourceType: 'tasks',
      action: 'assign_others',
      effect: 'grant',
    });
    record('member attempting to grant → 403', memGrant.status === 403, `${memGrant.status}`);

    // Existing legacy permissionLevel rows still resolve via the engine.
    // (We can't easily insert one without DB access, so we just verify the
    // engine code path is exercised by computing effective permissions.)
    const me = await http('GET', '/auth/me/permissions', sessions.john.token);
    record('GET /auth/me/permissions returns granular perms', !!me.data?.data?.granularPermissions, `keys=${Object.keys(me.data?.data?.granularPermissions || {}).length}`);
    record('response includes denials field', Array.isArray(me.data?.data?.denials), `value=${typeof me.data?.data?.denials}`);
  }

  console.log(`\n=== ${totalPass}/${totalPass + totalFail} passed ===\n`);
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
