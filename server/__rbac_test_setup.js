/* eslint-disable no-console */
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run RBAC test setup/run in production.');
  process.exit(1);
}
// Temporary helper for the boards/groups/tasks RBAC regression test.
// Creates five test users (one per role), two workspaces, and one private
// board. Idempotent — safe to run multiple times. Delete this file after the
// regression run is complete.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { sequelize } = require('./config/db');
require('./models');
const { User, Workspace, Board } = require('./models');

const TEST = {
  super:   { email: 'test_super@example.com', name: 'Test Super', password: 'Test@1234', role: 'admin', isSuperAdmin: true },
  admin:   { email: 'test_admin@example.com', name: 'Test Admin', password: 'Test@1234', role: 'admin' },
  manager: { email: 'test_mgr@example.com', name: 'Test Manager', password: 'Test@1234', role: 'manager' },
  asst:    { email: 'test_asst@example.com', name: 'Test Asst', password: 'Test@1234', role: 'assistant_manager' },
  member:  { email: 'test_mem@example.com', name: 'Test Member', password: 'Test@1234', role: 'member' },
};

async function upsertUser(spec) {
  let u = await User.findOne({ where: { email: spec.email } });
  if (u) {
    await u.update({
      name: spec.name,
      role: spec.role,
      isActive: true,
      accountStatus: 'approved',
      isSuperAdmin: !!spec.isSuperAdmin,
    });
    // Force-reset password each run so login always works.
    u.password = spec.password;
    await u.save();
    return u;
  }
  u = await User.create({ ...spec, isActive: true, accountStatus: 'approved' });
  return u;
}

(async () => {
  await sequelize.authenticate();
  const users = {};
  for (const k of Object.keys(TEST)) users[k] = await upsertUser(TEST[k]);

  let memberWs = await Workspace.findOne({ where: { name: '__test_member_ws' } });
  if (!memberWs) memberWs = await Workspace.create({ name: '__test_member_ws', color: '#0073ea', createdBy: users.member.id });

  let privateWs = await Workspace.findOne({ where: { name: '__test_private_admin_ws' } });
  if (!privateWs) privateWs = await Workspace.create({ name: '__test_private_admin_ws', color: '#0073ea', createdBy: users.admin.id });

  let privateBoard = await Board.findOne({ where: { name: '__test_private_admin_board' } });
  if (!privateBoard) privateBoard = await Board.create({ name: '__test_private_admin_board', color: '#0073ea', createdBy: users.admin.id, workspaceId: privateWs.id });

  console.log(JSON.stringify({
    users: Object.fromEntries(Object.entries(users).map(([k,v])=>[k, { id: v.id, email: v.email, role: v.role, isSuperAdmin: !!v.isSuperAdmin }])),
    memberWsId: memberWs.id,
    privateWsId: privateWs.id,
    privateBoardId: privateBoard.id,
  }, null, 2));
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
