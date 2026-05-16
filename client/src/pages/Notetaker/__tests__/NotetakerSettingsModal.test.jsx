import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, onClick, role, 'aria-modal': ariaModal, 'aria-label': ariaLabel, className, style, ...rest }, ref) =>
      React.createElement(tag, { ref, onClick, role, 'aria-modal': ariaModal, 'aria-label': ariaLabel, className, style }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

vi.mock('../../../utils/animations', () => ({
  modalOverlay: {},
  modalContent: {},
}));

vi.mock('../../../components/common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import NotetakerSettingsModal, {
  readNotetakerPrefs, DEFAULT_PREFS,
} from '../NotetakerSettingsModal';

beforeEach(() => {
  try { localStorage.clear(); } catch {}
});

describe('NotetakerSettingsModal', () => {
  it('does not render when closed', () => {
    render(<NotetakerSettingsModal isOpen={false} onClose={() => {}} />);
    expect(screen.queryByText('Notetaker settings')).not.toBeInTheDocument();
  });

  it('renders Personal preferences by default', () => {
    render(<NotetakerSettingsModal isOpen onClose={() => {}} />);
    // "Personal preferences" shows in BOTH the sidebar tab and the section
    // heading — query by role to disambiguate.
    expect(screen.getByRole('heading', { name: 'Personal preferences' })).toBeInTheDocument();
    expect(screen.getByText(/These settings apply only to you/)).toBeInTheDocument();
  });

  it('switches to Connected calendars tab', () => {
    render(<NotetakerSettingsModal isOpen onClose={() => {}} />);
    // Click the sidebar tab — heading isn't there yet, so getByText is safe.
    fireEvent.click(screen.getByText('Connected calendars'));
    expect(screen.getByText('No calendars connected yet.')).toBeInTheDocument();
  });

  it('toggles a preference and persists to localStorage', () => {
    render(<NotetakerSettingsModal isOpen onClose={() => {}} />);
    const toggle = screen.getByRole('switch', { name: /Auto-invite to meetings you create/ });
    expect(toggle).toHaveAttribute('aria-checked', 'true'); // default ON
    fireEvent.click(toggle);
    // Re-query for the toggle after click — Testing Library's accessibility
    // tree may rebuild and the prior reference can be stale in some React
    // versions. Reading via the same accessible-name query is the canonical
    // re-fetch.
    const after = screen.getByRole('switch', { name: /Auto-invite to meetings you create/ });
    expect(after).toHaveAttribute('aria-checked', 'false');
    const stored = readNotetakerPrefs();
    expect(stored.autoInviteOwn).toBe(false);
  });

  it('keeps "Allow AI to learn" OFF by default (privacy)', () => {
    render(<NotetakerSettingsModal isOpen onClose={() => {}} />);
    const toggle = screen.getByRole('switch', { name: /Allow AI to learn from my meetings/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(DEFAULT_PREFS.allowAILearning).toBe(false);
  });

  it('Connect Google / Outlook buttons fire onConnectCalendar with the provider', () => {
    const onConnect = vi.fn();
    render(
      <NotetakerSettingsModal isOpen onClose={() => {}} onConnectCalendar={onConnect} />
    );
    fireEvent.click(screen.getByText('Connected calendars'));
    fireEvent.click(screen.getByText(/Connect Google Calendar/));
    expect(onConnect).toHaveBeenCalledWith('google');
    fireEvent.click(screen.getByText(/Connect Outlook Calendar/));
    expect(onConnect).toHaveBeenCalledWith('outlook');
  });
});
