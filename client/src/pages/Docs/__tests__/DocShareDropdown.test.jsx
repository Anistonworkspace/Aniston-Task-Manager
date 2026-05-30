import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ─── Hoisted mocks ──────────────────────────────────────────────

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy(
    {},
    {
      get: (_, tag) =>
        React.forwardRef(({ children, ...rest }, ref) =>
          React.createElement(tag, { ref, ...rest }, children)
        ),
    }
  ),
  useReducedMotion: () => false,
}));

vi.mock('../../../services/docsService', () => ({
  updateDocSharePolicy: vi.fn(),
}));

const { mockToastSuccess, mockToastError, mockToastInfo } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastInfo: vi.fn(),
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({
    success: mockToastSuccess,
    error: mockToastError,
    info: mockToastInfo,
  }),
}));

vi.mock('../../../utils/errorMap', () => ({
  getErrorMessage: (err) =>
    (err && err.response && err.response.data && err.response.data.message) ||
    (err && err.message) ||
    'Something went wrong',
}));

vi.mock('../../../utils/safeLog', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import DocShareDropdown from '../DocShareDropdown';
import { updateDocSharePolicy } from '../../../services/docsService';

// Phase 1: docs live at /docs/:docId. The optional workspaceId arg is kept
// for call-site compat but ignored — there is no workspace in the URL now.
function renderDropdown(props = {}, /* { workspaceId = 'w1' } unused */ _ = {}) {
  return render(
    <MemoryRouter initialEntries={['/docs/d1']}>
      <Routes>
        <Route
          path="/docs/:docId"
          element={
            <DocShareDropdown
              docId="d1"
              currentSharePolicy="workspace"
              canEdit
              {...props}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom doesn't ship a writeText polyfill — give the component one.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('DocShareDropdown', () => {
  it('is closed by default — only the trigger is visible', () => {
    renderDropdown();
    expect(screen.getByTestId('share-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('share-menu')).toBeNull();
  });

  it('opens the popover on trigger click and renders three policy rows', async () => {
    renderDropdown();
    fireEvent.click(screen.getByTestId('share-trigger'));
    await waitFor(() => expect(screen.getByTestId('share-menu')).toBeInTheDocument());
    expect(screen.getByTestId('share-row-private')).toBeInTheDocument();
    expect(screen.getByTestId('share-row-workspace')).toBeInTheDocument();
    expect(screen.getByTestId('share-row-public_link')).toBeInTheDocument();
  });

  it('selecting "Public link" reveals the copy-link button and calls clipboard.writeText', async () => {
    updateDocSharePolicy.mockResolvedValue({ doc: { id: 'd1', sharePolicy: 'public_link' } });
    renderDropdown();
    fireEvent.click(screen.getByTestId('share-trigger'));
    await waitFor(() => expect(screen.getByTestId('share-menu')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('share-row-public_link'));
    });

    await waitFor(() => expect(screen.getByTestId('share-public-link')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('share-copy'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const url = navigator.clipboard.writeText.mock.calls[0][0];
    // Phase 1: public share URL dropped the /workspaces/:wsId segment.
    expect(url).toMatch(/\/docs\/d1$/);
  });

  it('changing policy calls updateDocSharePolicy and fires onChanged with the new value', async () => {
    updateDocSharePolicy.mockResolvedValue({ doc: { id: 'd1', sharePolicy: 'private' } });
    const onChanged = vi.fn();
    renderDropdown({ onChanged });

    fireEvent.click(screen.getByTestId('share-trigger'));
    await waitFor(() => expect(screen.getByTestId('share-menu')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('share-row-private'));
    });

    await waitFor(() =>
      expect(updateDocSharePolicy).toHaveBeenCalledWith('d1', 'private')
    );
    expect(onChanged).toHaveBeenCalledWith('private');
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('rolls back the optimistic policy when the PATCH fails', async () => {
    updateDocSharePolicy.mockRejectedValue({ response: { data: { message: 'No way' } } });
    renderDropdown();

    fireEvent.click(screen.getByTestId('share-trigger'));
    await waitFor(() => expect(screen.getByTestId('share-menu')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId('share-row-private'));
    });

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('No way'));
    // After rollback, the trigger label should be back to "Workspace".
    expect(screen.getByTestId('share-trigger').textContent).toMatch(/Workspace/);
  });

});

// Separate suite covering the read-only branch (the trigger doesn't carry
// the `share-trigger` testid in that mode, so we drive it via aria-label).
describe('DocShareDropdown — read-only branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('canEdit=false hides the radio rows and shows a read-only caption', async () => {
    render(
      <MemoryRouter initialEntries={['/docs/d1']}>
        <Routes>
          <Route
            path="/docs/:docId"
            element={
              <DocShareDropdown
                docId="d1"
                currentSharePolicy="private"
                canEdit={false}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    );
    const trigger = screen.getByLabelText('Doc sharing');
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByTestId('share-readonly')).toBeInTheDocument());
    expect(screen.queryByTestId('share-row-private')).toBeNull();
    expect(screen.queryByTestId('share-row-workspace')).toBeNull();
    expect(screen.queryByTestId('share-row-public_link')).toBeNull();
  });
});
