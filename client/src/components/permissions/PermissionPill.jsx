import React from 'react';
import { X, Lock, Clock, AlertTriangle, EyeOff, ShieldAlert } from 'lucide-react';

// Token-driven category mapping. Phase B (May 2026 RBAC hardening UI) — the
// granular Phase A actions explode the action namespace far past what the
// pre-Phase-A LEVEL_COLORS table covered (it knew ~10 action names; we now
// have 100+). Instead of maintaining an exhaustive lookup, we categorise by
// verb token so every new action picks up a sensible default colour.
//
// Order of checks matters because action names compose tokens
// ('permanent_delete' contains 'delete', 'manage_members' contains 'manage'):
//   1. destructive — removal / archival / revocation / negative verbs
//   2. admin       — privileged management / configuration / impersonation
//   3. read        — view / list / search / export
//   4. write       — create / edit / set / assign / approve / restore
//   5. default     — anything we couldn't classify (renders as neutral grey)
const CATEGORY_TOKENS = {
  destructive: ['delete', 'remove', 'destroy', 'archive', 'revoke', 'reject', 'unassign', 'permanent', 'cancel'],
  admin: ['manage', 'admin', 'grant', 'permission', 'security', 'impersonate', 'configure', 'moderate'],
  read: ['view', 'read', 'list', 'search', 'export', 'download', 'preview'],
  write: [
    'create', 'edit', 'update', 'set', 'change', 'add', 'assign', 'approve',
    'submit', 'restore', 'delegate', 'comment', 'upload', 'use', 'receive',
    'clear', 'reorder', 'copy', 'duplicate', 'share', 'invite', 'escalate',
    'sync', 'run', 'generate', 'process', 'request',
  ],
};

export function categorizeAction(action) {
  const a = String(action || '').toLowerCase();
  if (!a) return 'default';
  const tokens = a.split(/[._-]+/).filter(Boolean);
  if (tokens.some((t) => CATEGORY_TOKENS.destructive.includes(t))) return 'destructive';
  if (tokens.some((t) => CATEGORY_TOKENS.admin.includes(t))) return 'admin';
  if (tokens.some((t) => CATEGORY_TOKENS.read.includes(t))) return 'read';
  if (tokens.some((t) => CATEGORY_TOKENS.write.includes(t))) return 'write';
  return 'default';
}

// Subtle Monday-style palette — no loud fills. Light bg + medium text +
// matching border. Dark variants keep contrast without saturated colours.
//
// `resource` is the chip category for a Resource/Module selection (e.g.
// "Tasks", "Labels"). It uses Monday-primary blue so resource pills are
// clearly readable AS resources at a glance, visually distinct from action
// pills (which inherit the action-verb category colour).
const CATEGORY_CLASSES = {
  resource:    'bg-primary-50 text-primary-700 border-primary-200 dark:bg-primary-900/30 dark:text-primary-200 dark:border-primary-800/50',
  read:        'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800/40',
  write:       'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800/40',
  destructive: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800/40',
  admin:       'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/20 dark:text-purple-300 dark:border-purple-800/40',
  default:     'bg-gray-100 text-gray-700 border-gray-300 dark:bg-zinc-700/50 dark:text-zinc-200 dark:border-zinc-600',
};

// Effect overlays sit on TOP of the category colour. The deny treatment
// intentionally drops the category colour entirely because the message
// ("this permission is REMOVED") outranks the action's intrinsic category.
const EFFECT_CLASSES = {
  deny:        'bg-red-50 text-red-700 border-red-300 line-through dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/50',
  not_allowed: 'bg-gray-50 text-gray-400 border-gray-200 line-through dark:bg-zinc-800/40 dark:text-zinc-500 dark:border-zinc-700/60',
  base:        'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800/40',
};

// Badge precedence — when multiple flags apply, only the highest-severity
// badge is shown so the chip stays compact. Locked > no_surface > pending >
// dangerous > warnOnDeny is the same ordering surfaced in the dropdown's
// per-option list, so users see a consistent label across views.
const BADGE_PRECEDENCE = ['locked', 'no_surface', 'pending', 'dangerous', 'warnOnDeny'];

const BADGE_META = {
  locked:      { label: 'Locked',          tone: 'red',   icon: Lock,         tooltip: 'System rule — cannot be granted or denied via overrides.' },
  no_surface:  { label: 'Not enforceable', tone: 'gray',  icon: EyeOff,       tooltip: 'No in-app surface to gate — granting / denying would have no effect.' },
  pending:     { label: 'Pending',         tone: 'amber', icon: Clock,        tooltip: 'Not yet wired in the backend — saving would have no effect.' },
  dangerous:   { label: 'Dangerous',       tone: 'red',   icon: ShieldAlert,  tooltip: 'Granting this allows a powerful or destructive action.' },
  warnOnDeny:  { label: 'Default ON',      tone: 'amber', icon: AlertTriangle, tooltip: 'Default-on for every user. Denying revokes a baseline ability.' },
};

