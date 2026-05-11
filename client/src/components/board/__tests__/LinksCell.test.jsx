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
import LinksCell from '../LinksCell';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LinksCell — display', () => {
  it('shows Add when empty + editable', () => {
    render(<LinksCell taskId="t1" value={[]} readOnly={false} />);
    expect(screen.getByText('Add')).toBeInTheDocument();
  });

  it('renders all link anchors with rel="noopener noreferrer" target="_blank"', () => {
    render(<LinksCell taskId="t1" readOnly={false}
      value={[{ id: 'lk1', url: 'https://example.com/a', title: 'Example A' }]} />);
    fireEvent.click(screen.getByText('Example A'));   // open popover
    const anchor = screen.getByRole('link', { name: /Example A/ });
    expect(anchor).toHaveAttribute('target', '_blank');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    expect(anchor).toHaveAttribute('href', 'https://example.com/a');
  });

  it('renders +N badge when more than one link exists', () => {
    render(<LinksCell taskId="t1" readOnly={false}
      value={[
        { id: 'lk1', url: 'https://a.com', title: 'A' },
        { id: 'lk2', url: 'https://b.com', title: 'B' },
        { id: 'lk3', url: 'https://c.com', title: 'C' },
      ]} />);
    expect(screen.getByText('+2')).toBeInTheDocument();
  });
});

describe('LinksCell — add link flow', () => {
  it('sends URL to /task-links and calls onChange', async () => {
    api.post.mockResolvedValue({
      data: { link: { id: 'lk-new', url: 'https://x.com', title: null } },
    });
    const onChange = vi.fn();
    render(<LinksCell taskId="t1" value={[]} readOnly={false} onChange={onChange} />);
    fireEvent.click(screen.getByText('Add'));
    const input = screen.getByPlaceholderText(/https/);
    fireEvent.change(input, { target: { value: 'https://x.com' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/task-links', expect.objectContaining({ taskId: 't1', url: 'https://x.com' }),
    ));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it('shows server error when API rejects (e.g. private IP)', async () => {
    api.post.mockRejectedValue({
      response: { data: { message: 'Internal or private hostnames are not allowed.' } },
    });
    render(<LinksCell taskId="t1" value={[]} readOnly={false} />);
    fireEvent.click(screen.getByText('Add'));
    const input = screen.getByPlaceholderText(/https/);
    fireEvent.change(input, { target: { value: 'http://10.0.0.1' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    await waitFor(() => expect(screen.getByText(/private hostnames/)).toBeInTheDocument());
  });
});
