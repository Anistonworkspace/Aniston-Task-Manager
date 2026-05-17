/**
 * Phase 5.2 — a11y baseline example.
 *
 * Demonstrates how to assert "no axe-core violations" on a rendered
 * component. This file covers ONE primitive (EmptyState) as a working
 * template; extending to other components is a follow-up wave (we don't
 * want a single PR that touches 50 test files and surfaces unrelated
 * violations all at once).
 *
 * Pattern:
 *   1. Render the component into a container
 *   2. Run `axe(container)` (returns an axe result)
 *   3. Assert `toHaveNoViolations()` (matcher registered in test/setup.js)
 *
 * What this catches that line-coverage doesn't:
 *   - Missing aria-label on icon-only buttons
 *   - Color contrast violations (axe-core runs the WCAG 2.1 AA checks)
 *   - Heading hierarchy mistakes
 *   - Form inputs without associated labels
 *   - Missing alt text on images
 *
 * Out of scope for this baseline:
 *   - Color contrast on dark mode (axe runs in jsdom's default white bg)
 *   - Real keyboard navigation flow (those need a real browser → e2e)
 *
 * Run:
 *   cd client && npm test -- src/components/common/__tests__/a11y.example.test.jsx
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, ...rest }, ref) =>
      React.createElement(tag, { ref, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

import EmptyState from '../EmptyState';

describe('a11y baseline — EmptyState primitive', () => {
  it('has no axe-core violations with title + description', async () => {
    const { container } = render(
      <EmptyState
        title="Nothing here yet"
        description="Add your first item to get started"
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe-core violations with primary + secondary actions', async () => {
    const { container } = render(
      <EmptyState
        title="No tasks"
        description="You're all caught up"
        primaryAction={{ label: 'Create task', onClick: () => {} }}
        secondaryAction={{ label: 'Browse boards', onClick: () => {} }}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
