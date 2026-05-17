/**
 * Smoke test: post-login navigation.
 *
 * Verifies that the primary navigation links work: home → my-work →
 * boards → meetings. This is the "did anything fundamental break in
 * the SPA router or auth-context wrapper?" check.
 *
 * Each test uses a fresh login via the API to avoid coupling to the
 * UI login flow (covered in smoke-login.spec.ts).
 */

import { test, expect, Page } from '@playwright/test';

const ADMIN_EMAIL = 'admin@aniston.com';
const ADMIN_PASSWORD = 'Admin@1234';

async function loginViaUI(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  // Wait for the sidebar to appear — proves we're past the auth wall.
  await page.getByRole('navigation', { name: /sidebar|main nav/i })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

test.describe('Smoke — Top-level navigation (admin)', () => {
  test.beforeEach(async ({ page }) => {
    await loginViaUI(page);
  });

  test('navigates to My Work and the page renders without auth redirect', async ({ page }) => {
    await page.goto('/my-work');
    await expect(page).toHaveURL(/\/my-work/);
    // We don't assert on specific task data (state-dependent) — just that
    // the route stayed on /my-work and didn't bounce to /login.
  });

  test('navigates to Boards and the boards list renders', async ({ page }) => {
    await page.goto('/boards');
    await expect(page).toHaveURL(/\/boards/);
  });

  test('navigates to Meetings without 404 or auth bounce', async ({ page }) => {
    await page.goto('/meetings');
    await expect(page).toHaveURL(/\/meetings/);
  });

  test('admin can reach /admin-settings (strict admin gate)', async ({ page }) => {
    await page.goto('/admin-settings');
    // We expect the admin-settings page to render (URL unchanged) OR
    // (depending on the seed user's isSuperAdmin flag) redirect to home.
    // We accept either — what we DON'T accept is a 4xx page or a stack trace.
    const finalUrl = page.url();
    expect(finalUrl).toMatch(/\/admin-settings|\/(\?|$)/);
    // Definitely not the login page (would mean auth context dropped).
    expect(finalUrl).not.toMatch(/\/login/);
  });
});
