import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../common/PortalDropdown', () => ({
  default: ({ open, children }) => (open ? <div data-testid="portal">{children}</div> : null),
}));

import api from '../../../services/api';
import ReferenceCell from '../ReferenceCell';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReferenceCell — display', () => {
  it('shows the Add placeholder when no references exist (editable)', () => {
    render(<ReferenceCell taskId="t1" value={[]} readOnly={false} />);
    expect(screen.getByText('Add')).toBeInTheDocument();
  });

  it('shows em-dash when read-only and empty', () => {
    render(<ReferenceCell taskId="t1" value={[]} readOnly={true} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders the first reference as preview + "+N" badge when multiple', () => {
    render(<ReferenceCell taskId="t1" readOnly={false}
      value={[
        { id: 'r1', text: 'Ticket ABC-123' },
        { id: 'r2', text: 'Invoice #555' },
        { id: 'r3', text: 'Drive doc' },
      ]} />);
    expect(screen.getByText('Ticket ABC-123')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('opens the popover when clicked', () => {
    render(<ReferenceCell taskId="t1" value={[]} readOnly={false} />);
    fireEvent.click(screen.getByText('Add'));
    expect(screen.getByTestId('portal')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Add reference/)).toBeInTheDocument();
  });
});

describe('ReferenceCell — add/remove optimistic flow', () => {
  it('POSTs to /task-references and calls onChange with new list', async () => {
    api.post.mockResolvedValue({
      data: { reference: { id: 'r-new', text: 'Hello', position: 0 } },
    });
    const onChange = vi.fn();
    render(<ReferenceCell taskId="t1" value={[]} readOnly={false} onChange={onChange} />);
    fireEvent.click(screen.getByText('Add'));
    const input = screen.getByPlaceholderText(/Add reference/);
    fireEvent.change(input, { target: { value: 'Hello' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/task-references', { taskId: 't1', text: 'Hello' },
    ));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([
      { id: 'r-new', text: 'Hello', position: 0 },
    ]));
  });

  it('rolls back optimistic delete when API fails', async () => {
    api.delete.mockRejectedValue({ response: { data: { message: 'No permission' } } });
    render(<ReferenceCell taskId="t1" readOnly={false}
      value={[{ id: 'r1', text: 'Doomed' }]} />);
    fireEvent.click(screen.getByText('Doomed'));  // open popover
    const removeBtn = screen.getByLabelText('Remove reference');
    await act(async () => {
      fireEvent.click(removeBtn);
    });
    await waitFor(() => expect(screen.getByText(/No permission/)).toBeInTheDocument());
    // Reference is restored after rollback
    expect(screen.getAllByText('Doomed').length).toBeGreaterThan(0);
  });
});

describe('ReferenceCell — stale-prop latch (P2-5)', () => {
  it('survives parent re-render with stale prop during in-flight mutation', async () => {
    api.post.mockResolvedValue({ data: { reference: { id: 'r-new', text: 'Hello' } } });
    const onChange = vi.fn();
    const { rerender } = render(
      <ReferenceCell taskId="t1" value={[]} readOnly={false} onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Add'));
    const input = screen.getByPlaceholderText(/Add reference/);
    fireEvent.change(input, { target: { value: 'Hello' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    // Parent re-renders with STILL-stale prop (no Hello yet)
    rerender(<ReferenceCell taskId="t1" value={[]} readOnly={false} onChange={onChange} />);
    // onChange was still called with the optimistic list (P2-5 sync skip)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([{ id: 'r-new', text: 'Hello' }]));
  });
});
