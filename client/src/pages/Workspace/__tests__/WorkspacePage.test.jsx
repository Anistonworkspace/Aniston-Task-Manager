import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, ...rest }, ref) =>
      React.createElement(tag, { ref, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

vi.mock('../../../services/api', () => ({
  default: { get: vi.fn(), put: vi.fn() },
}));

vi.mock('../../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import WorkspacePage from '../WorkspacePage';
import api from '../../../services/api';
import { useAuth } from '../../../context/AuthContext';

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({
    user: { id: 'u1', name: 'Test User' },
    isSuperAdmin: false,
  });
});

function renderAt(workspaceId = 'w1') {
  return render(
    <MemoryRouter initialEntries={[`/workspaces/${workspaceId}`]}>
      <Routes>
        <Route path="/workspaces/:id" element={<WorkspacePage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('WorkspacePage', () => {
  it('shows loading skeleton initially', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    const { container } = renderAt();
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('renders workspace name and description on load', async () => {
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          workspace: {
            id: 'w1',
            name: 'Acme',
            description: 'The Acme team workspace',
            createdBy: 'u1',
            boards: [],
            workspaceMembers: [],
          },
        },
      },
    });
    renderAt();
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    expect(screen.getByText('The Acme team workspace')).toBeInTheDocument();
  });

  it('renders empty Recents tab when no boards', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { workspace: { id: 'w1', name: 'Empty', boards: [], workspaceMembers: [] } } },
    });
    renderAt();
    await waitFor(() => screen.getByText('Empty'));
    expect(screen.getByText('No recent activity')).toBeInTheDocument();
  });

  it('shows boards in Recents and lets user click into them', async () => {
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          workspace: {
            id: 'w1',
            name: 'Acme',
            boards: [
              { id: 'b1', name: 'Sprint board', color: '#579bfc' },
              { id: 'b2', name: 'Backlog', color: '#fdab3d' },
            ],
            workspaceMembers: [],
            createdBy: 'u1',
          },
        },
      },
    });
    renderAt();
    await waitFor(() => screen.getByText('Sprint board'));
    expect(screen.getByText('Backlog')).toBeInTheDocument();
  });

  it('switches to Permissions tab and shows members table', async () => {
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          workspace: {
            id: 'w1',
            name: 'Acme',
            boards: [],
            createdBy: 'u1',
            workspaceMembers: [
              { id: 'u1', name: 'Alice', email: 'a@x.com', workspaceMember: { role: 'owner' } },
              { id: 'u2', name: 'Bob', email: 'b@x.com', workspaceMember: { role: 'member' } },
            ],
          },
        },
      },
    });
    renderAt();
    await waitFor(() => screen.getByText('Acme'));
    fireEvent.click(screen.getByText('Permissions'));
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('renders fallback when API errors', async () => {
    api.get.mockRejectedValue({ response: { data: { message: 'Not found' } } });
    renderAt();
    await waitFor(() => expect(screen.getByText("Couldn't load this workspace")).toBeInTheDocument());
  });
});
