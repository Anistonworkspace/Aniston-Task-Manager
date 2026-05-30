import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// --- Hoisted mocks ---
const { mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

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
  listMyDocs: vi.fn(),
  createDoc: vi.fn(),
  archiveDoc: vi.fn(),
  restoreDoc: vi.fn(),
}));

vi.mock('../../../context/AuthContext', () => ({
  useAuth: vi.fn(),
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

// Keep errorMap deterministic so error banner assertions read the backend message verbatim.
vi.mock('../../../utils/errorMap', () => ({
  getErrorMessage: (err) =>
    (err && err.response && err.response.data && err.response.data.message) ||
    (err && err.message) ||
    'Something went wrong',
}));

vi.mock('../../../utils/safeLog', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Phase 8 — DocsListPage subscribes to realtime doc:access:granted /
// doc:access:revoked events via useRealtimeEvent. Mock the hook so the
// page doesn't need a wrapping RealtimeProvider in tests.
vi.mock('../../../realtime/useRealtimeEvent', () => ({
  default: vi.fn(),
}));

import DocsListPage from '../DocsListPage';
import {
  listMyDocs,
  createDoc,
  archiveDoc,
  restoreDoc,
} from '../../../services/docsService';
import { useAuth } from '../../../context/AuthContext';

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({
    user: { id: 'u1', name: 'Test User' },
    isSuperAdmin: false,
  });
});

// Phase 2: page lives at /docs, calls GET /api/docs directly (no workspace
// resolution). All tests render at /docs.
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/docs']}>
      <Routes>
        <Route path="/docs" element={<DocsListPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('DocsListPage', () => {
  it('renders loading skeletons initially while the fetch is pending', () => {
    // Pending forever so loading state remains visible.
    listMyDocs.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('calls listMyDocs({ q: undefined, archived: false }) on mount', async () => {
    listMyDocs.mockResolvedValue({ docs: [] });
    renderPage();
    await waitFor(() => expect(listMyDocs).toHaveBeenCalledTimes(1));
    expect(listMyDocs).toHaveBeenCalledWith({
      q: undefined,
      archived: false,
    });
  });

  it('renders doc rows when the fetch resolves', async () => {
    listMyDocs.mockResolvedValue({
      docs: [
        { id: 'd1', title: 'Roadmap Q3', contentText: 'Plan stuff', lastEditedAt: new Date().toISOString() },
        { id: 'd2', title: 'Meeting notes', contentText: 'Discuss', lastEditedAt: new Date().toISOString() },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Roadmap Q3')).toBeInTheDocument());
    expect(screen.getByText('Meeting notes')).toBeInTheDocument();
  });

  it('shows the empty state when no docs exist', async () => {
    listMyDocs.mockResolvedValue({ docs: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('No docs yet')).toBeInTheDocument());
  });

  it('typing into search triggers a new fetch with the q param (debounced)', async () => {
    listMyDocs.mockResolvedValue({ docs: [] });
    renderPage();
    await waitFor(() => expect(listMyDocs).toHaveBeenCalledTimes(1));

    const input = screen.getByPlaceholderText(/Search docs/i);
    fireEvent.change(input, { target: { value: 'roadmap' } });

    // 250ms debounce — waitFor polls with a default 1000ms timeout, plenty.
    await waitFor(() => {
      expect(listMyDocs).toHaveBeenCalledWith({
        q: 'roadmap',
        archived: false,
      });
    });
  });

  it('toggling "Show archived" calls fetch with archived: true', async () => {
    listMyDocs.mockResolvedValue({ docs: [] });
    renderPage();
    await waitFor(() => expect(listMyDocs).toHaveBeenCalledTimes(1));

    const checkbox = screen.getByLabelText(/Show archived/i);
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(listMyDocs).toHaveBeenCalledWith({
        q: undefined,
        archived: true,
      });
    });
  });

  it('"New doc" button calls createDoc and navigates to the new doc URL', async () => {
    listMyDocs.mockResolvedValue({ docs: [] });
    createDoc.mockResolvedValue({ doc: { id: 'd99', title: 'Untitled doc' } });
    renderPage();
    await waitFor(() => expect(screen.getByText('No docs yet')).toBeInTheDocument());

    const btn = screen.getByRole('button', { name: /New doc/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(createDoc).toHaveBeenCalledWith({ title: 'Untitled doc' });
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/docs/d99')
    );
  });

  it('archive icon calls archiveDoc and removes the row optimistically', async () => {
    listMyDocs.mockResolvedValue({
      docs: [
        { id: 'd1', title: 'Roadmap Q3', lastEditedAt: new Date().toISOString(), createdBy: 'u1' },
      ],
    });
    archiveDoc.mockResolvedValue({ doc: { id: 'd1', isArchived: true } });
    renderPage();

    await waitFor(() => expect(screen.getByText('Roadmap Q3')).toBeInTheDocument());

    const archiveBtn = screen.getByRole('button', { name: /Archive/i });
    await act(async () => {
      fireEvent.click(archiveBtn);
    });

    expect(archiveDoc).toHaveBeenCalledWith('d1');
    await waitFor(() => expect(screen.queryByText('Roadmap Q3')).not.toBeInTheDocument());
    expect(mockToastSuccess).toHaveBeenCalledWith('Doc archived');
  });

  it('renders the error banner when the fetch fails', async () => {
    listMyDocs.mockRejectedValue({
      response: { data: { message: 'Boom — could not load docs' } },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Boom — could not load docs/)).toBeInTheDocument()
    );
  });

  it('restoring an archived doc calls restoreDoc then reloads the list', async () => {
    // Default response keeps the archived row visible across all three fetches
    // (mount, "Show archived" flip, post-restore reload). Subsequent calls
    // would otherwise return undefined and break destructuring.
    listMyDocs.mockResolvedValue({
      docs: [
        {
          id: 'd1',
          title: 'Old doc',
          isArchived: true,
          createdBy: 'u1',
          lastEditedAt: new Date().toISOString(),
        },
      ],
    });
    restoreDoc.mockResolvedValue({ doc: { id: 'd1', isArchived: false } });

    renderPage();
    // Need archived visible — flip the checkbox so the row is rendered.
    await waitFor(() => expect(listMyDocs).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText(/Show archived/i));
    await waitFor(() => expect(screen.getByText('Old doc')).toBeInTheDocument());

    const restoreBtn = screen.getByRole('button', { name: /Restore/i });
    await act(async () => {
      fireEvent.click(restoreBtn);
    });

    expect(restoreDoc).toHaveBeenCalledWith('d1');
    expect(mockToastSuccess).toHaveBeenCalledWith('Doc restored');
    // After restore the page calls load() again — listMyDocs is hit a
    // third time (initial mount, archived flip, post-restore reload).
    await waitFor(() => expect(listMyDocs.mock.calls.length).toBeGreaterThanOrEqual(3));
  });
});
