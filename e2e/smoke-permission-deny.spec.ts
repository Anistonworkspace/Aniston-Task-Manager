/**
 * Smoke test: a tier-4 (member) user cannot reach admin surfaces.
 *
 * This is the "RBAC is wired end-to-end" check — the only one of the
 * smoke tests that asserts a NEGATIVE behavior. If this flakes green
 * (because the deny screen never appears), the regression below is
 * what we missed:
 *
 *   "Member user reaches /admin-settings or /integrations and the
 *    page renders sensitive content."
 *
 * That regression last shipped in May 2026 (per docs/qa-audit-2026-05-17.md
 * → §New-feature audit), so this smoke test exists primarily to defend
 * against its recurrence.
 */

import { test, expect, Page } from '@playwright/test';

const MEMBER_EMAIL = 'john@aniston.com';
const MEMBER_PASSWORD = 'John@1234';

async function loginAsMember(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(MEMBER_EMAIL);
  await page.getByLabel(/password/i).fill(MEMBER_PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.getByRole('navigation', { name: /sidebar|main nav/i })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

test.describe('Smoke — RBAC denial for tier-4 member', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsMember(page);
  });

  test('member visits /admin-settings — gets the access-denied screen OR redirects to home', async ({ page }) => {
    await page.goto('/admin-settings');
    // Three valid outcomes for a denied user:
    //  1. URL stays at /admin-settings + an AccessDenied component renders
    //  2. URL stays at /admin-settings but body shows an "access denied" string
    //  3. URL redirects to / (the home page) — the StrictAdminRoute guard
    //     bounces the user
    //
    // We accept any of the three. What we DON'T accept is the admin-settings
    // UI rendering for a member user. So we assert the NEGATIVE: the page
    // must NOT contain admin-only controls (e.g. "API Keys", "Encryption Key").
    await expect(page).not.toHaveURL(/\/login/);
    // The admin-settings page exposes a heading or section labeled
    // something like "AI Provider" / "API Keys" / "System Settings".
    // We confirm none of those are visible for the member.
    const adminOnlyMarker = page.getByText(/api keys|encryption key|system settings/i);
    await expect(adminOnlyMarker).toHaveCount(0);
  });

  test('member visits /integrations — gets the access-denied screen OR redirects', async ({ page }) => {
    await page.goto('/integrations');
    await expect(page).not.toHaveURL(/\/login/);
    // Integration management is strict-admin only. The configure-provider
    // UI must NOT render for a member.
    const integrationsMarker = page.getByText(/configure.*provider|sso settings/i);
    await expect(integrationsMarker).toHaveCount(0);
  });

  test('member visits /users — does NOT see the admin user-management UI', async ({ page }) => {
    await page.goto('/users');
    await expect(page).not.toHaveURL(/\/login/);
    // The admin user-management page has "Create User" / "Reset Password"
    // buttons. Members must not see them.
    const createButton = page.getByRole('button', { name: /create user|new user/i });
    await expect(createButton).toHaveCount(0);
  });
});
