import React, { createContext, useContext, useEffect, useCallback, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';
import { ALLOWED_LANGUAGES, DEFAULT_LANGUAGE, LANGUAGE_OPTIONS, translate } from '../i18n';

const LanguageContext = createContext(null);

// localStorage cache so the saved preference applies before /auth/me resolves
// on a cold reload — avoids a one-frame "English → user-pref" flash. Mirrors
// the pattern used by FontSizeContext.
const LS_KEY = 'languagePreference';

function readCached() {
  try {
    const v = localStorage.getItem(LS_KEY);
    return ALLOWED_LANGUAGES.includes(v) ? v : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

function applyToDocument(lang) {
  const safe = ALLOWED_LANGUAGES.includes(lang) ? lang : DEFAULT_LANGUAGE;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', safe);
  }
}

export function LanguageProvider({ children }) {
  const { user, updateProfile } = useAuth();

  // Logged-in source of truth = user.language. Logged-out fallback = cached
  // localStorage value (so the Login screen / pre-auth surfaces show the
  // last-used language). On logout we reset to default — a fresh login
  // screen shouldn't carry the previous user's language preference.
  const [language, setLanguageState] = useState(() => readCached());

  useEffect(() => {
    if (!user) {
      applyToDocument(language);
      return;
    }
    const pref = ALLOWED_LANGUAGES.includes(user.language) ? user.language : DEFAULT_LANGUAGE;
    if (pref !== language) setLanguageState(pref);
    applyToDocument(pref);
    try { localStorage.setItem(LS_KEY, pref); } catch {}
    // We intentionally key on user only — the inner setLanguageState avoids
    // a loop because we early-out when the values already match.
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update the user's preference. Optimistically applies (instant UI change),
  // then persists to the backend. On failure we roll back to the server's
  // value so the UI stays consistent with what's actually stored.
  const setLanguage = useCallback(async (value) => {
    if (!ALLOWED_LANGUAGES.includes(value)) {
      throw new Error(`Invalid language: ${value}`);
    }
    const previous = language;
    setLanguageState(value);
    applyToDocument(value);
    try { localStorage.setItem(LS_KEY, value); } catch {}
    if (!user) return;
    try {
      await updateProfile({ language: value });
    } catch (err) {
      setLanguageState(previous);
      applyToDocument(previous);
      try { localStorage.setItem(LS_KEY, previous); } catch {}
      throw err;
    }
  }, [user, updateProfile, language]);

  // t() is the workhorse — components call useT() to grab it and translate
  // any UI string by dotted key. Vars param supports {{name}} substitution.
  const t = useCallback((key, vars) => translate(language, key, vars), [language]);

  const value = useMemo(() => ({
    language,
    setLanguage,
    t,
    options: LANGUAGE_OPTIONS,
  }), [language, setLanguage, t]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

/**
 * Full hook — language, setter, options, and t(). Use this when you need
 * any of the metadata or to change the language (e.g. the Profile picker).
 */
export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    // Safe fallback when used outside the provider (e.g. tests, error
    // boundaries) — returns English translations and a no-op setter so
    // components never crash with "useLanguage must be used inside…".
    return {
      language: DEFAULT_LANGUAGE,
      setLanguage: () => {},
      t: (key, vars) => translate(DEFAULT_LANGUAGE, key, vars),
      options: LANGUAGE_OPTIONS,
    };
  }
  return ctx;
}

/**
 * Convenience hook: just `const t = useT();` for components that don't need
 * the setter / metadata. Keeps render code visually compact.
 */
export function useT() {
  return useLanguage().t;
}
