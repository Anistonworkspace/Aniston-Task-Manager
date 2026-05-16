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

import TranscriptTab from '../TranscriptTab';

const SEGMENTS = [
  { id: 's1', speakerLabel: 'Alice', startMs: 0,     endMs: 5000,  text: 'Hello team' },
  { id: 's2', speakerLabel: 'Bob',   startMs: 5000,  endMs: 12000, text: 'Hi Alice, ready to start?' },
  { id: 's3', speakerLabel: 'Alice', startMs: 12000, endMs: 20000, text: 'Yes, let us begin the strategy review' },
];

describe('TranscriptTab', () => {
  it('renders empty state when status is unavailable', () => {
    render(<TranscriptTab segments={[]} status="unavailable" />);
    expect(screen.getByText('No transcript yet')).toBeInTheDocument();
  });

  it('renders empty state when there are zero segments even on idle status', () => {
    render(<TranscriptTab segments={[]} status="idle" />);
    expect(screen.getByText('No transcript yet')).toBeInTheDocument();
  });

  it('renders speaker labels + text for each segment', () => {
    render(<TranscriptTab segments={SEGMENTS} status="ok" />);
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    expect(screen.getByText('Hello team')).toBeInTheDocument();
    expect(screen.getByText('Hi Alice, ready to start?')).toBeInTheDocument();
  });

  it('renders timestamps in m:ss form', () => {
    render(<TranscriptTab segments={SEGMENTS} status="ok" />);
    expect(screen.getByText('0:00')).toBeInTheDocument();
    expect(screen.getByText('0:05')).toBeInTheDocument();
    expect(screen.getByText('0:12')).toBeInTheDocument();
  });

  it('filters segments by speaker', () => {
    render(<TranscriptTab segments={SEGMENTS} status="ok" />);
    fireEvent.change(screen.getByLabelText('Filter by speaker'), { target: { value: 'Bob' } });
    expect(screen.getByText('Hi Alice, ready to start?')).toBeInTheDocument();
    expect(screen.queryByText('Hello team')).not.toBeInTheDocument();
  });

  it('filters segments by search query and shows match count', () => {
    render(<TranscriptTab segments={SEGMENTS} status="ok" />);
    fireEvent.change(screen.getByLabelText('Search transcript'), { target: { value: 'strategy' } });
    expect(screen.getByText('1 match')).toBeInTheDocument();
    expect(screen.queryByText('Hello team')).not.toBeInTheDocument();
  });
});
