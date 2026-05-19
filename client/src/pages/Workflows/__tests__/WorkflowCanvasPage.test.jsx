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

// reactflow is hard to render in jsdom (relies on ResizeObserver, layout
// measurement). Stub the minimum surface area the page touches: a
// render-children wrapper for ReactFlow + lightweight no-op exports for
// every helper imported by the page.
vi.mock('reactflow', () => {
  const Stub = ({ children }) => <div data-testid="rf-canvas">{children}</div>;
  return {
    __esModule: true,
    default: Stub,
    ReactFlowProvider: ({ children }) => <>{children}</>,
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState: (initial) => {
      const [n, setN] = React.useState(initial || []);
      return [n, setN, () => {}];
    },
    useEdgesState: (initial) => {
      const [e, setE] = React.useState(initial || []);
      return [e, setE, () => {}];
    },
    addEdge: (e, eds) => [...eds, e],
    applyNodeChanges: (_changes, nodes) => nodes,
    applyEdgeChanges: (_changes, edges) => edges,
  };
});

// Stub the reactflow CSS import — jsdom CSS is irrelevant here.
vi.mock('reactflow/dist/style.css', () => ({}));

vi.mock('../../../services/workflowsService', () => ({
  getWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  createNode: vi.fn(),
  updateNode: vi.fn(),
  deleteNode: vi.fn(),
  createEdge: vi.fn(),
  deleteEdge: vi.fn(),
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

// May-26 fix — the canvas now reads the current user from AuthContext to
// filter its own socket echoes. Tests don't wrap in AuthProvider, so stub
// the hook to return a synthetic admin.
vi.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-test', name: 'Tester', role: 'admin', isSuperAdmin: true },
  }),
}));

// May-26 fix — the canvas joins workflow:<id> + subscribes to workflow:*
// socket events. The test environment doesn't have a real socket; stub the
// service so the imports resolve and emits / subscriptions become no-ops.
vi.mock('../../../services/socket', () => ({
  emit: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  onConnect: vi.fn(() => () => {}),
}));

import WorkflowCanvasPage from '../WorkflowCanvasPage';
import {
  getWorkflow,
  updateWorkflow,
} from '../../../services/workflowsService';

beforeEach(() => {
  vi.clearAllMocks();
});

