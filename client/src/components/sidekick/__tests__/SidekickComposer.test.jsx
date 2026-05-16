import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import SidekickComposer from '../SidekickComposer';

describe('SidekickComposer', () => {
  it('disables send while text is empty', () => {
    render(<SidekickComposer onSend={() => {}} />);
    const send = screen.getByRole('button', { name: /Send message/ });
    expect(send).toBeDisabled();
  });

  it('enables send once text is typed', () => {
    render(<SidekickComposer onSend={() => {}} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    expect(screen.getByRole('button', { name: /Send message/ })).not.toBeDisabled();
  });

  it('sends on Enter (without Shift) and clears the input', () => {
    const onSend = vi.fn();
    render(<SidekickComposer onSend={onSend} />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'hello' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(ta.value).toBe('');
  });

  it('inserts newline on Shift+Enter (does not send)', () => {
    const onSend = vi.fn();
    render(<SidekickComposer onSend={onSend} />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'line1' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows Stop button while thinking and calls onStop', () => {
    const onStop = vi.fn();
    render(<SidekickComposer onSend={() => {}} onStop={onStop} status="thinking" />);
    expect(screen.queryByRole('button', { name: /Send message/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Stop response/ }));
    expect(onStop).toHaveBeenCalled();
  });

  it('does not send while in-flight even with text present', () => {
    const onSend = vi.fn();
    render(<SidekickComposer onSend={onSend} status="streaming" />);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'hello' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });
});
