import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Phase B (May 2026 RBAC UI hardening) — wiring fidelity test for the
// PermissionPill rollout. AdminSettingsPage is a large page (2.3k LOC, many
// modal/context dependencies) so we mock the ambient surfaces and assert
// only what this PR is supposed to deliver: the active-grants table now
// renders the action via PermissionPill (with data-testid and the right
// data-category). This catches the regression where the wire-up reverts
// to the legacy LEVEL_COLORS span.

vi.mock('react-router-dom', () => ({
  useNavigate: () => () => {},
  BrowserRouter: ({ children }) => <>{children}</>,
  Link: ({ children, ...rest }) => <a {...rest}>{children}</a>,
}));

vi.mock('framer-motion', () => {
  const passthrough = ({ children, ...rest }) => <div {...rest}>{children}</div>;
  return {
    motion: new Proxy({}, { get: () => passthrough }),
    AnimatePresence: ({ children }) => <>{children}</>,
  };
});

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-admin', name: 'Admin', role: 'admin', tier: 1, isSuperAdmin: true },
    isSuperAdmin: true,
    // Security tab values — not exercised here but provided so the
    // SecurityTab doesn't crash if its rendering is ever pulled in by a
    // future tab switch.
    inactivityTimeoutMinutes: 5,
    refreshInactivityTimeout: vi.fn(),
    applyInactivityTimeoutMinutes: vi.fn(),
    INACTIVITY_MIN_MINUTES: 5,
    INACTIVITY_MAX_MINUTES: 1440,
  }),
}));

vi.mock('../../context/LanguageContext', () => ({
  useT: () => (key, fallback) => fallback || key,
}));

vi.mock('../../utils/safeLog', () => {
  const fn = vi.fn();
  return { default: { error: fn, warn: fn, info: fn, debug: fn }, error: fn, warn: fn, info: fn, debug: fn };
});

vi.mock('../../components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../components/common/Avatar', () => ({ default: () => <span /> }));
vi.mock('../../components/common/Modal', () => ({
  default: ({ children, open }) => (open ? <div>{children}</div> : null),
}));
vi.mock('../../components/user/CreateUserModal', () => ({ default: () => null }));
vi.mock('../../components/user/EditUserModal', () => ({ default: () => null }));
vi.mock('../../components/user/ResetPasswordModal', () => ({ default: () => null }));

import api from '../../services/api';
import AdminSettingsPage from '../AdminSettingsPage';

beforeEach(() => {
  vi.clearAllMocks();
  // Provide just enough API surface for the Permissions tab to render its
  // active-grants table with one row.
  api.get.mockImplementation((url) => {
    if (url === '/permissions') {
      return Promise.resolve({
        data: {
          permissions: [{
            id: 'grant-1',
            userId: 'u-sara',
            user: { id: 'u-sara', name: 'Sara', role: 'member', tier: 4, isSuperAdmin: false },
            granter: { id: 'u-admin', name: 'Admin' },
            resourceType: 'labels',
            action: 'create',
            effect: 'grant',
            scope: 'global',
            expiresAt: null,
          }],
        },
      });
    }
    if (url === '/auth/users') return Promise.resolve({ data: { users: [] } });
    if (url === '/users') return Promise.resolve({ data: { users: [] } });
    if (url === '/permissions/catalog') return Promise.resolve({ data: { data: { catalog: {} } } });
    if (url === '/permissions/templates') return Promise.resolve({ data: { templates: {} } });
    if (url === '/workspaces') return Promise.resolve({ data: { workspaces: [] } });
    if (url && url.startsWith('/access-requests')) return Promise.resolve({ data: { requests: [] } });
    // Other tabs may eagerly fetch — return shapes whose `|| []` fallbacks
    // resolve to arrays so the UsersTab `.filter(...)` doesn't crash.
    return Promise.resolve({ data: { users: [], items: [] } });
  });
});

describe('AdminSettingsPage — Permissions tab pill wiring', () => {
  it('renders a PermissionPill in the action cell of the active grants table', async () => {
    render(<AdminSettingsPage />);

    // Navigate to the Permissions tab — default is Users. The mocked `t()`
    // returns the i18n key when no fallback is provided, so the tab label
    // renders as 'adminSettings.tabs.permissions'.
    const permissionsTab = await screen.findByRole('button', { name: /tabs\.permissions/i });
    fireEvent.click(permissionsTab);

    // Wait for the API-driven row to mount.
    const actionPill = await waitFor(
      () => screen.getByTestId('permission-pill-action'),
      { timeout: 3000 },
    );

    // The row is for `labels.create` — the category mapper classifies it as
    // 'write'. If a future change re-wires the cell to a plain <span> or
    // breaks the category resolution, this attribute will diverge.
    expect(actionPill).toHaveAttribute('data-category', 'write');
    // Effect is grant (non-deny path) — data-effect is the literal effect
    // prop value, which is undefined here. Component normalises to 'none'.
    expect(actionPill).toHaveAttribute('data-effect', 'none');
  });
});
