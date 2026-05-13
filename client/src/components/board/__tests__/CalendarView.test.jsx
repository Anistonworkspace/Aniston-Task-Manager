import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Framer-motion ships as ESM; in jsdom we shortcut it to plain DOM so the
// Modal renders synchronously and tests don't have to wait for animations.
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => ({ children, ...props }) => <div {...props}>{children}</div>,
  }),
  AnimatePresence: ({ children }) => <>{children}</>,
}));

import CalendarView from '../CalendarView';

// Anchor "today" so the calendar always renders the same window in CI.
// The chosen date matches the screenshots the user attached (May 13 2026).
const FROZEN_NOW = new Date(2026, 4, 13, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FROZEN_NOW);
});

function makeTask(over = {}) {
  return {
    id: 'task-x',
    title: 'Task',
    status: 'not_started',
    priority: 'medium',
    dueDate: '2026-05-14T00:00:00.000Z',
    ...over,
  };
}

describe('CalendarView — date click opens dialog', () => {
  it('clicking a date with multiple tasks opens the date-task list dialog', () => {
    const tasks = [
      makeTask({ id: 't1', title: 'fgl', dueDate: '2026-05-14T00:00:00.000Z' }),
      makeTask({ id: 't2', title: 'second', dueDate: '2026-05-14T00:00:00.000Z' }),
      makeTask({ id: 't3', title: 'third', dueDate: '2026-05-14T00:00:00.000Z' }),
    ];
    const onTaskClick = vi.fn();
    render(<CalendarView tasks={tasks} members={[]} onTaskClick={onTaskClick} />);

    fireEvent.click(screen.getByTestId('cal-cell-2026-05-14'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Tasks on May 14, 2026/)).toBeInTheDocument();
    expect(screen.getByText('3 tasks due')).toBeInTheDocument();
    expect(screen.getAllByTestId('date-task-row')).toHaveLength(3);
    expect(onTaskClick).not.toHaveBeenCalled();
  });

  it('clicking a task row inside the dialog opens that exact task (not the first)', () => {
    const tasks = [
      makeTask({ id: 't1', title: 'fgl', dueDate: '2026-05-14T00:00:00.000Z' }),
      makeTask({ id: 't2', title: 'second', dueDate: '2026-05-14T00:00:00.000Z' }),
      makeTask({ id: 't3', title: 'third', dueDate: '2026-05-14T00:00:00.000Z' }),
    ];
    const onTaskClick = vi.fn();
    render(<CalendarView tasks={tasks} members={[]} onTaskClick={onTaskClick} />);

    fireEvent.click(screen.getByTestId('cal-cell-2026-05-14'));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByText('second').closest('button'));

    expect(onTaskClick).toHaveBeenCalledTimes(1);
    expect(onTaskClick).toHaveBeenCalledWith(expect.objectContaining({ id: 't2', title: 'second' }));
  });

  it('single-task date still routes through the dialog (consistent UX)', () => {
    const tasks = [makeTask({ id: 'only', title: 'either', dueDate: '2026-05-31T00:00:00.000Z' })];
    const onTaskClick = vi.fn();
    render(<CalendarView tasks={tasks} members={[]} onTaskClick={onTaskClick} />);

    fireEvent.click(screen.getByTestId('cal-cell-2026-05-31'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onTaskClick).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('date-task-row')).toHaveLength(1);
  });

  it('clicking an empty date does not crash and does not open the dialog', () => {
    const onTaskClick = vi.fn();
    render(<CalendarView tasks={[]} members={[]} onTaskClick={onTaskClick} />);

    // An empty cell is disabled; fireEvent.click on a disabled button is a
    // no-op in jsdom — verify by absence of dialog rather than throwing.
    const emptyCell = screen.getByTestId('cal-cell-2026-05-14');
    expect(emptyCell).toBeDisabled();
    fireEvent.click(emptyCell);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onTaskClick).not.toHaveBeenCalled();
  });

  it('renders +N suffix when a date has multiple tasks', () => {
    const tasks = [
      makeTask({ id: 'a', title: 'fgl', dueDate: '2026-05-14T00:00:00.000Z' }),
      makeTask({ id: 'b', title: 'two', dueDate: '2026-05-14T00:00:00.000Z' }),
      makeTask({ id: 'c', title: 'three', dueDate: '2026-05-14T00:00:00.000Z' }),
    ];
    render(<CalendarView tasks={tasks} members={[]} onTaskClick={vi.fn()} />);

    const cell = screen.getByTestId('cal-cell-2026-05-14');
    expect(within(cell).getByText('fgl')).toBeInTheDocument();
    expect(within(cell).getByText(/\+2/)).toBeInTheDocument();
  });

  it('does not render filter chips or a header Today button', () => {
    render(<CalendarView tasks={[]} members={[]} onTaskClick={vi.fn()} />);
    expect(screen.queryByText('Filter')).not.toBeInTheDocument();
    expect(screen.queryByText('Mine')).not.toBeInTheDocument();
    expect(screen.queryByText('High priority')).not.toBeInTheDocument();
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    expect(screen.queryByText('All')).not.toBeInTheDocument();
    // Header should still expose prev/next, but no "Today" button.
    expect(screen.getByLabelText('Previous month')).toBeInTheDocument();
    expect(screen.getByLabelText('Next month')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^today$/i })).not.toBeInTheDocument();
  });
});
