/**
 * Reproduction script for the "Failed to fetch workspace" bug.
 * Simulates each workspace endpoint exactly as the Sidebar would call it
 * for a member-role user (Sunny Mehta) and reports which call throws.
 *
 * Usage:  node server/scripts/repro-workspace-fetch.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { sequelize } = require('../config/db');
const { User } = require('../models');

(async () => {
  await sequelize.authenticate();
  const targetEmail = process.argv[2] || 'mehta.sunny@anistonav.com';
  const viewer = await User.findOne({ where: { email: targetEmail } });
  if (!viewer) {
    console.error(`Could not locate ${targetEmail} in the DB`);
    process.exit(1);
  }
  console.log(`Using viewer: ${viewer.name} role=${viewer.role} hl=${viewer.hierarchyLevel}`);

  // Fake req.user object — same shape as `authenticate` middleware sets.
  const reqUser = viewer;

  function tryRoute(label, fn) {
    return Promise.resolve()
      .then(fn)
      .then((r) => console.log(`OK   ${label} →`, JSON.stringify(r).slice(0, 200)))
      .catch((e) => console.error(`FAIL ${label} →`, e?.message, '\n  ', (e?.stack || '').split('\n').slice(0, 6).join('\n  ')));
  }

  // 1. getMyWorkspaces — what /api/workspaces/mine runs.
  const wsCtrl = require('../controllers/workspaceController');
  const fakeRes = (label) => ({
    status: function (code) { this._status = code; return this; },
    json: function (body) { this._body = body; return body; },
  });

  await tryRoute('GET /api/workspaces/mine', async () => {
    const res = fakeRes('mine');
    await wsCtrl.getMyWorkspaces({ user: reqUser }, res);
    return { status: res._status || 200, body: res._body };
  });

  // 2. getWorkspaces — same endpoint but plural; Sidebar does NOT call this,
  //    but other pages do. Some UI flows redirect through /api/workspaces.
  await tryRoute('GET /api/workspaces', async () => {
    const res = fakeRes('list');
    await wsCtrl.getWorkspaces({ user: reqUser }, res);
    return { status: res._status || 200, body: res._body };
  });

  // 3. workspaceOrderController — what /api/workspaces/order calls.
  const wsOrderCtrl = require('../controllers/workspaceOrderController');
  await tryRoute('GET /api/workspaces/order', async () => {
    const res = fakeRes('order');
    await wsOrderCtrl.getMine({ user: reqUser }, res);
    return { status: res._status || 200, body: res._body };
  });

  // 4. boardController.getBoards — Sidebar calls this. If it throws, the
  //    response interceptor still fires the toast.
  const boardCtrl = require('../controllers/boardController');
  await tryRoute('GET /api/boards', async () => {
    const res = fakeRes('boards');
    await boardCtrl.getBoards({ user: reqUser, query: {} }, res);
    return { status: res._status || 200, body: JSON.stringify(res._body).slice(0, 100) };
  });

  await sequelize.close();
})().catch((e) => { console.error(e); process.exit(1); });
