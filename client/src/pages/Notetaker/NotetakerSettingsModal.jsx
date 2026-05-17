import React, { useEffect, useState } from 'react';
import { Mail, Mic, FileText, Brain, RefreshCw, X } from 'lucide-react';
import Modal from '../../components/common/Modal';
import { useToast } from '../../components/common/Toast';

/**
 * NotetakerSettingsModal — Connected calendars + Personal preferences
 * (skill §5).
 *
 *   <NotetakerSettingsModal
 *     isOpen={open}
 *     onClose={...}
 *     calendarConnected={false}
 *     onConnectCalendar={(provider) => ...}
 *     onDisconnectCalendar={(provider) => ...}
 *   />
 *
 * Personal-preference toggles are persisted to localStorage for now. When
 * the server gains a user-preferences endpoint these can flip to async
 * persistence in a one-line swap inside the change handlers.
 */

const PREF_STORAGE_KEY = 'notetaker:prefs';

const DEFAULT_PREFS = {
  autoInviteOwn: true,           // Auto-invite to meetings I create
  autoInviteInvited: false,      // Auto-invite to meetings I'm invited to
  summaryEmails: true,           // Receive meeting summary emails
  recordAudio: true,             // Save audio recordings
  saveTranscripts: true,         // Persist full transcript text
  allowAILearning: false,        // Privacy-sensitive — default OFF
};

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs) {
  try { localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(prefs)); } catch {}
}