function renderCanvas(workflowId = 'w1') {
  return render(
    <MemoryRouter initialEntries={[`/workflows/${workflowId}`]}>
      <Routes>
        <Route path="/workflows/:id" element={<WorkflowCanvasPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('WorkflowCanvasPage', () => {
  it('renders the header, palette, and canvas stub once the workflow loads', async () => {
    getWorkflow.mockResolvedValue({
      workflow: { id: 'w1', name: 'My Workflow', isActive: false },
      nodes: [],
      edges: [],
    });

    renderCanvas();

    // Header — workflow name is visible
    await waitFor(() => expect(screen.getByText('My Workflow')).toBeInTheDocument());
    // Palette (data-testid hook)
    expect(screen.getByTestId('workflow-palette')).toBeInTheDocument();
    // reactflow stub canvas
    expect(screen.getByTestId('rf-canvas')).toBeInTheDocument();
    // Empty-canvas hint
    expect(screen.getByText(/Empty canvas/i)).toBeInTheDocument();
  });

  it('renders the Draft pill when isActive=false and Active when isActive=true', async () => {
    getWorkflow.mockResolvedValueOnce({
      workflow: { id: 'w1', name: 'Draft Flow', isActive: false },
      nodes: [],
      edges: [],
    });
    const { unmount } = renderCanvas();
    await waitFor(() => expect(screen.getByText('Draft Flow')).toBeInTheDocument());
    expect(screen.getByText('Draft')).toBeInTheDocument();
    unmount();

    getWorkflow.mockResolvedValueOnce({
      workflow: { id: 'w2', name: 'Active Flow', isActive: true },
      nodes: [{ id: 'n1', type: 'trigger', kind: 'task_created', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    });
    renderCanvas('w2');
    await waitFor(() => expect(screen.getByText('Active Flow')).toBeInTheDocument());
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('publishing without a trigger node toasts an error and does NOT call updateWorkflow', async () => {
    getWorkflow.mockResolvedValue({
      workflow: { id: 'w1', name: 'No Trigger', isActive: false },
      nodes: [], // ← no trigger
      edges: [],
    });

    renderCanvas();
    await waitFor(() => expect(screen.getByText('No Trigger')).toBeInTheDocument());

    const publishBtn = screen.getByTestId('publish-toggle');
    await act(async () => { fireEvent.click(publishBtn); });

    expect(mockToastError).toHaveBeenCalledWith('Add a trigger first.');
    expect(updateWorkflow).not.toHaveBeenCalled();
  });

  it('publishing with a trigger present calls updateWorkflow with isActive=true', async () => {
    getWorkflow.mockResolvedValue({
      workflow: { id: 'w1', name: 'Has Trigger', isActive: false },
      nodes: [
        { id: 'n1', type: 'trigger', kind: 'task_created', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [],
    });
    updateWorkflow.mockResolvedValue({
      workflow: { id: 'w1', name: 'Has Trigger', isActive: true },
    });

    renderCanvas();
    await waitFor(() => expect(screen.getByText('Has Trigger')).toBeInTheDocument());

    const publishBtn = screen.getByTestId('publish-toggle');
    await act(async () => { fireEvent.click(publishBtn); });

    await waitFor(() =>
      // May-26 fix — the page now passes a third `opts` argument carrying
      // a clientMutationId so the canvas can recognise its own save echoes
      // on the workflow:* socket room. The third arg is generated per
      // mutation, so we match it loosely with expect.objectContaining.
      expect(updateWorkflow).toHaveBeenCalledWith(
        'w1',
        { isActive: true },
        expect.objectContaining({ clientMutationId: expect.any(String) }),
      )
    );
    expect(mockToastSuccess).toHaveBeenCalledWith('Workflow published');
  });

  it('shows the load-error empty state when getWorkflow rejects', async () => {
    getWorkflow.mockRejectedValue({
      response: { data: { message: 'Workflow not found' } },
    });

    renderCanvas();
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load this workflow/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/Workflow not found/)).toBeInTheDocument();
  });

  // ── May-26 regression — duplicate-trigger warning + disconnected-node hint ──
  it('shows a duplicate-trigger banner when the persisted graph has >1 trigger', async () => {
    getWorkflow.mockResolvedValue({
      workflow: { id: 'w1', name: 'Has Dupes', isActive: false },
      nodes: [
        { id: 'n1', type: 'trigger', kind: 'task_created', position: { x: 0, y: 0 }, config: {} },
        { id: 'n2', type: 'trigger', kind: 'status_changed', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [],
    });
    renderCanvas();
    await waitFor(() => expect(screen.getByText('Has Dupes')).toBeInTheDocument());
    expect(screen.getByTestId('workflow-duplicate-trigger-banner')).toBeInTheDocument();
  });

  it('shows a disconnected-nodes hint when nodes have no incident edges', async () => {
    getWorkflow.mockResolvedValue({
      workflow: { id: 'w1', name: 'No Edges', isActive: false },
      nodes: [
        { id: 'n1', type: 'trigger', kind: 'task_created', position: { x: 0, y: 0 }, config: {} },
        { id: 'n2', type: 'action',  kind: 'change_status', position: { x: 0, y: 100 }, config: { to: 'done' } },
      ],
      edges: [], // visually stacked but no connection
    });
    renderCanvas();
    await waitFor(() => expect(screen.getByText('No Edges')).toBeInTheDocument());
    const hint = screen.getByTestId('workflow-disconnected-hint');
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveTextContent(/2 nodes are not connected/i);
  });

  it('does NOT show the disconnected-nodes hint when every node has an edge', async () => {
    getWorkflow.mockResolvedValue({
      workflow: { id: 'w1', name: 'Wired', isActive: false },
      nodes: [
        { id: 'n1', type: 'trigger', kind: 'task_created', position: { x: 0, y: 0 }, config: {} },
        { id: 'n2', type: 'action',  kind: 'change_status', position: { x: 0, y: 100 }, config: { to: 'done' } },
      ],
      edges: [{ id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', branch: null }],
    });
    renderCanvas();
    await waitFor(() => expect(screen.getByText('Wired')).toBeInTheDocument());
    expect(screen.queryByTestId('workflow-disconnected-hint')).not.toBeInTheDocument();
  });
});
