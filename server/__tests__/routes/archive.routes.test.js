'use strict';

/**
 * Phase A.2 follow-up (May 2026 RBAC hardening — bug report 2026-05-16).
 *
 * Pre-fix: every archive route ran through `managerOrAdmin`, a pure tier
 * check. An admin who granted `archive.view` to a Tier 4 user (Sunny Mehta
 * in the report) saw the route guard let them through to the page, but
 * the in-page fetches for /api/archive/dependencies and
 * /api/archive/help-requests returned 403 with "Manager or admin
 * privileges required" — surfacing as a toast that overlaid the page.
 *
 * Fix:
 *   - GET routes use `requirePermission('archive', 'view')` so a Tier 4
 *     user with the explicit grant passes (and admins still pass via
 *     their tier-base permission in the catalog).
 *   - Destructive routes (restore + permanent_delete) keep the legacy
 *     tier path as a fallback so admins / managers — who currently
 *     handle destructive archive ops as part of routine work — don't
 *     lose that ability. Explicit `archive.restore` /
 *     `archive.permanent_delete` grants also pass.
 *
 * This suite mocks the permission engine + controllers so we can pin the
 * exact 200/403 outcome per (actor, route) pair without dragging in a
 * real DB.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

jest.mock('../../middleware/auth', () => ({
  authenticate: (req, res, next) => {
    // Test actor is injected via the `x-test-user` header (JSON-encoded).
    const header = req.headers['x-test-user'];
    req.user = header ? JSON.parse(header) : null;
    if (!req.user) return res.status(401).json({ success: false });
    next();
  },
  managerOrAdmin: (req, res, next) => {
    // Mirror real middleware: tier 1 or 2 only.
    const tier = req.user?.tier;
    if (tier === 1 || tier === 2) return next();
    return res.status(403).json({ success: false, message: 'Access denied. Manager or admin privileges required.' });
  },
}));

jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn(async () => false),
}));

jest.mock('../../middleware/permissions', () => {
  const enginePermission = require('../../services/permissionEngine');
  return {
    requirePermission: (resource, action) => async (req, res, next) => {
      if (req.user?.isSuperAdmin) return next();
      const ok = await enginePermission.hasPermission(req.user, resource, action);
      if (ok) return next();
      return res.status(403).json({ success: false, message: `Access denied. '${action}' permission required for '${resource}'.` });
    },
  };
});

jest.mock('../../controllers/dependencyController', () => ({
  getArchivedDependencies:    (req, res) => res.json({ success: true, data: { dependencies: [] } }),
  restoreDependency:          (req, res) => res.json({ success: true, message: 'restored' }),
  permanentDeleteDependency:  (req, res) => res.json({ success: true, message: 'deleted' }),
}));

jest.mock('../../controllers/helpRequestController', () => ({
  getArchivedHelpRequests:    (req, res) => res.json({ success: true, data: { helpRequests: [] } }),
  restoreHelpRequest:         (req, res) => res.json({ success: true, message: 'restored' }),
  permanentDeleteHelpRequest: (req, res) => res.json({ success: true, message: 'deleted' }),
}));

const enginePermission = require('../../services/permissionEngine');
const archiveRouter = require('../../routes/archive');

let app;
beforeEach(() => {
  jest.clearAllMocks();
  app = express();
  app.use(express.json());
  app.use('/api/archive', archiveRouter);
});

const SUPER  = { id: 'u-super', tier: 1, role: 'admin',          isSuperAdmin: true };
const ADMIN  = { id: 'u-admin', tier: 2, role: 'admin',          isSuperAdmin: false };
const T3     = { id: 'u-t3',    tier: 3, role: 'assistant_manager' };
const T4     = { id: 'u-t4',    tier: 4, role: 'member' };

function asUser(user) {
  return { 'x-test-user': JSON.stringify(user) };
}

// ── GET /dependencies — engine-only (archive.view) ────────────────────────

describe('GET /api/archive/dependencies — requirePermission(archive, view)', () => {
  test('Tier 4 WITH archive.view grant → 200', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    const res = await request(app).get('/api/archive/dependencies').set(asUser(T4));
    expect(res.status).toBe(200);
    expect(enginePermission.hasPermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-t4' }),
      'archive',
      'view',
    );
  });

  test('Tier 4 WITHOUT grant → 403 with the precise resource/action error', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    const res = await request(app).get('/api/archive/dependencies').set(asUser(T4));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/'view'.*'archive'/);
    // Critically: NOT the legacy "Manager or admin privileges required."
    // copy that the bug report quoted — that one was the symptom of the
    // route running the tier middleware.
    expect(res.body.message).not.toMatch(/Manager or admin privileges/);
  });

  test('Admin (Tier 2) passes via engine base permission (archive.view = true in matrix)', async () => {
    // The engine's catalog grants T2 archive.view; we simulate that here.
    enginePermission.hasPermission.mockResolvedValue(true);
    const res = await request(app).get('/api/archive/dependencies').set(asUser(ADMIN));
    expect(res.status).toBe(200);
  });

  test('Super admin short-circuits the engine call', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    const res = await request(app).get('/api/archive/dependencies').set(asUser(SUPER));
    expect(res.status).toBe(200);
    expect(enginePermission.hasPermission).not.toHaveBeenCalled();
  });
});

// ── PUT /:id/restore — tier OR permission grant ───────────────────────────

describe('PUT /api/archive/dependencies/:id/restore — tierOrPermission(managerOrAdmin, archive, restore)', () => {
  test('Tier 4 WITH archive.restore grant → 200 (engine path)', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    const res = await request(app).put('/api/archive/dependencies/dep-1/restore').set(asUser(T4));
    expect(res.status).toBe(200);
  });

  test('Tier 4 WITHOUT grant → 403 (tier fallback also denies)', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    const res = await request(app).put('/api/archive/dependencies/dep-1/restore').set(asUser(T4));
    expect(res.status).toBe(403);
    // Falls through to the tier middleware's legacy copy because the
    // engine said no AND the tier check denied.
    expect(res.body.message).toMatch(/Manager or admin privileges/);
  });

  test('Admin (Tier 2) WITHOUT grant → 200 via tier fallback', async () => {
    // Mirrors current operational reality — admins routinely restore
    // archived items without needing an explicit grant. The matrix has
    // archive.manage=false for T2, so engine would deny; tier fallback
    // is what admits them.
    enginePermission.hasPermission.mockResolvedValue(false);
    const res = await request(app).put('/api/archive/dependencies/dep-1/restore').set(asUser(ADMIN));
    expect(res.status).toBe(200);
  });

  test('Super admin → 200 without engine call', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    const res = await request(app).put('/api/archive/dependencies/dep-1/restore').set(asUser(SUPER));
    expect(res.status).toBe(200);
    expect(enginePermission.hasPermission).not.toHaveBeenCalled();
  });

  test('Tier 3 WITHOUT grant → 403 (tier fallback denies; no special T3 admit)', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    const res = await request(app).put('/api/archive/dependencies/dep-1/restore').set(asUser(T3));
    expect(res.status).toBe(403);
  });
});

// ── DELETE /:id — tier OR permission grant ────────────────────────────────

describe('DELETE /api/archive/dependencies/:id — tierOrPermission(managerOrAdmin, archive, permanent_delete)', () => {
  test('Tier 4 WITH archive.permanent_delete grant → 200', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    const res = await request(app).delete('/api/archive/dependencies/dep-1').set(asUser(T4));
    expect(res.status).toBe(200);
    expect(enginePermission.hasPermission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-t4' }),
      'archive',
      'permanent_delete',
    );
  });

  test('Tier 4 WITHOUT grant → 403', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    const res = await request(app).delete('/api/archive/dependencies/dep-1').set(asUser(T4));
    expect(res.status).toBe(403);
  });

  test('Admin (Tier 2) WITHOUT explicit grant → 200 via tier fallback (preserves current admin ability)', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    const res = await request(app).delete('/api/archive/dependencies/dep-1').set(asUser(ADMIN));
    expect(res.status).toBe(200);
  });
});

// ── Help-requests mirror dependencies (same middleware applied) ───────────

describe('Help-requests routes use the same gates', () => {
  test('GET /help-requests honours archive.view grant for T4', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    const res = await request(app).get('/api/archive/help-requests').set(asUser(T4));
    expect(res.status).toBe(200);
  });

  test('DELETE /help-requests/:id honours archive.permanent_delete grant for T4', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    const res = await request(app).delete('/api/archive/help-requests/hr-1').set(asUser(T4));
    expect(res.status).toBe(200);
  });

  test('PUT /help-requests/:id/restore admits T2 admin via tier fallback', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    const res = await request(app).put('/api/archive/help-requests/hr-1/restore').set(asUser(ADMIN));
    expect(res.status).toBe(200);
  });
});
