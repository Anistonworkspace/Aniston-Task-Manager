/**
 * Stryker mutation-testing config — Phase 4.2 of the QA remediation plan
 * (docs/qa-audit-2026-05-17.md → §2.5 / §22.3).
 *
 * Mutation testing answers a question that line/branch coverage cannot:
 * "do my tests actually catch broken code?". Stryker introduces synthetic
 * bugs into production code (flipping conditionals, changing constants,
 * etc.) and runs the test suite — if tests still pass with the bug
 * in place, the test is asserting on something other than the behavior
 * we care about.
 *
 * Scope:
 *   - Only the P0 critical-path files (the ones with coverage threshold
 *     gates in jest.config.js). Mutation testing on the whole codebase
 *     would take hours; scoping it keeps the run under ~10 minutes.
 *
 * Target: ≥80% mutation score on each critical file. Below that and
 * the tests are line-coverage theater, not real verification.
 *
 * Run:
 *   npm run test:mutation
 *
 * Output: stryker creates `reports/mutation/` with an HTML + JSON
 * report. CI uploads it as an artifact; humans review it on a quarterly
 * cadence per the remediation plan.
 */
export default {
  $schema: 'https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/api/schema/stryker-core.json',
  packageManager: 'npm',
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.js',
    enableFindRelatedTests: true,
  },
  reporters: ['html', 'progress', 'clear-text'],
  coverageAnalysis: 'perTest',
  // Mutation budget — fail the run if the score on any file drops below
  // this. Setting it conservatively at the start; ratchet up to 85%
  // once the P0 list has been audited and stale tests removed.
  thresholds: { high: 85, low: 70, break: 65 },
  // Only mutate the critical-path files we have coverage thresholds on.
  // Adding a file here without adding tests for it will tank the score.
  mutate: [
    'utils/errors.js',
    'middleware/errorHandler.js',
    'middleware/apiKeyAuth.js',
    'middleware/staticAuth.js',
    'middleware/upload.js',
    'services/approvalChainService.js',
    'services/approvalNotificationService.js',
    'services/notificationService.js',
    'services/dependencyService.js',
    // recurringTaskService.js intentionally excluded — its size + the
    // persistence-heavy paths mean Stryker would run for >30 min. Add
    // back once Phase 7 (testcontainers) is in place.
  ],
  // Run within the server/ directory so paths resolve consistently.
  tempDirName: 'reports/.stryker-tmp',
  cleanTempDir: true,
  // The HTML/JSON reports go into server/reports/mutation. Ignored
  // by `.gitignore`; uploaded as a CI artifact.
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  timeoutMS: 60000,
  // Sandbox model — Stryker runs the tests in a forked process per
  // mutant; default concurrency works well enough on a 4-core box.
  // Lower for slow CI runners.
  concurrency: 4,
};
