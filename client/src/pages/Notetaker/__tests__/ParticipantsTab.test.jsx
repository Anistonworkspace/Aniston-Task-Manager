import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import ParticipantsTab from '../ParticipantsTab';

describe('ParticipantsTab', () => {
  it('shows roster when there is no transcript', () => {
    render(
      <ParticipantsTab
        meeting={{
          participants: [
            { id: 'u1', name: 'Alice', email: 'a@x.com' },
            { id: 'u2', name: 'Bob', email: 'b@x.com' },
          ],
        }}
        segments={[]}
        transcriptStatus="unavailable"
      />
    );
    expect(screen.getByText('Participants')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows talking-time chart when transcript segments are present', () => {
    render(
      <ParticipantsTab
        meeting={{ participants: [] }}
        segments={[
          { speakerLabel: 'Alice', startMs: 0,    endMs: 6000 },
          { speakerLabel: 'Bob',   startMs: 6000, endMs: 10000 },
          { speakerLabel: 'Alice', startMs: 10000, endMs: 16000 },
        ]}
        transcriptStatus="ok"
      />
    );
    expect(screen.getByText('Talking time')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    // Alice spoke 12s out of 16s total → 75%.
    expect(screen.getByText('75.00%')).toBeInTheDocument();
    expect(screen.getByText('25.00%')).toBeInTheDocument();
  });

  it('shows empty roster when meeting has no participants and no transcript', () => {
    render(
      <ParticipantsTab
        meeting={{ participants: [] }}
        segments={[]}
        transcriptStatus="unavailable"
      />
    );
    expect(screen.getByText('No participants on this meeting')).toBeInTheDocument();
  });
});
