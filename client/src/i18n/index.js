// Central registry of available locales. Adding a new language means
// (a) creating a new file under ./locales/, (b) importing it here, and
// (c) appending an entry to LANGUAGE_OPTIONS. The Profile UI auto-derives
// its picker from LANGUAGE_OPTIONS, so no further wiring is needed.

import en from './locales/en';
import hi from './locales/hi';

export const DEFAULT_LANGUAGE = 'en';

export const TRANSLATIONS = {
  en,
  hi,
};

export const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English',  nativeLabel: 'English' },
  { value: 'hi', label: 'Hindi',    nativeLabel: 'हिंदी' },
];

export const ALLOWED_LANGUAGES = LANGUAGE_OPTIONS.map(o => o.value);

/**
 * Resolve a dotted-path translation key against a locale tree. Returns the
 * raw string if found, or `undefined` if any segment misses — the caller
 * decides what to fall back to.
 */
function lookup(tree, key) {
  if (!tree || !key) return undefined;
  const parts = key.split('.');
  let cur = tree;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

/**
 * Translate a key in the given language, with English fallback and final
 * fallback to the key itself so an untranslated label is at least readable
 * instead of going blank. Supports simple {{var}} placeholder substitution
 * — passes through other tokens unchanged.
 */
export function translate(language, key, vars) {
  const lang = ALLOWED_LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
  const value =
    lookup(TRANSLATIONS[lang], key) ??
    lookup(TRANSLATIONS[DEFAULT_LANGUAGE], key) ??
    key;
  if (!vars || typeof value !== 'string') return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) =>
    vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : ''
  );
}
