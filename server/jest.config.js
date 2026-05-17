module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  coverageDirectory: 'coverage',
  // QA Phase 1.4 — expanded scope. Previously excluded routes/jobs/config
  // hid real coverage gaps (the audit at docs/qa-audit-2026-05-17.md
  // documents the gap). Including them here makes the rollup numbers
  // honest; the overall % will drop because most routes/jobs/config are
  // still untested. That is intentional — see Phase 2 plan.
  collectCoverageFrom: [
    'controllers/**/*.js',
    'middleware/**/*.js',
    'models/**/*.js',
    'services/**/*.js',
    'utils/**/*.js',
    'routes/**/*.js',
    'jobs/**/*.js',
    'config/**/*.js',
    '!**/node_modules/**',
  ],
  // QA Phase 2 — ratcheted per-file thresholds for the P0 critical-path
  // files we just covered. Each entry uses the floor of the LATEST measured
  // coverage minus a small slack (~2 pts) so trivial diffs don't trip CI,
  // but a regression of more than that fails the build. See
  // docs/qa-audit-2026-05-17.md → §22 for the rationale per file.
  //
  // The thresholds intentionally only cover files we know how to keep
  // honest. We do NOT set a global threshold because the rest of the
  // codebase is still being filled in (Phase 6 of the remediation plan).
  coverageThreshold: {
    'utils/errors.js':                       { branches: 95, statements: 95, functions: 95, lines: 95 },
    'middleware/errorHandler.js':            { branches: 90, statements: 95, functions: 95, lines: 95 },
    'middleware/apiKeyAuth.js':              { branches: 90, statements: 95, functions: 60, lines: 95 },
    'middleware/staticAuth.js':              { branches: 85, statements: 90, functions: 95, lines: 95 },
    'middleware/upload.js':                  { branches: 75, statements: 80, functions: 70, lines: 80 },
    'services/approvalChainService.js':      { branches: 75, statements: 85, functions: 85, lines: 90 },
    'services/approvalNotificationService.js': { branches: 90, statements: 95, functions: 95, lines: 95 },
  },
  verbose: true,
  forceExit: true,
  detectOpenHandles: true,
};