const BADGE_TONE_CLASSES = {
  red:   'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  gray:  'bg-gray-100 text-gray-600 dark:bg-zinc-700 dark:text-zinc-300',
  blue:  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
};

const SIZE_CLASSES = {
  sm: 'text-[10px] px-1.5 py-0.5 gap-1',
  md: 'text-xs px-2 py-0.5 gap-1.5',
};

// Resolve which badge to render. Explicit `badge` prop wins; otherwise we
// derive from the catalog-aligned flags (enforcement / dangerous / warnOnDeny)
// using the precedence above so two flags never both render.
function resolveBadge({ badge, badgeTone, enforcement, dangerous, warnOnDeny, effect }) {
  if (badge) {
    return { label: badge, tone: badgeTone || 'gray', icon: null, tooltip: null };
  }
  const flags = {
    locked: enforcement === 'locked',
    no_surface: enforcement === 'no_surface',
    pending: enforcement === 'pending',
    dangerous: !!dangerous,
    // Default-ON only matters when the admin is actively about to deny.
    warnOnDeny: !!warnOnDeny && effect === 'deny',
  };
  for (const key of BADGE_PRECEDENCE) {
    if (flags[key]) return BADGE_META[key];
  }
  return null;
}

// Resolve which palette to apply. Effect (deny / not_allowed / base) wins
// because the effect message outranks the action's category colour.
function resolveStyles({ effect, category }) {
  if (effect && EFFECT_CLASSES[effect]) return EFFECT_CLASSES[effect];
  return CATEGORY_CLASSES[category] || CATEGORY_CLASSES.default;
}

/**
 * Compact pill rendering a permission action, its effect, and any catalog
 * metadata badges. Designed for the Admin Settings Permissions tab —
 * selected-chip lists, grant preview rows, and active-grants table cells.
 *
 * Either pass `action` (auto-categorised) or `category` (explicit). For
 * non-action chips (e.g. a resource pill) pass `category="default"` or
 * leave both undefined to get the neutral palette.
 */
export default function PermissionPill({
  action,
  category,
  label,
  effect,
  badge,
  badgeTone,
  enforcement,
  dangerous,
  warnOnDeny,
  description,
  reason,
  resource,
  size = 'sm',
  onRemove,
  className = '',
  'data-testid': dataTestId,
}) {
  const resolvedCategory = category || categorizeAction(action);
  const styleClasses = resolveStyles({ effect, category: resolvedCategory });
  const sizeClasses = SIZE_CLASSES[size] || SIZE_CLASSES.sm;

  const resolvedBadge = resolveBadge({
    badge, badgeTone, enforcement, dangerous, warnOnDeny, effect,
  });

  // Tooltip prefers the most specific text available: caller-provided reason
  // (used for locked/pending explanations) beats description beats badge
  // tooltip beats the bare action key. Falls back to undefined so we don't
  // emit an empty `title` attribute.
  const tooltipParts = [];
  if (resource && action) tooltipParts.push(`${resource}.${action}`);
  else if (action) tooltipParts.push(action);
  if (description) tooltipParts.push(description);
  if (reason) tooltipParts.push(reason);
  else if (resolvedBadge?.tooltip) tooltipParts.push(resolvedBadge.tooltip);
  const tooltip = tooltipParts.length > 0 ? tooltipParts.join(' — ') : undefined;

  const displayLabel = label || action || category || '';
  const BadgeIcon = resolvedBadge?.icon || null;

  return (
    <span
      data-testid={dataTestId}
      data-category={resolvedCategory}
      data-effect={effect || 'none'}
      title={tooltip}
      className={`inline-flex items-center ${sizeClasses} font-medium rounded-full border ${styleClasses} ${className}`}
    >
      {displayLabel}
      {resolvedBadge && (
        <span
          className={`inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wider px-1 py-px rounded ${BADGE_TONE_CLASSES[resolvedBadge.tone] || BADGE_TONE_CLASSES.gray}`}
        >
          {BadgeIcon && <BadgeIcon size={8} />}
          {resolvedBadge.label}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${displayLabel}`}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="ml-0.5 -mr-0.5 hover:text-red-500 transition-colors leading-none"
        >
          <X size={size === 'md' ? 11 : 10} />
        </button>
      )}
    </span>
  );
}
