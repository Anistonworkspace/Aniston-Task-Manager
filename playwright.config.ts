/**
 * Playwright config — Phase 4.3 of the QA remediation plan
 * (docs/qa-audit-2026-05-17.md → §14).
 *
 * Conventions:
 *   - e2e tests live in e2e/<journey-name>.spec.ts
 *   - Tests run against the local dev stack (server on :5000, client on :3000)
 *   - On CI, set PLAYWRIGHT_BASE_URL to point at a staging instance
 *   - Tests bring up the dev servers via webServer.* config so CI runs
 *     match local-dev exactly
 *
 * Cost / risk model:
 *   - smoke tests (the top user journeys) run on every PR
 *   - the full suite runs nightly via a separate workflow (TBD)
 *   - flake retry = 2 with auto-quarantine after 3 consecutive runs
 *     (the quarantine logic lives in the workflow, not here)
 */

import { defineConfig, devices } from '@playwright/test';

const PORT_CLIENT = 3000;
const PORT_SERVER = 5000;
const BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${PORT_CLIENT}`;

export default defineConfig({
  testDir: './e2e',
  // Each test gets 30 s; the full suite is bounded by Playwright's own
  // global timeout so a hung browser can't park the CI run.
  timeout: 30_000,
  expect: { timeout: 5_000 },

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Realistic viewport — most users on desktop are 1440x900 or larger.
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Firefox + WebKit are commented out for now to keep CI fast. Add
    // them once the smoke suite is green on chromium for two weeks.
    // { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],

  // Bring up the dev stack only when no external base URL was supplied.
  // Staging runs skip this (PLAYWRIGHT_BASE_URL is set + servers are
  // already running there).
  webServer: process.env.PLAYWRIGHT_BASE_URL ? undefined : [
    {
      command: 'npm run start',
      cwd: 'server',
      port: PORT_SERVER,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { NODE_ENV: 'test' },
    },
    {
      command: 'npm run dev',
      cwd: 'client',
      port: PORT_CLIENT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
