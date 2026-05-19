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

  it('calls /ai/plan-week without a frontend task-id hint', async () => {
    // May 2026 — the backend now loads the user's canonical open-task
    // list itself (loadPlanningTaskList) and uses it as the single source
    // of truth for both prompt context AND ID validation. The frontend
    // hint list (loaded from /tasks?assignedTo=me&limit=100 with no status
    // filter) used to disagree with the backend's filter, confusing the
    // LLM and triggering "No task IDs from the provided list match the
    // current open tasks". The modal should NO LONGER send a taskIds hint.
    aiSummary.planWeek.mockResolvedValue({ schedule: [], notes: 'no plan' });
    render(<PlanWeekModal isOpen onClose={() => {}} tasks={TASKS} />);
    await waitFor(() => {
      expect(aiSummary.planWeek).toHaveBeenCalled();
    });
    const callArg = aiSummary.planWeek.mock.calls[0][0] || {};
    expect(callArg.taskIds).toBeUndefined();
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

  it('renders the notes-driven empty state when every day has no tasks', async () => {
    // After the May 2026 fix the all-days-empty case shows the backend's
    // notes string directly (e.g. "No open tasks to plan — your queue is
    // empty.") instead of five "Nothing scheduled." cards, because the
    // backend now provides a clear human-readable reason.
    aiSummary.planWeek.mockResolvedValue({
      schedule: [
        { dayKey: 'mon', taskIds: [], reason: '' },
        { dayKey: 'tue', taskIds: [], reason: '' },
        { dayKey: 'wed', taskIds: [], reason: '' },
        { dayKey: 'thu', taskIds: [], reason: '' },
        { dayKey: 'fri', taskIds: [], reason: '' },
      ],
      notes: 'No open tasks to plan — your queue is empty.',
    });
    render(<PlanWeekModal isOpen onClose={() => {}} tasks={TASKS} />);
    await waitFor(() => {
      expect(screen.getByText(/queue is empty/)).toBeInTheDocument();
    });
  });

  it('renders error message when plan-week fails', async () => {
    aiSummary.planWeek.mockRejectedValue({ response: { data: { message: 'AI quota exhausted' } } });
    render(<PlanWeekModal isOpen onClose={() => {}} tasks={TASKS} />);
    await waitFor(() => expect(screen.getByText('AI quota exhausted')).toBeInTheDocument());
  });

  it('shows the notes line as the empty-state body when AI returns an empty schedule', async () => {
    aiSummary.planWeek.mockResolvedValue({ schedule: [], notes: 'AI returned no plan.' });
    render(<PlanWeekModal isOpen onClose={() => {}} tasks={TASKS} />);
    await waitFor(() => expect(screen.getByText('AI returned no plan.')).toBeInTheDocument());
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
