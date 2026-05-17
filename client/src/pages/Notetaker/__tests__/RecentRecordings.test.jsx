import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Notetaker — RecentRecordings tests.
 *
 * Companion list shown above the Meeting Mode panel on the Notetaker
 * page. Fetches the current user's notes (GET /api/notes/my), filters
 * client-side to voice notes, caps the list at `limit`, and listens for
 * the `notes:changed` window event to re-fetch when a new recording
 * lands from anywhere in the app.
 *
 * We mock both:
 *   - `api`           — GET /notes/my returns a notes array
 *   - `react-router-dom` (partial) — useNavigate is spied so we can
 *                       assert click-through to /notes?focus=<id>
 */

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock('../../../services/api', () => ({
  default: { get: vi.fn() },
}));

import api from '../../../services/api';
import RecentRecordings from '../RecentRecordings';

const VOICE_NOTE = (id, overrides = {}) => ({
  id,
  title: `Voice note ${id}`,
  content: `Transcript body for ${id}.`,
  type: 'voice_note',
  duration: 65,
  createdAt: '2026-05-15T10:00:00Z',
  ...overrides,
});

function renderWithRouter(ui) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockReset();
});

describe('RecentRecordings', () => {
  it('renders the loading state initially', () => {
    // Hang the request so we sit in the loading branch.
    api.get.mockReturnValue(new Promise(() => {}));

    renderWithRouter(<RecentRecordings />);

    expect(screen.getByText(/Loading recordings/i)).toBeInTheDocument();
    expect(screen.getByText(/Recent recordings/i)).toBeInTheDocument();
  });

  it('renders one row per voice note after load (mock returns 3 notes)', async () => {
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          notes: [
            VOICE_NOTE('n1', { title: 'Standup notes' }),
            VOICE_NOTE('n2', { title: 'Customer call' }),
            VOICE_NOTE('n3', { title: 'Design review' }),
          ],
        },
      },
    });

    renderWithRouter(<RecentRecordings />);

    await waitFor(() => expect(screen.getByText('Standup notes')).toBeInTheDocument());
    expect(screen.getByText('Customer call')).toBeInTheDocument();
    expect(screen.getByText('Design review')).toBeInTheDocument();
    // Loading hint should be gone once the response lands.
    expect(screen.queryByText(/Loading recordings/i)).not.toBeInTheDocument();
  });

  it('filters out non-voice-note types', async () => {
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          notes: [
            VOICE_NOTE('n1', { title: 'Keep me' }),
            { id: 'n2', title: 'Drop me', type: 'meeting_notes', content: '' },
            { id: 'n3', title: 'Drop me too', type: 'text', content: '' },
            VOICE_NOTE('n4', { title: 'Also keep' }),
            // Missing type — treated as voice note (defensive default).
            { id: 'n5', title: 'Untyped keeper', content: '' },
          ],
        },
      },
    });

    renderWithRouter(<RecentRecordings />);

    await waitFor(() => expect(screen.getByText('Keep me')).toBeInTheDocument());
    expect(screen.getByText('Also keep')).toBeInTheDocument();
    expect(screen.getByText('Untyped keeper')).toBeInTheDocument();
    expect(screen.queryByText('Drop me')).not.toBeInTheDocument();
    expect(screen.queryByText('Drop me too')).not.toBeInTheDocument();
  });

  it('renders the empty state when the list comes back empty', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { notes: [] } },
    });

    renderWithRouter(<RecentRecordings />);

    await waitFor(() =>
      expect(screen.getByText(/No recordings yet/i)).toBeInTheDocument()
    );
    // CTA hint mentions the primary action.
    expect(screen.getByText(/Record meeting/i)).toBeInTheDocument();
  });

  it('silently renders nothing when the fetch errors', async () => {
    api.get.mockRejectedValue(new Error('boom'));

    const { container } = renderWithRouter(<RecentRecordings />);

    // Wait for the loading hint to disappear (component flipped to the
    // error branch which returns null).
    await waitFor(() =>
      expect(screen.queryByText(/Loading recordings/i)).not.toBeInTheDocument()
    );
    // Nothing else should be in the DOM — no heading, no empty state, nothing.
    expect(screen.queryByText(/Recent recordings/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No recordings yet/i)).not.toBeInTheDocument();
    // The MemoryRouter wrapper itself adds nothing visible — children empty.
    expect(container.querySelector('section')).toBeNull();
  });

  it('respects the `limit` prop (5 returned, limit=2 renders only 2)', async () => {
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          notes: [
            VOICE_NOTE('n1', { title: 'First' }),
            VOICE_NOTE('n2', { title: 'Second' }),
            VOICE_NOTE('n3', { title: 'Third' }),
            VOICE_NOTE('n4', { title: 'Fourth' }),
            VOICE_NOTE('n5', { title: 'Fifth' }),
          ],
        },
      },
    });

    renderWithRouter(<RecentRecordings limit={2} />);

    await waitFor(() => expect(screen.getByText('First')).toBeInTheDocument());
    expect(screen.getByText('Second')).toBeInTheDocument();
    // The remaining three should be capped out.
    expect(screen.queryByText('Third')).not.toBeInTheDocument();
    expect(screen.queryByText('Fourth')).not.toBeInTheDocument();
    expect(screen.queryByText('Fifth')).not.toBeInTheDocument();
  });

  it('re-fetches when window dispatches `notes:changed`', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { notes: [VOICE_NOTE('n1', { title: 'Initial' })] } },
    });

    renderWithRouter(<RecentRecordings />);

    await waitFor(() => expect(screen.getByText('Initial')).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/notes/my');

    // Swap the response so the second fetch returns a different note,
    // then fire the cross-app sync event.
    api.get.mockResolvedValue({
      data: { success: true, data: { notes: [VOICE_NOTE('n2', { title: 'After event' })] } },
    });

    act(() => {
      window.dispatchEvent(new CustomEvent('notes:changed'));
    });

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('After event')).toBeInTheDocument());
  });

  it('clicking a row navigates to /notes?focus=<noteId>', async () => {
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          notes: [VOICE_NOTE('note-xyz', { title: 'Clickable row' })],
        },
      },
    });

    renderWithRouter(<RecentRecordings />);

    await waitFor(() => expect(screen.getByText('Clickable row')).toBeInTheDocument());

    // The row is a <button> — pick the one whose text matches the title.
    const row = screen.getByText('Clickable row').closest('button');
    expect(row).toBeTruthy();
    fireEvent.click(row);

    expect(navigateMock).toHaveBeenCalledWith('/notes?focus=note-xyz');
  });
});
