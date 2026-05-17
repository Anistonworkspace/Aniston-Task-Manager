import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

/**
 * Notetaker — TranscriptProcessor tests.
 *
 * After the user stops a Meeting-Mode recording, this component runs
 * the AI Summary + Extract-Actions calls IN PARALLEL on mount and
 * renders each action with a one-click "Create task" button.
 *
 * We mock both network paths so no real Axios call is made:
 *   - `api`                  — for POST /ai/chat (summary) + POST /tasks
 *   - `aiSummaryService`     — for `extractActions`
 *   - `Toast`                — useToast returns no-op handlers
 */

vi.mock('../../../services/api', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));

vi.mock('../../../services/aiSummaryService', () => ({
  default: { extractActions: vi.fn() },
  extractActions: vi.fn(),
}));

vi.mock('../Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import api from '../../../services/api';
import aiSummary from '../../../services/aiSummaryService';
import TranscriptProcessor from '../TranscriptProcessor';

const TRANSCRIPT = 'Sara: I will ship the email by June 1.\nJohn: I will review by Monday.';

beforeEach(() => {
  vi.clearAllMocks();
  // Default board-list response so tests that DON'T care about the picker
  // still don't blow up when the component fires GET /boards on mount.
  if (api.get && api.get.mockResolvedValue) {
    api.get.mockResolvedValue({ data: { success: true, data: { boards: [] } } });
  }
  try { localStorage.clear(); } catch { /* jsdom — safe to ignore */ }
});

/**
 * Helper: install default-resolving mocks so the component can reach
 * `ok` state for both panes. Individual tests override per-call.
 */
function installHappyMocks({
  reply = 'Decisions: ship email. Open: timeline. Owner: Sara.',
  actions = [
    { title: 'Ship the email', owner: 'Sara', dueDate: '2026-06-01', priority: 'high' },
    { title: 'Review proposal', owner: 'John', dueDate: '2026-05-20', priority: 'medium' },
  ],
} = {}) {
  api.post.mockImplementation((url) => {
    if (url === '/ai/chat') {
      return Promise.resolve({ data: { success: true, data: { reply } } });
    }
    if (url === '/tasks') {
      return Promise.resolve({
        data: { success: true, data: { task: { id: 'task-new-1', title: 'created' } } },
      });
    }
    return Promise.resolve({ data: { success: true, data: {} } });
  });
  aiSummary.extractActions.mockResolvedValue({ actions });
}

describe('TranscriptProcessor', () => {
  it('renders both loading states on mount (parallel kick-off)', () => {
    // Block both promises so we can observe the loading state.
    api.post.mockReturnValue(new Promise(() => {}));
    aiSummary.extractActions.mockReturnValue(new Promise(() => {}));

    render(<TranscriptProcessor transcript={TRANSCRIPT} defaultBoardId="board-1" />);

    expect(screen.getByText(/Summarizing the meeting/i)).toBeInTheDocument();
    expect(screen.getByText(/Finding tasks in the transcript/i)).toBeInTheDocument();
    // Both pane calls fired in parallel — no sequencing.
    expect(api.post).toHaveBeenCalledWith('/ai/chat', expect.objectContaining({
      prompt: expect.stringContaining('Summarize this meeting transcript'),
    }));
    expect(aiSummary.extractActions).toHaveBeenCalledWith({ text: TRANSCRIPT });
  });

  it('renders the AI summary text after the summary call resolves', async () => {
    installHappyMocks({ reply: 'The team agreed to ship the email by June 1.' });

    render(<TranscriptProcessor transcript={TRANSCRIPT} defaultBoardId="board-1" />);

    await waitFor(() =>
      expect(screen.getByText('The team agreed to ship the email by June 1.')).toBeInTheDocument()
    );
    expect(screen.queryByText(/Summarizing the meeting/i)).not.toBeInTheDocument();
  });

  it('lists each action with title + owner + date + priority badges', async () => {
    installHappyMocks();

    render(<TranscriptProcessor transcript={TRANSCRIPT} defaultBoardId="board-1" />);

    await waitFor(() => expect(screen.getByText('Ship the email')).toBeInTheDocument());
    expect(screen.getByText('Review proposal')).toBeInTheDocument();
    // Owner badges
    expect(screen.getByText('Sara')).toBeInTheDocument();
    expect(screen.getByText('John')).toBeInTheDocument();
    // Date badges
    expect(screen.getByText('2026-06-01')).toBeInTheDocument();
    expect(screen.getByText('2026-05-20')).toBeInTheDocument();
    // Priority badges
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
    // Count appears in header
    expect(screen.getByText(/\(2\)/)).toBeInTheDocument();
  });

  it('clicking "Create task" POSTs /tasks and switches the button to "Created"', async () => {
    installHappyMocks();
    const onActionCreated = vi.fn();

    render(
      <TranscriptProcessor
        transcript={TRANSCRIPT}
        defaultBoardId="board-1"
        onActionCreated={onActionCreated}
      />
    );

    await waitFor(() => expect(screen.getByText('Ship the email')).toBeInTheDocument());

    const createButtons = screen.getAllByRole('button', { name: /Create task/i });
    fireEvent.click(createButtons[0]);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/tasks',
        expect.objectContaining({
          title: 'Ship the email',
          boardId: 'board-1',
          priority: 'high',
          dueDate: '2026-06-01',
        })
      );
    });

    await waitFor(() => expect(screen.getByText('Created')).toBeInTheDocument());
    expect(onActionCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-new-1' })
    );
  });

  it('disables the "Create task" button + shows a tip when there is no defaultBoardId', async () => {
    installHappyMocks();

    render(<TranscriptProcessor transcript={TRANSCRIPT} /* no defaultBoardId */ />);

    await waitFor(() => expect(screen.getByText('Ship the email')).toBeInTheDocument());

    const createButtons = screen.getAllByRole('button', { name: /Create task/i });
    expect(createButtons[0]).toBeDisabled();
    expect(createButtons[1]).toBeDisabled();
    expect(
      screen.getByText(/Pick a board above to enable one-click task creation/i)
    ).toBeInTheDocument();
  });

  it('clicking the X (hide) on an action removes only that row', async () => {
    installHappyMocks();

    render(<TranscriptProcessor transcript={TRANSCRIPT} defaultBoardId="board-1" />);

    await waitFor(() => expect(screen.getByText('Ship the email')).toBeInTheDocument());

    const hideButtons = screen.getAllByLabelText('Hide action item');
    expect(hideButtons).toHaveLength(2);
    fireEvent.click(hideButtons[0]);

    await waitFor(() => expect(screen.queryByText('Ship the email')).not.toBeInTheDocument());
    // Sibling row remains.
    expect(screen.getByText('Review proposal')).toBeInTheDocument();
    // Count updates in header.
    expect(screen.getByText(/\(1\)/)).toBeInTheDocument();
  });

  it('Regenerate buttons re-fire the corresponding network call', async () => {
    installHappyMocks();

    render(<TranscriptProcessor transcript={TRANSCRIPT} defaultBoardId="board-1" />);

    await waitFor(() => expect(screen.getByText('Ship the email')).toBeInTheDocument());

    // Sanity: 1 summary call + 1 actions call so far.
    const summaryCallsBefore = api.post.mock.calls.filter((c) => c[0] === '/ai/chat').length;
    expect(summaryCallsBefore).toBe(1);
    expect(aiSummary.extractActions).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Regenerate summary'));
    fireEvent.click(screen.getByLabelText('Regenerate actions'));

    await waitFor(() => {
      const summaryCallsAfter = api.post.mock.calls.filter((c) => c[0] === '/ai/chat').length;
      expect(summaryCallsAfter).toBe(2);
    });
    expect(aiSummary.extractActions).toHaveBeenCalledTimes(2);
  });

  it('shows the summary error state when /ai/chat rejects', async () => {
    api.post.mockImplementation((url) => {
      if (url === '/ai/chat') {
        return Promise.reject(new Error('AI provider down'));
      }
      return Promise.resolve({ data: { success: true, data: {} } });
    });
    aiSummary.extractActions.mockResolvedValue({ actions: [] });

    render(<TranscriptProcessor transcript={TRANSCRIPT} defaultBoardId="board-1" />);

    // getErrorMessage may rewrite into a canonical string — match permissively
    // by checking that the loading text is gone and an alert/error class is present.
    await waitFor(() =>
      expect(screen.queryByText(/Summarizing the meeting/i)).not.toBeInTheDocument()
    );

    // The "AI summary" header label is still there; the message body is
    // whatever errorMap chose to surface. We only assert the section did
    // not unmount and the Regenerate affordance is NOT shown (it only
    // renders in the 'ok' state, so its absence confirms error or loading).
    const summaryHeader = screen.getByText('AI summary');
    const section = summaryHeader.closest('section');
    expect(section).toBeTruthy();
    expect(within(section).queryByLabelText('Regenerate summary')).not.toBeInTheDocument();
  });

  it('shows the actions error state when extractActions rejects', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { reply: 'sum' } } });
    aiSummary.extractActions.mockRejectedValue(new Error('extract failed'));

    render(<TranscriptProcessor transcript={TRANSCRIPT} defaultBoardId="board-1" />);

    await waitFor(() =>
      expect(screen.queryByText(/Finding tasks in the transcript/i)).not.toBeInTheDocument()
    );
    const actionsHeader = screen.getByText(/Action items/i);
    const section = actionsHeader.closest('section');
    expect(section).toBeTruthy();
    // The list should NOT have rendered because we never reached `ok`.
    expect(within(section).queryByRole('button', { name: /Create task/i })).not.toBeInTheDocument();
  });

  it('whitespace-only transcript short-circuits both panes without making AI calls', async () => {
    installHappyMocks();

    render(<TranscriptProcessor transcript="   " defaultBoardId="board-1" />);

    await waitFor(() =>
      expect(screen.getByText(/Transcript was empty/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/No clear action items/i)).toBeInTheDocument();
    // Critically — no AI network calls were made.
    expect(api.post).not.toHaveBeenCalledWith('/ai/chat', expect.anything());
    expect(aiSummary.extractActions).not.toHaveBeenCalled();
  });
});