export default function NotetakerSettingsModal({
  isOpen,
  onClose,
  calendarConnected = false,
  connectedAccounts = [],
  onConnectCalendar,
  onDisconnectCalendar,
}) {
  const toast = useToast();
  const [tab, setTab] = useState('preferences');
  const [prefs, setPrefs] = useState(() => readPrefs());

  useEffect(() => {
    if (isOpen) setPrefs(readPrefs());
  }, [isOpen]);

  function togglePref(key) {
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writePrefs(next);
      // Prefs are localStorage-only until the user-prefs sync endpoint
      // lands — be honest about that in the toast so users don't expect
      // these to follow them across devices.
      toast.success('Saved on this device');
      return next;
    });
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Notetaker settings" size="lg">
      <div className="flex h-full -mx-8 -my-6 min-h-[440px]">
        <aside
          className="w-48 flex-shrink-0 py-3 px-2"
          style={{
            borderRight: '1px solid var(--layout-border-color, #e2e2e2)',
            backgroundColor: 'var(--surface-50, #f8f9fb)',
          }}
        >
          <SidebarItem active={tab === 'calendars'} onClick={() => setTab('calendars')}>
            Connected calendars
          </SidebarItem>
          <SidebarItem active={tab === 'preferences'} onClick={() => setTab('preferences')}>
            Personal preferences
          </SidebarItem>
        </aside>

        <div className="flex-1 overflow-auto p-6">
          {tab === 'calendars' && (
            <CalendarsTab
              connectedAccounts={connectedAccounts}
              onConnectCalendar={onConnectCalendar}
              onDisconnectCalendar={onDisconnectCalendar}
            />
          )}
          {tab === 'preferences' && (
            <PreferencesTab prefs={prefs} onToggle={togglePref} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function SidebarItem({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full px-3 py-1.5 rounded-md text-sm text-left transition-colors ${
        active
          ? 'bg-primary-50 text-primary font-semibold'
          : 'text-text-secondary hover:bg-surface-100'
      }`}
    >
      {children}
    </button>
  );
}

function CalendarsTab({ connectedAccounts, onConnectCalendar, onDisconnectCalendar }) {
  const accounts = Array.isArray(connectedAccounts) ? connectedAccounts : [];
  return (
    <div>
      <h3 className="text-base font-semibold text-text-primary">Connected calendars</h3>
      <p className="mt-1 mb-5 text-sm text-text-secondary">
        Connect your calendar so AI Notetaker can automatically prepare for your meetings.
      </p>

      {accounts.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center">
          <p className="text-sm text-text-secondary">No calendars connected yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => (
            <div
              key={a.id || a.email}
              className="flex items-center justify-between p-3 rounded-md border border-border"
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold text-text-primary">{a.provider || 'Calendar'}</div>
                <div className="text-xs text-text-tertiary truncate">{a.email}</div>
                {a.lastSyncedAt && (
                  <div className="text-[11px] text-text-tertiary">Last synced {new Date(a.lastSyncedAt).toLocaleString()}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onDisconnectCalendar?.(a.provider)}
                className="text-xs font-medium text-danger hover:underline"
              >
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onConnectCalendar?.('google')}
          className="flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-border bg-surface text-sm font-medium text-text-primary hover:border-primary-300"
        >
          + Connect Google Calendar
        </button>
        <button
          type="button"
          onClick={() => onConnectCalendar?.('outlook')}
          className="flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-border bg-surface text-sm font-medium text-text-primary hover:border-primary-300"
        >
          + Connect Outlook Calendar
        </button>
      </div>
    </div>
  );
}

function PreferencesTab({ prefs, onToggle }) {
  return (
    <div>
      <h3 className="text-base font-semibold text-text-primary">Personal preferences</h3>
      <div className="mt-3 p-3 rounded-md bg-blue-50 dark:bg-blue-900/20 text-xs text-blue-700 dark:text-blue-300 flex items-start gap-2">
        <span aria-hidden="true">ℹ️</span>
        <span>These settings apply only to you. They do not affect other users in your account.</span>
      </div>

      <div className="mt-4 divide-y divide-border-light rounded-md border border-border-light">
        <ToggleRow
          icon={Mic}
          title="Auto-invite to meetings you create"
          description="Automatically enable AI Notetaker for any calendar meeting you create or host."
          checked={prefs.autoInviteOwn}
          onToggle={() => onToggle('autoInviteOwn')}
        />
        <ToggleRow
          icon={Mic}
          title="Auto-invite to meetings you're invited to"
          description="Automatically enable AI Notetaker for meetings you're invited to by others."
          checked={prefs.autoInviteInvited}
          onToggle={() => onToggle('autoInviteInvited')}
        />
        <ToggleRow
          icon={Mail}
          title="Receive meeting summary emails"
          description="Get a summary sent to your inbox after each meeting."
          checked={prefs.summaryEmails}
          onToggle={() => onToggle('summaryEmails')}
        />
        <ToggleRow
          icon={Mic}
          title="Record audio"
          description="Save audio recordings of meetings for playback."
          checked={prefs.recordAudio}
          onToggle={() => onToggle('recordAudio')}
        />
        <ToggleRow
          icon={FileText}
          title="Save transcripts"
          description="Store the full transcript of every meeting."
          checked={prefs.saveTranscripts}
          onToggle={() => onToggle('saveTranscripts')}
        />
        <ToggleRow
          icon={Brain}
          title="Allow AI to learn from my meetings"
          description="Let AI improve summary quality by learning from your patterns. No transcript data shared with third parties."
          checked={prefs.allowAILearning}
          onToggle={() => onToggle('allowAILearning')}
          privacy
        />
      </div>
    </div>
  );
}

function ToggleRow({ icon: Icon, title, description, checked, onToggle, privacy }) {
  return (
    <div className="flex items-start gap-3 px-3 py-3">
      <span className="mt-0.5 flex-shrink-0 w-7 h-7 rounded-md bg-surface-100 inline-flex items-center justify-center text-text-secondary">
        <Icon size={14} />
      </span>
      <div className="flex-1 min-w-0 pr-3">
        <div className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
          {title}
          {privacy && (
            <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-bold text-amber-700 bg-amber-100">
              Privacy
            </span>
          )}
        </div>
        <div className="text-xs text-text-tertiary mt-0.5">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={!!checked}
        aria-label={title}
        onClick={onToggle}
        className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-surface-200'
        }`}
      >
        <span
          className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform"
          style={{ transform: checked ? 'translateX(22px)' : 'translateX(2px)' }}
        />
      </button>
    </div>
  );
}

export { readPrefs as readNotetakerPrefs, writePrefs as writeNotetakerPrefs, DEFAULT_PREFS };
