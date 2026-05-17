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

vi.mock('../../../services/workflowsService', () => ({
  listWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
}));

// Workspaces fetch — defaulted to one workspace so the "+ New workflow"
// button has a workspaceId to auto-pick. The empty-workspaces branch is
// covered by a dedicated test below.
vi.mock('../../../services/api', () => ({
  default: {
    get: vi.fn((url) => {
      if (url === '/workspaces') {
        return Promise.resolve({ data: { workspaces: [{ id: 'ws-default', name: 'Main' }] } });
      }
      return Promise.resolve({ data: {} });
    }),
  },
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

import WorkflowsListPage from '../WorkflowsListPage';
import {
  listWorkflows,
  createWorkflow,
  deleteWorkflow,
} from '../../../services/workflowsService';
import { useAuth } from '../../../context/AuthContext';

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({
    user: { id: 'u1', name: 'Test User', role: 'admin', isSuperAdmin: false },
    isSuperAdmin: false,
    canManage: true,
  });
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/workflows']}>
      <Routes>
        <Route path="/workflows" element={<WorkflowsListPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('WorkflowsListPage', () => {
  it('renders loading skeletons initially while the fetch is pending', () => {
    listWorkflows.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('shows the empty state when no workflows exist', async () => {
    listWorkflows.mockResolvedValue({ workflows: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('No workflows yet')).toBeInTheDocument());
  });

  it('lists workflows with name + status pill (Draft + Active)', async () => {
    listWorkflows.mockResolvedValue({
      workflows: [
        { id: 'w1', name: 'Notify on done',  isActive: true,  updatedAt: new Date().toISOString() },
        { id: 'w2', name: 'Escalate stuck', isActive: false, updatedAt: new Date().toISOString() },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Notify on done')).toBeInTheDocument());
    expect(screen.getByText('Escalate stuck')).toBeInTheDocument();
    // Pills
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('"+ New workflow" button auto-picks the first visible workspace + navigates to the canvas', async () => {
    listWorkflows.mockResolvedValue({ workflows: [] });
    createWorkflow.mockResolvedValue({ workflow: { id: 'w99', name: 'Untitled workflow' } });
    renderPage();
    await waitFor(() => expect(screen.getByText('No workflows yet')).toBeInTheDocument());

    const btn = screen.getByRole('button', { name: /New workflow/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    // The list page lives at /workflows (no ?workspaceId= in URL), so the
    // create handler auto-picks the first workspace returned by the
    // mocked /workspaces endpoint — without this, the server would 400
    // on "workspaceId is required".
    expect(createWorkflow).toHaveBeenCalledWith({
      workspaceId: 'ws-default',
      name: 'Untitled workflow',
    });
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/workflows/w99')
    );
  });

  it('search filter narrows the visible workflow list (client-side)', async () => {
    listWorkflows.mockResolvedValue({
      workflows: [
        { id: 'w1', name: 'Notify on done',  isActive: false, updatedAt: new Date().toISOString() },
        { id: 'w2', name: 'Escalate stuck', isActive: false, updatedAt: new Date().toISOString() },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Notify on done')).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/Search workflows/i);
    fireEvent.change(search, { target: { value: 'escalate' } });

    await waitFor(() => {
      expect(screen.queryByText('Notify on done')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Escalate stuck')).toBeInTheDocument();
  });

  it('clicking a workflow row navigates to the canvas page', async () => {
    listWorkflows.mockResolvedValue({
      workflows: [
        { id: 'w42', name: 'Click me', isActive: false, updatedAt: new Date().toISOString() },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Click me')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Click me'));
    expect(mockNavigate).toHaveBeenCalledWith('/workflows/w42');
  });
});