/**
 * Board picker (A) — added when TranscriptProcessor learned to fetch
 * /api/boards on mount, render a "Save to board:" <select>, and remember
 * the user's last choice in localStorage under
 * `aniston.transcriptProcessor.defaultBoardId`.
 *
 * Resolution order for the active board id (effectiveBoardId memo):
 *   1. propBoardId           (caller-supplied; picker hidden entirely)
 *   2. userPickedBoardId     (from the <select> in this very render)
 *   3. localStorage value    (only if it still exists in the loaded list)
 *   4. boards[0]?.id         (sensible fallback)
 */
const BOARD_PREF_KEY = 'aniston.transcriptProcessor.defaultBoardId';

/**
 * Helper: install a board-list response for GET /boards. Defaults to two
 * boards. Pass `[]` for the empty-state test.
 */
function installBoardsMock(boards = [
  { id: 'board-A', name: 'Engineering' },
  { id: 'board-B', name: 'Marketing' },
]) {
  api.get.mockImplementation((url) => {
    if (url === '/boards') {
      return Promise.resolve({ data: { success: true, data: { boards } } });
    }
    return Promise.resolve({ data: { success: true, data: {} } });
  });
}

describe('TranscriptProcessor — board picker (A)', () => {
  it('with defaultBoardId prop: does NOT fetch /boards and does NOT render the picker', async () => {
    installHappyMocks();
    installBoardsMock();

    render(<TranscriptProcessor transcript={TRANSCRIPT} defaultBoardId="board-prop" />);

    // Wait for the action items to land so we know the component fully mounted.
    await waitFor(() => expect(screen.getByText('Ship the email')).toBeInTheDocument());

    expect(api.get).not.toHaveBeenCalledWith('/boards');
    expect(screen.queryByText(/Save to board:/i)).not.toBeInTheDocument();
  });

  it('without prop: calls GET /boards on mount and renders the populated <select>', async () => {
    installHappyMocks();
    installBoardsMock([
      { id: 'board-A', name: 'Engineering' },
      { id: 'board-B', name: 'Marketing' },
    ]);

    render(<TranscriptProcessor transcript={TRANSCRIPT} />);

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/boards'));
    await waitFor(() => expect(screen.getByText(/Save to board:/i)).toBeInTheDocument());

    // The select renders both option labels.
    expect(screen.getByRole('option', { name: 'Engineering' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Marketing' })).toBeInTheDocument();
    // First board auto-selected as the fallback.
    const select = screen.getByRole('combobox');
    expect(select).toHaveValue('board-A');
  });

  it('shows the "loading…" hint inside the picker row while /boards is in flight', async () => {
    installHappyMocks();
    // Hang the /boards request so we can observe the loading hint.
    api.get.mockImplementation((url) => {
      if (url === '/boards') return new Promise(() => {});
      return Promise.resolve({ data: { success: true, data: {} } });
    });

    render(<TranscriptProcessor transcript={TRANSCRIPT} />);

    await waitFor(() => expect(screen.getByText(/Save to board:/i)).toBeInTheDocument());
    expect(screen.getByText(/loading…/i)).toBeInTheDocument();
    // The actual <select> shouldn't have rendered yet.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('empty board list: shows the "No boards available" message and keeps Create-task disabled', async () => {
    installHappyMocks();
    installBoardsMock([]);

    render(<TranscriptProcessor transcript={TRANSCRIPT} />);

    await waitFor(() =>
      expect(screen.getByText(/No boards available — create one first\./i)).toBeInTheDocument()
    );
    // Wait for actions to render so the Create-task buttons exist.
    await waitFor(() => expect(screen.getByText('Ship the email')).toBeInTheDocument());

    const createButtons = screen.getAllByRole('button', { name: /Create task/i });
    expect(createButtons[0]).toBeDisabled();
    expect(createButtons[1]).toBeDisabled();
  });

  it('changing the <select> persists to localStorage and is used by the next Create-task', async () => {
    installHappyMocks();
    installBoardsMock([
      { id: 'board-A', name: 'Engineering' },
      { id: 'board-B', name: 'Marketing' },
    ]);

    render(<TranscriptProcessor transcript={TRANSCRIPT} />);

    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
    const select = screen.getByRole('combobox');
    // Sanity — default lands on the first board.
    expect(select).toHaveValue('board-A');

    fireEvent.change(select, { target: { value: 'board-B' } });

    // localStorage was updated synchronously.
    expect(localStorage.getItem(BOARD_PREF_KEY)).toBe('board-B');
    expect(select).toHaveValue('board-B');

    // Now click Create task — it should POST with the user's pick.
    await waitFor(() => expect(screen.getByText('Ship the email')).toBeInTheDocument());
    const createButtons = screen.getAllByRole('button', { name: /Create task/i });
    fireEvent.click(createButtons[0]);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        '/tasks',
        expect.objectContaining({ title: 'Ship the email', boardId: 'board-B' })
      );
    });
  });

  it('auto-selects the remembered board id from localStorage when it exists in the loaded list', async () => {
    // Seed the preference BEFORE mount so the memo picks it up on first paint.
    localStorage.setItem(BOARD_PREF_KEY, 'board-B');
    installHappyMocks();
    installBoardsMock([
      { id: 'board-A', name: 'Engineering' },
      { id: 'board-B', name: 'Marketing' },
    ]);

    render(<TranscriptProcessor transcript={TRANSCRIPT} />);

    await waitFor(() => expect(screen.getByRole('combobox')).toBeInTheDocument());
    // Remembered choice wins over boards[0].
    expect(screen.getByRole('combobox')).toHaveValue('board-B');
  });
});
