import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { format, formatDistanceToNow } from 'date-fns';

import SidekickChatsListRail, {
  readChats, writeChats, deriveChatTitle,
} from '../SidekickChatsListRail';

beforeEach(() => {
  try { localStorage.clear(); } catch {}
});

describe('SidekickChatsListRail helpers', () => {
  it('deriveChatTitle returns "New chat" for empty input', () => {
    expect(deriveChatTitle([])).toBe('New chat');
    expect(deriveChatTitle(null)).toBe('New chat');
  });

  it('deriveChatTitle uses the first user message', () => {
    expect(deriveChatTitle([
      { role: 'assistant', content: 'I asked something' },
      { role: 'user', content: 'How do I X?' },
      { role: 'assistant', content: 'Try Y' },
    ])).toBe('How do I X?');
  });

  it('deriveChatTitle truncates long titles', () => {
    const long = 'a'.repeat(120);
    const title = deriveChatTitle([{ role: 'user', content: long }]);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
  });

  it('readChats / writeChats round-trip through localStorage', () => {
    const chats = [{ id: 'c1', title: 'Test', updatedAt: 1000 }];
    writeChats(chats);
    expect(readChats()).toEqual(chats);
  });
});

describe('SidekickChatsListRail', () => {
  it('renders a "New chat" button and calls onNewChat', () => {
    const onNewChat = vi.fn();
    render(<SidekickChatsListRail chats={[]} onNewChat={onNewChat} />);
    fireEvent.click(screen.getByText('New chat'));
    expect(onNewChat).toHaveBeenCalled();
  });

  it('renders the empty state when there are no chats', () => {
    render(<SidekickChatsListRail chats={[]} />);
    expect(screen.getByText('No chats yet.')).toBeInTheDocument();
  });

  it('renders chat titles and calls onSelect', () => {
    const onSelect = vi.fn();
    const chats = [
      { id: 'c1', title: 'First chat', updatedAt: Date.now() - 60_000 },
      { id: 'c2', title: 'Second chat', updatedAt: Date.now() },
    ];
    render(<SidekickChatsListRail chats={chats} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('First chat'));
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('filters chats by query', () => {
    const chats = [
      { id: 'c1', title: 'Marketing brainstorm', updatedAt: Date.now() },
      { id: 'c2', title: 'Engineering retro', updatedAt: Date.now() },
    ];
    render(<SidekickChatsListRail chats={chats} />);
    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'eng' } });
    expect(screen.queryByText('Marketing brainstorm')).not.toBeInTheDocument();
    expect(screen.getByText('Engineering retro')).toBeInTheDocument();
  });

  it('renders the collapsed rail when collapsed=true', () => {
    render(<SidekickChatsListRail chats={[]} collapsed />);
    // Only the new-chat icon button is visible, not the full sidebar.
    expect(screen.queryByText('New chat')).not.toBeInTheDocument();
    expect(screen.getByLabelText('New chat')).toBeInTheDocument();
  });
});
