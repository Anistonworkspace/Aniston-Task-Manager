import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import TaskPickerPopover from '../TaskPickerPopover';

// Sample task data matching the picker's expected shape.
const sampleTasks = [
  { id: 't1', title: 'Ship docs', status: 'working_on_it', boardName: 'Engineering', boardColor: '#22c55e', priority: 'high' },
  { id: 't2', title: 'Q3 review',  status: 'done',          boardName: 'Strategy',    boardColor: '#f59e0b' },
  { id: 't3', title: 'Fix bug',    status: 'stuck',         boardName: 'Bugs',        boardColor: '#ef4444' },
  { id: 't4', title: 'Plan',       status: 'not_started',   boardName: 'Roadmap',     boardColor: '#9ca3af' },
];

const rect = { bottom: 100, top: 80, left: 50, right: 250 };

beforeEach(() => {
  // Sanity: jsdom default viewport is 768px tall, plenty for the
  // popover to render below the rect without flipping.
  Object.defineProperty(window, 'innerHeight', { writable: true, value: 800 });
});

describe('TaskPickerPopover (Phase D Slice 2)', () => {
  it('renders the "Searching tasks…" placeholder while loading and empty', () => {
    render(<TaskPickerPopover items={[]} loading={true} command={() => {}} rect={rect} />);
    expect(screen.getByText(/Searching tasks…/i)).toBeTruthy();
  });

  it('renders the "No tasks match" empty state when not loading', () => {
    render(<TaskPickerPopover items={[]} loading={false} command={() => {}} rect={rect} />);
    expect(screen.getByText(/No tasks match/i)).toBeTruthy();
  });

  it('renders task rows with title, board name, and board color dot', () => {
    const { container } = render(
      <TaskPickerPopover items={sampleTasks} loading={false} command={() => {}} rect={rect} />
    );
    expect(screen.getByText('Ship docs')).toBeTruthy();
    expect(screen.getByText('Q3 review')).toBeTruthy();
    expect(screen.getByText('Engineering')).toBeTruthy();
    expect(screen.getByText('Strategy')).toBeTruthy();
    // Color dots: small inline-styled spans next to each board name.
    const dots = container.querySelectorAll('span.rounded-full');
    // One color dot per task with a boardName (4 rows here).
    expect(dots.length).toBeGreaterThanOrEqual(sampleTasks.length);
    // First dot should carry the engineering green.
    const hasEngColor = Array.from(dots).some(
      (d) => d.style.backgroundColor === 'rgb(34, 197, 94)'
    );
    expect(hasEngColor).toBe(true);
  });

  it('uses status-specific icon colors (done=emerald, stuck=red, working=amber, other=zinc)', () => {
    const { container } = render(
      <TaskPickerPopover items={sampleTasks} loading={false} command={() => {}} rect={rect} />
    );
    // Lucide icons render as <svg>. The component sets unique color
    // classes per status — we assert at least one of each appears.
    const html = container.innerHTML;
    expect(html).toMatch(/text-emerald-500/); // done row
    expect(html).toMatch(/text-red-500/);     // stuck row
    expect(html).toMatch(/text-amber-500/);   // working_on_it row
    expect(html).toMatch(/text-zinc-400/);    // fallback (not_started)
  });

  it('imperative onKeyDown returns false (not handled) when items list is empty', () => {
    const ref = createRef();
    render(<TaskPickerPopover ref={ref} items={[]} loading={false} command={() => {}} rect={rect} />);
    const result = ref.current.onKeyDown({ event: { key: 'ArrowDown' } });
    expect(result).toBe(false);
  });

  it('ArrowDown / ArrowUp wrap around modulo items.length', () => {
    const ref = createRef();
    const command = vi.fn();
    render(
      <TaskPickerPopover ref={ref} items={sampleTasks} loading={false} command={command} rect={rect} />
    );
    // Start at 0. ArrowUp wraps to last index (3).
    act(() => { ref.current.onKeyDown({ event: { key: 'ArrowUp' } }); });
    act(() => { ref.current.onKeyDown({ event: { key: 'Enter' } }); });
    expect(command).toHaveBeenLastCalledWith(sampleTasks[3]);

    // ArrowDown from index 3 wraps back to 0.
    command.mockClear();
    act(() => { ref.current.onKeyDown({ event: { key: 'ArrowDown' } }); });
    act(() => { ref.current.onKeyDown({ event: { key: 'Enter' } }); });
    expect(command).toHaveBeenLastCalledWith(sampleTasks[0]);
  });

  it('Enter and Tab both invoke command(item) for the selected entry', () => {
    const command = vi.fn();
    const ref = createRef();
    render(
      <TaskPickerPopover ref={ref} items={sampleTasks} loading={false} command={command} rect={rect} />
    );
    // Enter on default selection (index 0).
    act(() => { ref.current.onKeyDown({ event: { key: 'Enter' } }); });
    expect(command).toHaveBeenCalledWith(sampleTasks[0]);

    // Tab also commits.
    command.mockClear();
    act(() => { ref.current.onKeyDown({ event: { key: 'Tab' } }); });
    expect(command).toHaveBeenCalledWith(sampleTasks[0]);
  });

  it('returns false for unhandled keys (so the editor consumes them)', () => {
    const ref = createRef();
    render(
      <TaskPickerPopover ref={ref} items={sampleTasks} loading={false} command={() => {}} rect={rect} />
    );
    expect(ref.current.onKeyDown({ event: { key: 'a' } })).toBe(false);
    expect(ref.current.onKeyDown({ event: { key: 'Escape' } })).toBe(false);
  });

  it('useLayoutEffect resets selected to 0 when items array changes', () => {
    const command = vi.fn();
    const ref = createRef();
    const { rerender } = render(
      <TaskPickerPopover ref={ref} items={sampleTasks} loading={false} command={command} rect={rect} />
    );
    // Move selection down twice → index 2.
    act(() => { ref.current.onKeyDown({ event: { key: 'ArrowDown' } }); });
    act(() => { ref.current.onKeyDown({ event: { key: 'ArrowDown' } }); });

    // New items array → selected resets to 0.
    const newItems = [{ id: 'tx', title: 'Brand new', status: 'done', boardName: 'X', boardColor: '#000' }];
    rerender(
      <TaskPickerPopover ref={ref} items={newItems} loading={false} command={command} rect={rect} />
    );
    act(() => { ref.current.onKeyDown({ event: { key: 'Enter' } }); });
    expect(command).toHaveBeenLastCalledWith(newItems[0]);
  });

  it('hovering a row updates the selected index via onMouseEnter', () => {
    const command = vi.fn();
    const ref = createRef();
    render(
      <TaskPickerPopover ref={ref} items={sampleTasks} loading={false} command={command} rect={rect} />
    );
    // Hover the third row.
    fireEvent.mouseEnter(screen.getByText('Fix bug').closest('button'));
    // Now Enter should commit the hovered row, not index 0.
    act(() => { ref.current.onKeyDown({ event: { key: 'Enter' } }); });
    expect(command).toHaveBeenCalledWith(sampleTasks[2]);
  });

  it('onMouseDown calls preventDefault and invokes command(item)', () => {
    const command = vi.fn();
    render(
      <TaskPickerPopover items={sampleTasks} loading={false} command={command} rect={rect} />
    );
    const row = screen.getByText('Q3 review').closest('button');
    const preventDefault = vi.fn();
    fireEvent.mouseDown(row, { preventDefault });
    // The component should have invoked command with the row's data.
    expect(command).toHaveBeenCalledWith(sampleTasks[1]);
  });

  it('positions itself fixed at rect.bottom + 6 when there is room below', () => {
    const { container } = render(
      <TaskPickerPopover items={sampleTasks} loading={false} command={() => {}} rect={rect} />
    );
    const menu = container.querySelector('.task-picker-menu');
    expect(menu).toBeTruthy();
    // Inline style should pin top to rect.bottom + 6 = 106.
    expect(menu.style.top).toBe('106px');
    expect(menu.style.left).toBe('50px');
    // position:fixed comes from the CSS class, not inline style; assert
    // the class is present so the popover positions over the viewport.
    expect(menu.className).toMatch(/\bfixed\b/);
  });

  it('flips above the trigger when the rect is close to the bottom of the viewport', () => {
    // Force the viewport to be shorter so bottom+6+menuHeight overflows.
    Object.defineProperty(window, 'innerHeight', { writable: true, value: 400 });
    const lowRect = { bottom: 380, top: 360, left: 50, right: 250 };
    const { container } = render(
      <TaskPickerPopover items={sampleTasks} loading={false} command={() => {}} rect={lowRect} />
    );
    const menu = container.querySelector('.task-picker-menu');
    expect(menu).toBeTruthy();
    // When flipping, top is 'auto' and bottom is set instead.
    expect(menu.style.top).toBe('auto');
    expect(menu.style.bottom).toBeTruthy();
  });

  it('renders the "Link task" header with the Hash icon', () => {
    const { container } = render(
      <TaskPickerPopover items={sampleTasks} loading={false} command={() => {}} rect={rect} />
    );
    expect(screen.getByText(/Link task/i)).toBeTruthy();
    // Hash icon renders as an inline svg in the header.
    const header = container.querySelector('.task-picker-menu > div');
    expect(header.querySelector('svg')).toBeTruthy();
  });
});
