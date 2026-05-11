// Centralised translators for the three enum-shaped values that the backend
// stores as raw strings: priority keys, status keys, and system-default
// group names. Every list/board/task surface in the app renders one or more
// of these — by funneling them through this module we keep the i18n logic
// in one place, so adding a new priority or status only needs an update to
// the locale files plus an entry here if it has special handling.
//
// All three helpers are designed to be safe for user-customised data:
//   - translatePriority(key)        : returns the i18n label OR the raw key
//                                     formatted nicely if no translation
//                                     exists. Priorities are a fixed enum,
//                                     so a custom key would mean a backend
//                                     bug — we surface the raw key so the
//                                     bug is visible rather than silent.
//   - translateStatus(key, label)   : returns the i18n label for the key
//                                     ONLY when the caller's label matches
//                                     the English default. Custom user-
//                                     defined status labels pass through.
//   - translateSystemGroupName(name): translates the exact-match seed names
//                                     ("New Task", "In Progress", etc.).
//                                     User-renamed groups pass through.
//
// The `t` function must be passed in from the calling component so this
// stays a pure module (no React import, no hook). Use the `useT()` hook in
// components and forward the returned function to these helpers.

import { TRANSLATIONS, DEFAULT_LANGUAGE } from '../i18n';

// English defaults for each known priority key. Source of truth for the
// "is this the untranslated default?" check — we never compare against the
// active locale because that would prevent a user from re-selecting English
// and seeing the English label again.
const ENGLISH_PRIORITY_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const ENGLISH_STATUS_LABELS = (() => {
  const en = TRANSLATIONS[DEFAULT_LANGUAGE] || {};
  return { ...(en.status || {}) };
})();

/**
 * Translate a priority key (e.g. "critical" → "बहुत जरूरी" in Hindi).
 *
 * @param {string} key      Raw priority value from the database
 * @param {Function} t      The i18n translator from useT()
 * @param {string} [fallback] What to render if the key is unknown — defaults
 *                            to the key itself (which lets unexpected backend
 *                            values surface visibly instead of going blank).
 */
export function translatePriority(key, t, fallback) {
  if (!key) return t('priority.none');
  const translated = t(`priority.${key}`);
  if (translated && translated !== `priority.${key}`) return translated;
  return fallback != null ? fallback : key;
}

/**
 * Translate a status key — but only when the supplied label still matches
 * the English default. A user who renames the status to their own wording
 * (via the StatusCell edit-labels UI) gets to keep their label.
 *
 * @param {string} key   Status key (e.g. "working_on_it")
 * @param {string} label The currently-rendered label string. Used to detect
 *                       custom user labels. Pass the raw config.label.
 * @param {Function} t   The i18n translator from useT()
 */
export function translateStatus(key, label, t) {
  if (!key) return label || '';
  const englishDefault = ENGLISH_STATUS_LABELS[key];
  if (englishDefault && (label === englishDefault || label == null)) {
    const translated = t(`status.${key}`);
    if (translated && translated !== `status.${key}`) return translated;
  }
  return label || key;
}

/**
 * Translate a board group's display name. Only translates names that exactly
 * match a known system-default seed name (e.g. "New Task"). Any other name —
 * including custom user-created group names — passes through verbatim.
 *
 * The mapping is keyed on the English source string rather than a synthetic
 * id because the backend persists the group name itself, not a separate
 * "isSystem" flag. This guarantees a user can rename "New Task" to "नया काम"
 * by hand and the helper won't try to re-translate the now-Hindi value.
 */
export function translateSystemGroupName(name, language) {
  if (!name) return '';
  const lang = TRANSLATIONS[language] ? language : DEFAULT_LANGUAGE;
  const map = TRANSLATIONS[lang]?.systemGroupNames;
  if (map && Object.prototype.hasOwnProperty.call(map, name)) {
    return map[name];
  }
  return name;
}

/**
 * Pluralised "N items" string. Uses three-way plural keys (zero/one/other)
 * so future locales with different pluralisation rules can extend cleanly.
 * Hindi treats 0/1/many similarly to English (one vs other), so two buckets
 * are enough for now — the zero key exists only so an empty group can render
 * a clean "0 items" without the awkward "0 item" singular fallthrough.
 */
export function formatItemsCount(count, t) {
  const n = Math.max(0, count | 0);
  if (n === 0) return t('task.itemsZero');
  if (n === 1) return t('task.itemsOne');
  return t('task.itemsOther', { count: n });
}
