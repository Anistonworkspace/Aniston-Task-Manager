import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

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
  listVersions: vi.fn(),
  restoreVersion: vi.fn(),
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

// LetterAvatar pulls in label-palette utilities; stub to a thin shim so the
// test stays focused on the modal logic.
vi.mock('../../../components/common/LetterAvatar', () => ({
  default: ({ name }) => <span data-testid="avatar">{name}</span>,
}));

import DocVersionHistoryModal from '../DocVersionHistoryModal';
import { listVersions, restoreVersion } from '../../../services/docsService';

const baseVersion = (i) => ({
  id: `v${i}`,
  note: i === 1 ? 'Restored from version vx' : null,
  createdAt: new Date(Date.now() - i * 60_000).toISOString(),
  savedBy: 'u1',
  author: { id: 'u1', name: `User ${i}`, email: `u${i}@x.io`, avatar: null },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DocVersionHistoryModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <DocVersionHistoryModal
        isOpen={false}
        onClose={() => {}}
        docId="d1"
        currentDocTitle="My Doc"
      />
    );
    // Nothing meaningful should be in the DOM (Modal animates out → portal-free render returns empty fragment).
    expect(container.querySelector('[data-testid="doc-version-history"]')).toBeNull();
    expect(listVersions).not.toHaveBeenCalled();
  });

  it('shows loading skeleton, then the versions list when the fetch resolves', async () => {
    let resolveFn;
    listVersions.mockReturnValue(new Promise((r) => { resolveFn = r; }));
    render(
      <DocVersionHistoryModal
        isOpen={true}
        onClose={() => {}}
        docId="d1"
        currentDocTitle="My Doc"
      />
    );
    expect(screen.getByTestId('version-skeleton')).toBeInTheDocument();
    await act(async () => {
      resolveFn({ versions: [baseVersion(1), baseVersion(2)] });
    });
    await waitFor(() => expect(screen.queryByTestId('version-skeleton')).toBeNull());
    expect(screen.getByTestId('version-row-v1')).toBeInTheDocument();
    expect(screen.getByTestId('version-row-v2')).toBeInTheDocument();
  });

  it('renders the empty state when versions is []', async () => {
    listVersions.mockResolvedValue({ versions: [] });
    render(
      <DocVersionHistoryModal
        isOpen={true}
        onClose={() => {}}
        docId="d1"
        currentDocTitle="My Doc"
      />
    );
    await waitFor(() => expect(screen.getByTestId('version-empty')).toBeInTheDocument());
    expect(screen.getByText(/No saved versions yet/i)).toBeInTheDocument();
  });

  it('confirm flow: click Restore → click Confirm → restoreVersion called, modal closed, onRestored fired', async () => {
    listVersions.mockResolvedValue({ versions: [baseVersion(1)] });
    restoreVersion.mockResolvedValue({ doc: { id: 'd1' } });
    const onClose = vi.fn();
    const onRestored = vi.fn();
    render(
      <DocVersionHistoryModal
        isOpen={true}
        onClose={onClose}
        docId="d1"
        currentDocTitle="My Doc"
        onRestored={onRestored}
      />
    );
    await waitFor(() => expect(screen.getByTestId('version-row-v1')).toBeInTheDocument());

    // Click Restore — reveals the inline confirm row.
    fireEvent.click(screen.getByRole('button', { name: /Restore/i }));
    expect(screen.getByTestId('version-confirm-v1')).toBeInTheDocument();

    // Click Confirm.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm/i }));
    });

    await waitFor(() => expect(restoreVersion).toHaveBeenCalledWith('d1', 'v1'));
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('cancel flow: click Restore → click Cancel → back to list, no restore call', async () => {
    listVersions.mockResolvedValue({ versions: [baseVersion(1)] });
    render(
      <DocVersionHistoryModal
        isOpen={true}
        onClose={() => {}}
        docId="d1"
        currentDocTitle="My Doc"
      />
    );
    await waitFor(() => expect(screen.getByTestId('version-row-v1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Restore/i }));
    expect(screen.getByTestId('version-confirm-v1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByTestId('version-confirm-v1')).toBeNull();
    expect(restoreVersion).not.toHaveBeenCalled();
  });

  it('shows an error toast when restoreVersion rejects', async () => {
    listVersions.mockResolvedValue({ versions: [baseVersion(1)] });
    restoreVersion.mockRejectedValue({ response: { data: { message: 'Nope' } } });
    const onClose = vi.fn();
    render(
      <DocVersionHistoryModal
        isOpen={true}
        onClose={onClose}
        docId="d1"
        currentDocTitle="My Doc"
      />
    );
    await waitFor(() => expect(screen.getByTestId('version-row-v1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Restore/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Confirm/i }));
    });

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Nope'));
    // Modal must NOT close on failure.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('show-more pagination: 15 versions → 10 visible initially, expand → all visible', async () => {
    const many = Array.from({ length: 15 }).map((_, i) => baseVersion(i + 1));
    listVersions.mockResolvedValue({ versions: many });
    render(
      <DocVersionHistoryModal
        isOpen={true}
        onClose={() => {}}
        docId="d1"
        currentDocTitle="My Doc"
      />
    );
    await waitFor(() => expect(screen.getByTestId('version-row-v1')).toBeInTheDocument());

    // 10 rows initially.
    expect(screen.getByTestId('version-row-v10')).toBeInTheDocument();
    expect(screen.queryByTestId('version-row-v11')).toBeNull();

    // Show more reveals the remaining 5.
    fireEvent.click(screen.getByTestId('version-show-more'));
    expect(screen.getByTestId('version-row-v11')).toBeInTheDocument();
    expect(screen.getByTestId('version-row-v15')).toBeInTheDocument();
    expect(screen.queryByTestId('version-show-more')).toBeNull();
  });

  it('close button (modal X) fires onClose', async () => {
    listVersions.mockResolvedValue({ versions: [] });
    const onClose = vi.fn();
    render(
      <DocVersionHistoryModal
        isOpen={true}
        onClose={onClose}
        docId="d1"
        currentDocTitle="My Doc"
      />
    );
    await waitFor(() => expect(screen.getByTestId('version-empty')).toBeInTheDocument());

    // Modal renders an aria-label="Close" button in the header.
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
