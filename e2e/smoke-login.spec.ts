/**
 * Smoke test: login flow.
 *
 * Verifies that the login page renders, a known seeded user (from
 * `server/seed-users.js`) can authenticate, and the home page becomes
 * accessible after login.
 *
 * Prerequisite: a local dev stack is running (npm run dev) with the
 * 4 seeded test users present. See CLAUDE.md → "Test Accounts (Local)".
 *
 * Run from repo root:
 *   npm run e2e -- e2e/smoke-login.spec.ts
 *   npm run e2e:ui -- e2e/smoke-login.spec.ts   (interactive)
 */

import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = 'admin@aniston.com';
const ADMIN_PASSWORD = 'Admin@1234';

test.describe('Smoke — Login flow', () => {
  test('login page renders the email + password form', async ({ page }) => {
    await page.goto('/login');

    // Accessibility-friendly queries — finds inputs by label/role rather
    // than CSS selectors, so a class rename doesn't flake the test.
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in|log in/i })).toBeVisible();
  });

  test('admin user can sign in and lands on the home page', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: /sign in|log in/i }).click();

    // Successful login navigates to / (the home page). We don't assert on
    // greeting text because it's i18n + name-dependent — instead, look
    // for a sidebar nav landmark that only exists post-auth.
    await expect(page).toHaveURL(/^[^?]*\/?$/);
    await expect(page.getByRole('navigation', { name: /sidebar|main nav/i })).toBeVisible({ timeout: 10_000 });
  });

  test('wrong password keeps the user on the login page with an error message', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
    await page.getByLabel(/password/i).fill('definitely-wrong');
    await page.getByRole('button', { name: /sign in|log in/i }).click();

    // The page should NOT navigate to / — the user stays on /login and
    // sees an error string. We don't assert the exact copy (i18n) but we
    // do verify (a) URL didn't change and (b) some kind of error
    // surface is visible.
    await expect(page).toHaveURL(/\/login/);
    // Common error patterns: a div with role="alert", or text containing
    // "invalid" / "incorrect". Either matches.
    const errorVisible = await Promise.any([
      page.getByRole('alert').waitFor({ state: 'visible', timeout: 5_000 }).then(() => true),
      page.getByText(/invalid|incorrect|wrong/i).first().waitFor({ state: 'visible', timeout: 5_000 }).then(() => true),
    ]).catch(() => false);
    expect(errorVisible).toBe(true);
  });
});
