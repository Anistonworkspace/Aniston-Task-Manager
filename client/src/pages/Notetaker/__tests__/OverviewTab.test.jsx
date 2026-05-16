import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, ...rest }, ref) =>
      React.createElement(tag, { ref, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import OverviewTab from '../OverviewTab';

describe('OverviewTab', () => {
  it('renders empty state when there is no summary and transcript is unavailable', () => {
    render(<OverviewTab meeting={{ title: 'X' }} transcriptStatus="unavailable" />);
    expect(screen.getByText('No summary yet')).toBeInTheDocument();
  });

  it('renders the summary text when meeting.summary is set', () => {
    render(
      <OverviewTab
        meeting={{ title: 'X', summary: 'We discussed the roadmap and aligned on Q3 deliverables.' }}
        transcriptStatus="ok"
      />
    );
    expect(screen.getByText(/We discussed the roadmap/)).toBeInTheDocument();
  });

  it('shows loading state while transcript is loading', () => {
    render(<OverviewTab meeting={{ title: 'X' }} transcriptStatus="loading" />);
    expect(screen.getByText('Looking for transcript…')).toBeInTheDocument();
  });

  it('renders the summary templates dropdown', () => {
    render(<OverviewTab meeting={{ title: 'X', summary: 'body' }} transcriptStatus="ok" />);
    fireEvent.click(screen.getByText('Summary templates'));
    expect(screen.getByText('Decision log')).toBeInTheDocument();
    expect(screen.getByText('Customer call')).toBeInTheDocument();
  });
});
