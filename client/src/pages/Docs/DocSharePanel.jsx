import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Share2, X, Loader2, Search, Check, ChevronDown } from 'lucide-react';

import PortalDropdown from '../../components/common/PortalDropdown';
import { useToast } from '../../components/common/Toast';
import {
  listCollaborators,
  addCollaborator,
  updateCollaboratorLevel,
  removeCollaborator,
  listMentionableUsers,
} from '../../services/docsService';
import { getErrorMessage } from '../../utils/errorMap';
import safeLog from '../../utils/safeLog';
import LetterAvatar from '../../components/common/LetterAvatar';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';

/**
 * DocSharePanel — feat/docs-personal-notion Phase 8.
 *
 * Replaces the legacy `DocShareDropdown` (which only flipped the
 * `sharePolicy` enum). The new panel surfaces the real `doc_access` rows
 * the doc has: an owner row + every manual_share / mention / legacy_workspace
 * grant. Owners can add, change level, and revoke.
 *
 * Props:
 *   docId           — required
 *   canEdit         — whether the caller is the doc owner (or super-admin).
 *                     False = read-only panel (collaborators listed but no
 *                     controls).
 *   onChanged       — optional callback fired after a successful mutation
 *                     so the parent can refresh anything depending on the
 *                     collaborator set (e.g. realtime indicators).
 *
 * The picker for "add someone new" reuses /api/users/mentions (Phase 4 —
 * global active-user search). Selecting a user instantly POSTs the
 * grant; the row appears in the list. No drafts, no "send" button — the
 * action is the click.
 */

const LEVEL_OPTIONS = [
  { value: 'view',    label: 'Can view' },
  { value: 'comment', label: 'Can comment' },
  { value: 'edit',    label: 'Can edit' },
];

// The default permission applied when sharing with someone new. Defaults to
// 'edit' so the common "share so they can collaborate" path is one click —
// the owner can downgrade to view/comment via the segmented selector before
// picking a person, or change it later on the collaborator row.
const DEFAULT_SHARE_LEVEL = 'edit';

const SOURCE_LABELS = {
  mention:          { text: 'via @mention',     hint: 'Added because they were mentioned in the doc. Remove the mention from the body to revoke.' },
  manual_share:     { text: 'manual share',     hint: 'Added directly from the Share panel.' },
  legacy_workspace: { text: 'from old workspace', hint: 'Backfilled at the personal-docs migration. Safe to prune.' },
  owner:            { text: 'owner',            hint: 'Full access.' },
};

