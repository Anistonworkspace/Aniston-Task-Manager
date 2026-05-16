import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, onKeyDown, ...rest }, ref) =>
      React.createElement(tag, { ref, onKeyDown, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

import DatePicker from '../DatePicker';

describe('DatePicker', () => {
  it('renders placeholder when no value', () => {
    render(<DatePicker value={null} onChange={() => {}} placeholder="Pick a date" />);
    expect(screen.getByText('Pick a date')).toBeInTheDocument();
  });

  it('renders formatted value', () => {
    const date = new Date(2026, 4, 16); // May 16 2026
    render(<DatePicker value={date} onChange={() => {}} />);
    expect(screen.getByText(/May 16, 2026/)).toBeInTheDocument();
  });

  it('opens the calendar on trigger click', async () => {
    render(<DatePicker value={null} onChange={() => {}} placeholder="Pick" />);
    fireEvent.click(screen.getByText('Pick'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Previous month/ })).toBeInTheDocument();
    });
  });

  it('calls onChange when Today is clicked', async () => {
    const onChange = vi.fn();
    render(<DatePicker value={null} onChange={onChange} placeholder="Pick" />);
    fireEvent.click(screen.getByText('Pick'));
    await waitFor(() => screen.getByText('Today'));
    fireEvent.click(screen.getByText('Today'));
    expect(onChange).toHaveBeenCalled();
    const arg = onChange.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Date);
  });

  it('clears the value when Clear is clicked', async () => {
    const onChange = vi.fn();
    const date = new Date(2026, 4, 16);
    render(<DatePicker value={date} onChange={onChange} />);
    fireEvent.click(screen.getByText(/May 16, 2026/));
    await waitFor(() => screen.getByText('Clear'));
    fireEvent.click(screen.getByText('Clear'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows time toggle when includeTime is true', async () => {
    const date = new Date(2026, 4, 16, 14, 30);
    render(<DatePicker value={date} onChange={() => {}} includeTime />);
    fireEvent.click(screen.getByText(/May 16, 2026/));
    await waitFor(() => {
      expect(screen.getByText('Time')).toBeInTheDocument();
    });
  });
});
