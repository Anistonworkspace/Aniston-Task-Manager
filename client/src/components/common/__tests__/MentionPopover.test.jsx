import React, { createRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

import MentionPopover from '../MentionPopover';

// A fake clientRect for the popover positioning logic — any non-null shape
// works; the tests don't assert on position math.
const rect = { top: 100, bottom: 120, left: 50, right: 100 };

function renderPopover(props = {}) {
  const ref = createRef();
  const command = props.command || vi.fn();
  const utils = render(
    <MentionPopover
      ref={ref}
      items={props.items ?? []}
      loading={props.loading ?? false}
      command={command}
      rect={rect}
    />
  );
  return { ...utils, ref, command };
}

describe('MentionPopover', () => {
  it('renders "No matches" empty state when items=[] and loading=false', () => {
    const { container } = renderPopover({ items: [], loading: false });
    expect(container.textContent).toContain('No matches');
  });

  it('renders "Searching…" hint when loading=true and items=[]', () => {
    const { container } = renderPopover({ items: [], loading: true });
    // Source uses an ellipsis character (…), assert on it.
    expect(container.textContent).toContain('Searching');
    expect(container.textContent).toContain('…');
  });

  it('renders one button per user with name + email', () => {
    const items = [
      { id: '1', name: 'Alice Aniston', email: 'alice@aniston.com' },
      { id: '2', name: 'Bob Brown', email: 'bob@aniston.com' },
    ];
    const { container } = renderPopover({ items });
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    expect(container.textContent).toContain('Alice Aniston');
    expect(container.textContent).toContain('alice@aniston.com');
    expect(container.textContent).toContain('Bob Brown');
    expect(container.textContent).toContain('bob@aniston.com');
  });

  it('clicking a row fires command(user) with the full user object', () => {
    const items = [
      { id: '1', name: 'Alice', email: 'alice@aniston.com' },
      { id: '2', name: 'Bob', email: 'bob@aniston.com' },
    ];
    const command = vi.fn();
    const { container } = renderPopover({ items, command });
    const buttons = container.querySelectorAll('button');
    // Source uses onMouseDown (so the editor's blur handler can't swallow
    // the pick before it lands). fireEvent.click only fires click; use
    // mouseDown to match the actual handler the component installs.
    fireEvent.mouseDown(buttons[1]);
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(items[1]);
  });

  it('mouseEnter on a row highlights it (active button gets bg-emerald-50)', () => {
    const items = [
      { id: '1', name: 'Alice', email: 'a@x' },
      { id: '2', name: 'Bob', email: 'b@x' },
    ];
    const { container } = renderPopover({ items });
    const buttons = container.querySelectorAll('button');
    // Row 0 is highlighted by default.
    expect(buttons[0].className).toContain('bg-emerald-50');
    expect(buttons[1].className).not.toContain('bg-emerald-50');

    fireEvent.mouseEnter(buttons[1]);

    const after = container.querySelectorAll('button');
    expect(after[1].className).toContain('bg-emerald-50');
    expect(after[0].className).not.toContain('bg-emerald-50');
  });

  it('ref.onKeyDown ArrowDown / ArrowUp cycles selection and returns true', () => {
    const items = [
      { id: '1', name: 'A', email: 'a@x' },
      { id: '2', name: 'B', email: 'b@x' },
      { id: '3', name: 'C', email: 'c@x' },
    ];
    const { container, ref } = renderPopover({ items });

    // ArrowDown → moves to index 1.
    let handled;
    act(() => { handled = ref.current.onKeyDown({ event: { key: 'ArrowDown' } }); });
    expect(handled).toBe(true);
    let buttons = container.querySelectorAll('button');
    expect(buttons[1].className).toContain('bg-emerald-50');

    // ArrowDown again → index 2.
    act(() => { handled = ref.current.onKeyDown({ event: { key: 'ArrowDown' } }); });
    expect(handled).toBe(true);
    buttons = container.querySelectorAll('button');
    expect(buttons[2].className).toContain('bg-emerald-50');

    // ArrowUp → index 1.
    act(() => { handled = ref.current.onKeyDown({ event: { key: 'ArrowUp' } }); });
    expect(handled).toBe(true);
    buttons = container.querySelectorAll('button');
    expect(buttons[1].className).toContain('bg-emerald-50');

    // ArrowUp from index 0 wraps to last (cycling).
    act(() => { ref.current.onKeyDown({ event: { key: 'ArrowUp' } }); }); // → 0
    act(() => { handled = ref.current.onKeyDown({ event: { key: 'ArrowUp' } }); }); // → 2 (wrap)
    expect(handled).toBe(true);
    buttons = container.querySelectorAll('button');
    expect(buttons[2].className).toContain('bg-emerald-50');
  });

  it('ref.onKeyDown Enter calls command(items[selected]) and returns true', () => {
    const items = [
      { id: '1', name: 'A', email: 'a@x' },
      { id: '2', name: 'B', email: 'b@x' },
    ];
    const command = vi.fn();
    const { ref } = renderPopover({ items, command });

    // Move selection to index 1.
    act(() => { ref.current.onKeyDown({ event: { key: 'ArrowDown' } }); });

    let handled;
    act(() => { handled = ref.current.onKeyDown({ event: { key: 'Enter' } }); });
    expect(handled).toBe(true);
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(items[1]);
  });

  it('ref.onKeyDown returns false on unknown keys', () => {
    const items = [{ id: '1', name: 'A', email: 'a@x' }];
    const { ref } = renderPopover({ items });

    let handled;
    act(() => { handled = ref.current.onKeyDown({ event: { key: 'x' } }); });
    expect(handled).toBe(false);

    act(() => { handled = ref.current.onKeyDown({ event: { key: 'Escape' } }); });
    // Escape is not handled by the popover itself (it's handled by the
    // outer suggestion plugin render contract), so onKeyDown returns false.
    expect(handled).toBe(false);
  });
});
