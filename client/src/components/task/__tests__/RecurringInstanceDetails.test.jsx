import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import RecurringInstanceDetails from '../RecurringInstanceDetails';

// These tests verify the schedule-summary panel rendering contract for the
// task detail modal. The component is pure — no fetches, no socket
// listeners — so behaviour can be exercised end-to-end with React Testing
// Library.
//
// The post-2026-05-09 contract removes Board / Group / Priority / Template-
// title from the panel — those fields live elsewhere in the modal — so the
// suite asserts BOTH presence (frequency, occurrence, due time, window,
// last, next, status) AND absence (board / group / priority / template
// title row).

describe('RecurringInstanceDetails', () => {
  function baseTask(overrides = {}) {
    return {
      id: 't-1',
      title: 'HOLIDAY',
      isRecurringInstance: true,
      occurrenceDate: '2026-05-15',
      dueDate: '2026-05-15',
      groupId: 'g-1',
      ...overrides,
    };
  }

  function baseTemplate(overrides = {}) {
    return {
      id: 'tpl-1',
      title: 'HOLIDAY',
      frequency: 'monthly',
      daysOfMonth: [5, 15, 25],
      dueTime: '17:10:00',
      timezone: 'Asia/Calcutta',
      startDate: '2026-05-08',
      endDate: null,
      priority: 'medium',
      groupId: 'g-1',
      isActive: true,
      archivedAt: null,
      lastGeneratedDate: '2026-05-08',
      nextRunAt: '2026-05-09T00:05:00Z',
      ...overrides,
    };
  }

  const board = { id: 'b-1', name: 'Delhi', groups: [{ id: 'g-1', title: 'New Task' }] };

  it('renders the compact heading and frequency for a monthly template', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate()}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText(/Recurring Schedule/i)).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText(/Day 5, Day 15, Day 25/)).toBeInTheDocument();
  });

  it('renders the Active state pill', () => {
    render(<RecurringInstanceDetails task={baseTask()} template={baseTemplate()} board={board} canManageTemplate={true} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows "Paused" when template.isActive=false', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate({ isActive: false })}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('shows "Archived" when template.archivedAt is set', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate({ archivedAt: '2026-05-01T00:00:00Z' })}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('renders due time with timezone', () => {
    render(<RecurringInstanceDetails task={baseTask()} template={baseTemplate()} board={board} canManageTemplate={true} />);
    expect(screen.getByText(/5:10 PM \(Asia\/Calcutta\)/)).toBeInTheDocument();
  });

  it('renders "no end" suffix when endDate is null', () => {
    render(<RecurringInstanceDetails task={baseTask()} template={baseTemplate()} board={board} canManageTemplate={true} />);
    expect(screen.getByText(/2026-05-08 → no end/)).toBeInTheDocument();
  });

  it('renders the window with both start and end when set', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate({ endDate: '2026-12-31' })}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText(/2026-05-08 → 2026-12-31/)).toBeInTheDocument();
  });

  it('renders "Not scheduled" when nextRunAt is null', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate({ nextRunAt: null })}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText('Not scheduled')).toBeInTheDocument();
  });

  it('weekdays template shows the Mon–Sat hint', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate({ frequency: 'weekdays', daysOfMonth: [] })}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText('Weekdays')).toBeInTheDocument();
    expect(screen.getByText(/Mon\s*[–-]\s*Sat/)).toBeInTheDocument();
  });

  it('weekly template shows "Custom days" with selected days', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate({ frequency: 'weekly', weekdays: [1, 3, 5], daysOfMonth: [] })}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText('Custom days')).toBeInTheDocument();
    expect(screen.getByText('Mon, Wed, Fri')).toBeInTheDocument();
  });

  it('daily template shows "Every day"', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate({ frequency: 'daily', daysOfMonth: [] })}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.getByText('Every day')).toBeInTheDocument();
  });

  it('monthly with legacy single dayOfMonth integer renders correctly', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate({ daysOfMonth: [], dayOfMonth: 15 })}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText('Day 15')).toBeInTheDocument();
  });

  it('renders the fallback card when template is not available', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={null}
        templateLoading={false}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText('Recurring task instance')).toBeInTheDocument();
    expect(screen.getByText(/May 15, 2026/)).toBeInTheDocument();
  });

  it('renders the loading skeleton when templateLoading=true', () => {
    const { container } = render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={null}
        templateLoading={true}
        board={board}
        canManageTemplate={true}
      />
    );
    // 6 placeholder rows in the new compact skeleton
    expect(container.querySelectorAll('.animate-pulse > div').length).toBe(6);
  });

  it('hides the manage link when canManageTemplate=false', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate()}
        board={board}
        canManageTemplate={false}
      />
    );
    expect(screen.queryByText('Manage')).not.toBeInTheDocument();
  });

  it('shows the manage link when canManageTemplate=true', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate()}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getByText('Manage')).toBeInTheDocument();
  });

  it('renders "Occurrence" using the task occurrenceDate', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask({ occurrenceDate: '2026-05-15' })}
        template={baseTemplate()}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.getAllByText(/May 15, 2026/).length).toBeGreaterThan(0);
  });

  // ── absence assertions for the fields removed in the compact rewrite ─────

  it('does NOT render the Board field', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate()}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.queryByText('Board')).not.toBeInTheDocument();
    expect(screen.queryByText('Delhi')).not.toBeInTheDocument();
  });

  it('does NOT render the Group field', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate()}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.queryByText('Group')).not.toBeInTheDocument();
    expect(screen.queryByText('New Task')).not.toBeInTheDocument();
  });

  it('does NOT render the Priority field', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask()}
        template={baseTemplate()}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.queryByText('Priority')).not.toBeInTheDocument();
    // 'medium' label still appears nowhere in this card
    expect(screen.queryByText('medium')).not.toBeInTheDocument();
  });

  it('does NOT render a Template title row even when distinct from task title', () => {
    render(
      <RecurringInstanceDetails
        task={baseTask({ title: 'Renamed instance' })}
        template={baseTemplate({ title: 'HOLIDAY' })}
        board={board}
        canManageTemplate={true}
      />
    );
    expect(screen.queryByText('Template title')).not.toBeInTheDocument();
  });
});
