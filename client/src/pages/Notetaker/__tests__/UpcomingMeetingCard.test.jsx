import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import UpcomingMeetingCard from '../UpcomingMeetingCard';

const MEETING = {
  id: 'm1',
  title: 'Product strategy sync',
  date: '2026-05-17',
  startTime: '14:00',
  endTime: '15:00',
  meetingUrl: 'https://example.com/zoom',
  participants: [
    { id: 'u1', name: 'Alice' },
    { id: 'u2', name: 'Bob' },
    { id: 'u3', name: 'Carol' },
    { id: 'u4', name: 'Dave' },
  ],
};

describe('UpcomingMeetingCard', () => {
  it('renders meeting title and meeting link', () => {
    render(<UpcomingMeetingCard meeting={MEETING} />);
    expect(screen.getByText('Product strategy sync')).toBeInTheDocument();
    expect(screen.getByText('Meeting link')).toBeInTheDocument();
  });

  it('shows "+ Invite notetaker" when bot not yet invited', () => {
    const onInvite = vi.fn();
    render(<UpcomingMeetingCard meeting={MEETING} onInviteNotetaker={onInvite} />);
    fireEvent.click(screen.getByText('+ Invite notetaker'));
    expect(onInvite).toHaveBeenCalled();
  });

  it('shows "Notetaker invited" pill when notetakerInvited=true', () => {
    render(<UpcomingMeetingCard meeting={{ ...MEETING, notetakerInvited: true }} />);
    expect(screen.getByText(/Notetaker invited/)).toBeInTheDocument();
    expect(screen.queryByText('+ Invite notetaker')).not.toBeInTheDocument();
  });

  it('renders participant avatars + overflow count', () => {
    const { container } = render(<UpcomingMeetingCard meeting={MEETING} />);
    // 3 visible avatars + 1 "+1" overflow chip.
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('calls onClick when the card is clicked', () => {
    const onClick = vi.fn();
    render(<UpcomingMeetingCard meeting={MEETING} onClick={onClick} />);
    fireEvent.click(screen.getByText('Product strategy sync'));
    expect(onClick).toHaveBeenCalled();
  });

  it('shows the debug icon only when showDebug=true', () => {
    const onDebug = vi.fn();
    const { rerender } = render(
      <UpcomingMeetingCard meeting={MEETING} onOpenDebug={onDebug} showDebug={false} />
    );
    expect(screen.queryByLabelText('Debug meeting')).not.toBeInTheDocument();
    rerender(<UpcomingMeetingCard meeting={MEETING} onOpenDebug={onDebug} showDebug />);
    expect(screen.getByLabelText('Debug meeting')).toBeInTheDocument();
  });
});