export default function DocSharePanel({ docId, canEdit, onChanged }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [owner, setOwner] = useState(null);
  const [collaborators, setCollaborators] = useState([]);
  const triggerRef = useRef(null);

  // ─── load collaborators when the panel opens ──────────────────────
  const load = useCallback(async () => {
    if (!docId) return;
    setLoading(true);
    try {
      const { owner: o, collaborators: c } = await listCollaborators(docId);
      setOwner(o || null);
      setCollaborators(Array.isArray(c) ? c : []);
    } catch (err) {
      safeLog.error('[DocSharePanel] load failed', err);
      toast.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [docId, toast]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Live-refresh while the panel is open when the collaborator set changes
  // anywhere (a peer's mention edit, another tab's share, etc.).
  useRealtimeEvent('doc:collaborators:changed', useCallback((payload) => {
    if (open && payload?.docId === docId) load();
  }, [open, docId, load]));

  // ─── add picker — typeahead via /api/users/mentions ───────────────
  // The member list is shown immediately when the panel opens (no "Add
  // people" gate) so the owner sees who they can share with right away.
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerResults, setPickerResults] = useState([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const pickerInputRef = useRef(null);

  // Fetch members whenever the panel is open and the query changes. An empty
  // query returns the top active users so there's always a list to pick from.
  useEffect(() => {
    if (!open || !canEdit) return undefined;
    let cancelled = false;
    const t = setTimeout(async () => {
      setPickerLoading(true);
      try {
        const { users } = await listMentionableUsers({ q: pickerQuery, limit: 20 });
        if (!cancelled) setPickerResults(Array.isArray(users) ? users : []);
      } catch (err) {
        safeLog.warn('[DocSharePanel] picker fetch failed', err);
        if (!cancelled) setPickerResults([]);
      } finally {
        if (!cancelled) setPickerLoading(false);
      }
    }, pickerQuery ? 200 : 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, canEdit, pickerQuery]);

  // Autofocus the search box shortly after the panel opens.
  useEffect(() => {
    if (open && canEdit) {
      const t = setTimeout(() => pickerInputRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open, canEdit]);

  // Don't suggest people who are already collaborators (or the owner).
  const dedupedResults = useMemo(() => {
    const taken = new Set(collaborators.map((c) => c.user?.id).filter(Boolean));
    if (owner?.id) taken.add(owner.id);
    return pickerResults.filter((u) => !taken.has(u.id));
  }, [pickerResults, collaborators, owner]);

  async function handleAdd(user, level = DEFAULT_SHARE_LEVEL) {
    try {
      const { collaborator } = await addCollaborator(docId, { userId: user.id, accessLevel: level });
      const levelLabel = LEVEL_OPTIONS.find((o) => o.value === level)?.label?.toLowerCase() || level;
      toast.success(`Shared with ${user.name || user.email} (${levelLabel})`);
      setPickerQuery('');
      // Optimistic insert; load() also fires to confirm.
      setCollaborators((prev) => [...prev.filter((c) => c.user?.id !== user.id), collaborator]);
      load();
      onChanged?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function handleChangeLevel(row, level) {
    if (row.accessLevel === level) return;
    try {
      const { collaborator } = await updateCollaboratorLevel(docId, row.user.id, level);
      setCollaborators((prev) => prev.map((c) => (c.user?.id === row.user?.id ? collaborator : c)));
      toast.success('Access updated');
      onChanged?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function handleRemove(row) {
    if (!window.confirm(`Remove ${row.user?.name || 'this person'} from this doc?`)) return;
    try {
      await removeCollaborator(docId, row.user.id);
      setCollaborators((prev) => prev.filter((c) => c.user?.id !== row.user?.id));
      toast.success('Access removed');
      onChanged?.();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="share-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="doc-page-notion__share-trigger"
        title="Share this doc"
      >
        <Share2 size={13} aria-hidden="true" />
        <span>Share</span>
      </button>
      <PortalDropdown anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="right" width={252}>
        <div
          className="p-2.5 w-[252px] doc-page-notion__share-popover rounded-lg border shadow-lg"
          data-testid="share-menu"
          style={{
            backgroundColor: 'var(--primary-background-color, #ffffff)',
            borderColor: 'var(--layout-border-color, #e2e2e2)',
          }}
        >
        {/* Header */}
        <div className="mb-2">
          <div className="text-sm font-semibold text-text-primary">Share this doc</div>
          {canEdit && (
            <div className="text-[11px] text-text-tertiary mt-0.5">
              Share with anyone — set their permission below.
            </div>
          )}
        </div>

        {/* Picker — always visible for owners. Lists members immediately so
            sharing is a single pick. New shares default to "Can edit"; the
            owner can adjust each person's level from the per-row dropdown. */}
        {canEdit && (
          <div className="mb-2.5">
            <div className="border border-border rounded-md overflow-hidden">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
                <input
                  ref={pickerInputRef}
                  type="text"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  placeholder="Search people to share with…"
                  className="w-full pl-8 pr-3 py-1.5 text-[13px] border-b border-border focus:outline-none focus:ring-2 focus:ring-primary-300"
                  data-testid="share-search"
                />
              </div>
              <div className="max-h-40 overflow-auto">
                {pickerLoading ? (
                  <div className="p-3 flex items-center justify-center text-xs text-text-tertiary gap-1.5">
                    <Loader2 size={12} className="animate-spin" /> Loading members…
                  </div>
                ) : dedupedResults.length === 0 ? (
                  <div className="p-3 text-center text-xs text-text-tertiary">
                    {pickerQuery ? 'No matches.' : 'Everyone already has access.'}
                  </div>
                ) : (
                  dedupedResults.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => handleAdd(u)}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-50"
                      data-testid={`share-member-${u.id}`}
                    >
                      <LetterAvatar name={u.name || u.email} size="xs" shape="circle" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] text-text-primary truncate">{u.name || 'Unknown'}</div>
                        {u.email && (
                          <div className="text-[10px] text-text-tertiary truncate">{u.email}</div>
                        )}
                      </div>
                      <span className="text-[10px] text-primary font-medium">+ Share</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* People with access — owner + collaborators in one scrollable
            list so the panel never grows past the viewport. */}
        <div className="max-h-44 overflow-auto pr-0.5">
          {/* Owner */}
          {owner && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-surface-50 mb-1">
              <LetterAvatar name={owner.name} size="xs" shape="circle" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-text-primary truncate font-medium">{owner.name}</div>
                <div className="text-[10px] text-text-tertiary truncate">{owner.email}</div>
              </div>
              <span className="text-[10px] uppercase font-bold text-primary tracking-wide">Owner</span>
            </div>
          )}

          {/* Collaborators */}
          {loading ? (
            <div className="py-5 flex items-center justify-center text-xs text-text-tertiary gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Loading collaborators…
            </div>
          ) : collaborators.length === 0 ? (
            <div className="py-5 text-center text-xs text-text-tertiary">
              {canEdit
                ? 'No one else has access yet. Search above to share.'
                : 'You are the only one with access right now.'}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {collaborators.map((row) => {
                const sourceLabel = SOURCE_LABELS[row.source] || { text: row.source || '', hint: '' };
                return (
                  <li key={row.user?.id || row.id} className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-surface-50">
                    <LetterAvatar name={row.user?.name || row.user?.email} size="xs" shape="circle" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-text-primary truncate">
                        {row.user?.name || 'Unknown user'}
                      </div>
                      <div className="text-[10px] text-text-tertiary truncate" title={sourceLabel.hint}>
                        {sourceLabel.text}
                      </div>
                    </div>
                    {canEdit ? (
                      <>
                        <LevelSelect
                          value={row.accessLevel}
                          onChange={(level) => handleChangeLevel(row, level)}
                        />
                        <button
                          type="button"
                          onClick={() => handleRemove(row)}
                          aria-label="Remove collaborator"
                          className="p-1 rounded text-text-tertiary hover:bg-surface-100 hover:text-danger"
                          title="Remove access"
                        >
                          <X size={12} />
                        </button>
                      </>
                    ) : (
                      <span className="text-[11px] text-text-secondary capitalize">{row.accessLevel}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        </div>
      </PortalDropdown>
    </>
  );
}

// Inline level selector — styled dropdown (replaces the unstyled native
// <select>) so the per-collaborator permission control matches the rest of
// the UI. Rendered through PortalDropdown so it escapes the collaborator
// list's scroll container and the panel's clipping, and flips upward
// automatically when there's no room below (the case the user hit where
// "Can edit" fell off the bottom of the screen). `stopPropagation` on the
// menu's mousedown keeps the parent Share panel open when a level is picked.
function LevelSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const current = LEVEL_OPTIONS.find((o) => o.value === value) || LEVEL_OPTIONS[0];
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Access level"
        className="inline-flex items-center gap-1 text-[11px] font-medium border border-border rounded px-1.5 py-0.5 bg-surface text-text-secondary hover:border-primary-300 focus:outline-none focus:ring-1 focus:ring-primary"
      >
        <span>{current.label}</span>
        <ChevronDown size={11} className="opacity-60" />
      </button>
      <PortalDropdown anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} align="right" width={140}>
        <div
          className="rounded-md border shadow-lg py-1"
          role="menu"
          // Keep the Share panel (a sibling PortalDropdown) open: stop the
          // mousedown from reaching the panel's document-level outside-click
          // listener, which would otherwise unmount this menu mid-click.
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            backgroundColor: 'var(--primary-background-color, #ffffff)',
            borderColor: 'var(--layout-border-color, #e2e2e2)',
          }}
        >
          {LEVEL_OPTIONS.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => { setOpen(false); onChange(o.value); }}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                  active ? 'text-primary font-medium bg-primary-50' : 'text-text-primary hover:bg-surface-50'
                }`}
              >
                <span className="flex-1">{o.label}</span>
                {active && <Check size={12} className="text-primary flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      </PortalDropdown>
    </>
  );
}
