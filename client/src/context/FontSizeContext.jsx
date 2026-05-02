import React, { createContext, useContext, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from './AuthContext';

const FontSizeContext = createContext(null);

export const FONT_SIZE_OPTIONS = [
  { value: 'compact',     label: 'Compact',     description: 'Maximum density',                px: 14 },
  { value: 'default',     label: 'Default',     description: 'Slightly compact (recommended)', px: 15 },
  { value: 'comfortable', label: 'Comfortable', description: 'Browser standard',               px: 16 },
  { value: 'large',       label: 'Large',       description: 'Easier to read',                 px: 17 },
];

const ALLOWED = FONT_SIZE_OPTIONS.map(o => o.value);
export const DEFAULT_FONT_SIZE = 'default';

// localStorage cache so the saved preference applies before /auth/me resolves
// on a cold reload — avoids a one-frame "default → user-pref" flash.
const LS_KEY = 'fontSizePreference';

function readCachedPreference() {
  try {
    const v = localStorage.getItem(LS_KEY);
    return ALLOWED.includes(v) ? v : DEFAULT_FONT_SIZE;
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

function applyToDocument(value) {
  const safe = ALLOWED.includes(value) ? value : DEFAULT_FONT_SIZE;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-font-size', safe);
  }
}

export function FontSizeProvider({ children }) {
  const { user, updateProfile } = useAuth();

  // The inline script in index.html has already applied the cached preference
  // by the time React mounts, so we don't need to do anything here for the
  // initial paint — readCachedPreference is exported only as a safety net for
  // anything that boots without that script (tests, SSR, etc).

  // Whenever the authed user's saved preference changes, mirror it onto the
  // <html> element + cache. This is the source of truth — the localStorage
  // cache only exists to avoid a flash on cold boot.
  useEffect(() => {
    if (!user) {
      // Logged-out: fall back to the global default so login screen looks
      // like a fresh install regardless of the previous user's choice.
      applyToDocument(DEFAULT_FONT_SIZE);
      try { localStorage.removeItem(LS_KEY); } catch {}
      return;
    }
    const pref = ALLOWED.includes(user.fontSizePreference) ? user.fontSizePreference : DEFAULT_FONT_SIZE;
    applyToDocument(pref);
    try { localStorage.setItem(LS_KEY, pref); } catch {}
  }, [user]);

  // Update the user's preference. Optimistically applies to the DOM so the
  // change is visible instantly, then persists to the server. On failure we
  // roll the DOM back to whatever the server says we have.
  const setFontSize = useCallback(async (value) => {
    if (!ALLOWED.includes(value)) {
      throw new Error(`Invalid font size: ${value}`);
    }
    applyToDocument(value);
    try { localStorage.setItem(LS_KEY, value); } catch {}
    if (!user) return;
    try {
      await updateProfile({ fontSizePreference: value });
    } catch (err) {
      // Roll back to the server's value on failure.
      const fallback = ALLOWED.includes(user.fontSizePreference) ? user.fontSizePreference : DEFAULT_FONT_SIZE;
      applyToDocument(fallback);
      try { localStorage.setItem(LS_KEY, fallback); } catch {}
      throw err;
    }
  }, [user, updateProfile]);

  const reset = useCallback(() => setFontSize(DEFAULT_FONT_SIZE), [setFontSize]);

  const current = user?.fontSizePreference && ALLOWED.includes(user.fontSizePreference)
    ? user.fontSizePreference
    : DEFAULT_FONT_SIZE;

  const value = useMemo(() => ({
    fontSize: current,
    setFontSize,
    reset,
    options: FONT_SIZE_OPTIONS,
  }), [current, setFontSize, reset]);

  return (
    <FontSizeContext.Provider value={value}>
      {children}
    </FontSizeContext.Provider>
  );
}

export function useFontSize() {
  const ctx = useContext(FontSizeContext);
  if (!ctx) {
    return {
      fontSize: DEFAULT_FONT_SIZE,
      setFontSize: () => {},
      reset: () => {},
      options: FONT_SIZE_OPTIONS,
    };
  }
  return ctx;
}
