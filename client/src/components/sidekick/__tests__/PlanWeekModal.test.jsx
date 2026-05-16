import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, onClick, role, 'aria-modal': am, 'aria-label': al, className, style, ...rest }, ref) =>
      React.createElement(tag, { ref, onClick, role, 'aria-modal': am, 'aria-label': al, className, style }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

vi.mock('../../../utils/animations', () => ({
  modalOverlay: {},
  modalContent: {},
}));

vi.mock('../../../services/aiSummaryService', () => ({
  default: { planWeek: vi.fn() },
}));

import PlanWeekModal from '../PlanWeekModal';
import aiSummary from '../../../services/aiSummaryService';

const TASKS = [
  { id: 't1', title: 'Ship launch email',   priority: 'high',     status: 'working_on_it' },
  { id: 't2', title: 'QA the release',      priority: 'medium',   status: 'not_started'   },
  { id: 't3', title: 'Onboarding doc',      priority: 'low',      status: 'review'        },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PlanWeekModal', () => {
  it('does not render when closed', () => {
    render(<PlanWeekModal isOpen={false} onClose={() => {}} tasks={TASKS} />);
    expect(screen.queryByText('Plan my week')).not.toBeInTheDocument();
  });

  it('calls /ai/plan-week with the user task ids on open', async () => {
    aiSummary.planWeek.mockResolvedValue({ schedule: [], notes: 'no plan' });
    render(<PlanWeekModal isOpen onClose={() => {}} tasks={TASKS} />);
    await waitFor(() => {
      expect(aiSummary.planWeek).toHaveBeenCalledWith(
        expect.objectContaining({ taskIds: ['t1', 't2', 't3'] })
      );
    });
  });

  it('renders day columns with task titles when schedule is returned', async () => {
    aiSummary.planWeek.mockResolvedValue({
      schedule: [
        { dayKey: 'mon', taskIds: ['t1'], reason: 'high priority first' },
        { dayKey: 'tue', taskIds: ['t2'], reason: '' },
        { dayKey: 'wed', taskIds: [], reason: '' },
        { dayKey: 'thu', taskIds: [], reason: '' },
        { dayKey: 'fri', taskIds: ['t3'], reason: '' },
      ],
      notes: 'Looks balanced.',
    });
    render(<PlanWeekModal isOpen onClose={() => {}} tasks={TASKS} />);
    await waitFor(() => expect(screen.getByText('Ship launch email')).toBeInTheDocument());
    expect(screen.getByText('QA the release')).toBeInTheDocument();
    expect(screen.getByText('Onboarding doc')).toBeInTheDocument();
    expect(screen.getByText(/Looks balanced/)).toBeInTheDocument();
  });

  it('renders empty-day message for days with no tasks', async () => {
    aiSummary.planWeek.mockResolvedValue({
      schedule: [
        { dayKey: 'mon', taskIds: [], reason: '' },
        { dayKey: 'tue', taskIds: [], reason: '' },
        { dayKey: 'wed', taskIds: [], reason: '' },
        { dayKey: 'thu', taskIds: [], reason: '' },
        { dayKey: 'fri', taskIds: [], reason: '' },
      ],
    });
    render(<PlanWeekModal isOpen onClose={() => {}} tasks={TASKS} />);
    await waitFor(() => {
      const emptyHints = screen.getAllByText('Nothing scheduled.');
      expect(emptyHints.length).toBe(5);
    });
  });

  it('renders error message when plan-week fails', async () => {
    aiSummary.planWeek.mockRejectedValue({ response: { data: { message: 'AI quota exhausted' } } });
    render(<PlanWeekModal isOpen onClose={() => {}} tasks={TASKS} />);
    await waitFor(() => expect(screen.getByText('AI quota exhausted')).toBeInTheDocument());
  });

  it('shows fallback panel when AI returns an empty schedule with a notes line', async () => {
    aiSummary.planWeek.mockResolvedValue({ schedule: [], notes: 'AI returned no plan.' });
    render(<PlanWeekModal isOpen onClose={() => {}} tasks={TASKS} />);
    await waitFor(() => expect(screen.getByText(/didn't suggest a structured plan/)).toBeInTheDocument());
    expect(screen.getByText('AI returned no plan.')).toBeInTheDocument();
  });

  it('regenerate button re-triggers the plan call', async () => {
    aiSummary.planWeek
      .mockResolvedValueOnce({ schedule: [{ dayKey: 'mon', taskIds: ['t1'], reason: '' }] })
      .mockResolvedValueOnce({ schedule: [{ dayKey: 'mon', taskIds: ['t2'], reason: '' }] });
    render(<PlanWeekModal isOpen onClose={() => {}} tasks={TASKS} />);
    await waitFor(() => expect(screen.getByText('Ship launch email')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Regenerate plan'));
    await waitFor(() => expect(screen.getByText('QA the release')).toBeInTheDocument());
    expect(aiSummary.planWeek).toHaveBeenCalledTimes(2);
  });
});
