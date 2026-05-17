import React, { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Share2, Lock, Users, Globe, Copy, Check } from 'lucide-react';

import Popover from '../../components/common/Popover';
import { useToast } from '../../components/common/Toast';
import { updateDocSharePolicy } from '../../services/docsService';
import { getErrorMessage } from '../../utils/errorMap';
import safeLog from '../../utils/safeLog';

/**
 * DocShareDropdown — Phase H.
 *
 *   <DocShareDropdown
 *     docId={doc.id}
 *     currentSharePolicy={doc.sharePolicy}
 *     canEdit={canEdit}
 *     onChanged={(newPolicy) => setDoc({ ...doc, sharePolicy: newPolicy })}
 *   />
 *
 * Three policies (server-canonical names):
 *   - private       — only the doc owner can read
 *   - workspace     — anyone in the workspace (default)
 *   - public_link   — anyone with the link
 *
 * Optimistic UI: clicking a radio row immediately reflects the new policy
 * locally. If the PATCH fails, we roll back to the previous value and
 * surface an error toast. The toast is shown even on success because the
 * change is otherwise silent.
 *
 * `canEdit === false` renders the trigger as a read-only caption that
 * just labels the current sharing scope, with no radio rows.
 */

const POLICIES = [
  {
    key: 'private',
    icon: Lock,
    label: 'Private',
    caption: 'Only you can view',
  },
  {
    key: 'workspace',
    icon: Users,
    label: 'Workspace',
    caption: 'Anyone in this workspace',
  },
  {
    key: 'public_link',
    icon: Globe,
    label: 'Public link',
    caption: 'Anyone with the link',
  },
];

function shortLabelFor(policy) {
  switch (policy) {
    case 'private': return 'Private';
    case 'public_link': return 'Public';
    case 'workspace':
    default:
      return 'Workspace';
  }
}

export default function DocShareDropdown({
  docId,
  currentSharePolicy = 'workspace',
  canEdit = true,
  onChanged,
}) {
  const { workspaceId } = useParams();
  const toast = useToast();
  const [policy, setPolicy] = useState(currentSharePolicy || 'workspace');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Build the public share URL — used by the "Copy link" affordance when
  // the policy is set to public_link. We build it off window.location so
  // dev (localhost), preview (vercel-ish), and prod all just work.
  const publicUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const origin = window.location.origin;
    if (!workspaceId || !docId) return origin;
    return `${origin}/workspaces/${workspaceId}/docs/${docId}`;
  }, [workspaceId, docId]);

  const handlePick = useCallback(async (nextPolicy) => {
    if (!docId || nextPolicy === policy) return;
    const previous = policy;
    setPolicy(nextPolicy); // optimistic
    setBusy(true);
    try {
      await updateDocSharePolicy(docId, nextPolicy);
      try { onChanged?.(nextPolicy); } catch { /* non-fatal */ }
      toast?.success?.('Sharing updated.');
    } catch (err) {
      safeLog.error('[DocShareDropdown] updateDocSharePolicy failed', err);
      setPolicy(previous); // rollback
      toast?.error?.(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [docId, policy, onChanged, toast]);

  const handleCopy = useCallback(async () => {
    if (!publicUrl) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(publicUrl);
      }
      setCopied(true);
      toast?.info?.('Link copied to clipboard.');
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      safeLog.warn('[DocShareDropdown] clipboard.writeText failed', err);
      toast?.error?.('Could not copy link.');
    }
  }, [publicUrl, toast]);

  const triggerLabel = `Share · ${shortLabelFor(policy)}`;

  // Read-only branch: render the trigger as a static caption (still inside
  // a Popover so the visual chrome matches the editable branch). The
  // popover body just describes the current state — no radios.
  if (!canEdit) {
    return (
      <Popover placement="bottom-end" offset={6}>
        <Popover.Trigger>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md text-text-secondary border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
            aria-label="Doc sharing"
          >
            <Share2 size={13} />
            <span>{triggerLabel}</span>
          </button>
        </Popover.Trigger>
        <Popover.Content width={280} ariaLabel="Doc sharing (read-only)">
          <div
            className="rounded-md shadow-md border p-3"
            style={{
              backgroundColor: 'var(--primary-background-color, #ffffff)',
              borderColor: 'var(--layout-border-color, #e2e2e2)',
            }}
            data-testid="share-readonly"
          >
            <div className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary mb-2">
              Sharing
            </div>
            <div className="text-sm text-text-primary font-medium">
              {shortLabelFor(policy)}
            </div>
            <div className="text-xs text-text-tertiary mt-1">
              Only the doc owner or workspace admins can change sharing.
            </div>
          </div>
        </Popover.Content>
      </Popover>
    );
  }

  return (
    <Popover placement="bottom-end" offset={6}>
      <Popover.Trigger>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md text-text-primary border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
          aria-label="Share doc"
          data-testid="share-trigger"
        >
          <Share2 size={13} />
          <span>{triggerLabel}</span>
        </button>
      </Popover.Trigger>
      <Popover.Content width={320} ariaLabel="Share doc">
        <div
          className="rounded-md shadow-md border overflow-hidden"
          style={{
            backgroundColor: 'var(--primary-background-color, #ffffff)',
            borderColor: 'var(--layout-border-color, #e2e2e2)',
          }}
          data-testid="share-menu"
        >
          <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
            Who can see this doc
          </div>
          <ul className="py-1">
            {POLICIES.map((p) => {
              const Icon = p.icon;
              const isActive = policy === p.key;
              return (
                <li key={p.key}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    onClick={() => handlePick(p.key)}
                    disabled={busy}
                    className={`w-full flex items-start gap-3 px-3 py-2 text-left text-sm transition-colors disabled:opacity-60 ${
                      isActive
                        ? 'bg-primary-50 dark:bg-primary/10'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                    }`}
                    data-testid={`share-row-${p.key}`}
                  >
                    <span
                      className={`flex-shrink-0 mt-0.5 w-7 h-7 rounded-md inline-flex items-center justify-center ${
                        isActive ? 'bg-primary text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-text-secondary'
                      }`}
                    >
                      <Icon size={14} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block font-medium text-text-primary">
                        {p.label}
                      </span>
                      <span className="block text-xs text-text-tertiary mt-0.5">
                        {p.caption}
                      </span>
                    </span>
                    {isActive && (
                      <Check size={14} className="flex-shrink-0 mt-1.5 text-primary" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {policy === 'public_link' && (
            <div
              className="border-t px-3 py-2.5 bg-zinc-50 dark:bg-zinc-800/40"
              style={{ borderColor: 'var(--layout-border-color, #e2e2e2)' }}
              data-testid="share-public-link"
            >
              <div className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary mb-1">
                Public link
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={publicUrl}
                  className="flex-1 min-w-0 text-xs px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-text-primary truncate"
                  onFocus={(e) => e.target.select()}
                  aria-label="Public share link"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-primary text-white hover:opacity-90"
                  data-testid="share-copy"
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
        </div>
      </Popover.Content>
    </Popover>
  );
}
