import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Check, CheckCircle2, Edit3, MessageSquare, MoreHorizontal,
  Quote, Send, Trash2, Undo2, X,
} from 'lucide-react';

import SidePanel from './SidePanel/SidePanel';
import LetterAvatar from './LetterAvatar/LetterAvatar';
import { useToast } from './Toast';
import { getErrorMessage } from '../../utils/errorMap';
import {
  listDocComments, addDocComment, updateDocComment,
  deleteDocComment, resolveDocComment, unresolveDocComment,
} from '../../services/docsService';

/**
 * DocCommentsSidebar — Phase F right-side panel for Notion/Google-Docs-
 * style threaded comments anchored to a snapshot of the selected doc text.
 *
 *   <DocCommentsSidebar
 *     isOpen={open}
 *     onClose={() => setOpen(false)}
 *     docId="d1"
 *     currentUser={{ id, name, avatar }}
 *     pendingAnchor={{ text: 'highlighted span', from, to } | null}
 *   />
 *
 * Behaviour:
 *  - Slides in from the right (360 px) using the shared <SidePanel> primitive.
 *  - Filter pills (All / Open / Resolved) live in the header.
 *  - List renders top-level threads with nested replies underneath.
 *  - Each comment exposes a kebab menu (Edit / Delete / Resolve / Reopen).
 *  - The bottom composer is the entry point for new top-level comments;
 *    if pendingAnchor is supplied the chip is shown above the input.
 *  - Optimistic add: a temp thread is inserted at the top of the list and
 *    swapped with the server response on success (or rolled back on error).
 */

const FILTERS = ['all', 'open', 'resolved'];
const DELETED_MARKER = '[deleted]';
const EMPTY_PROMPT = "No comments yet. Highlight text in the doc and click the comment icon to leave one.";

function safeTimeAgo(value) {
  if (!value) return '';
  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true });
  } catch {
    return '';
  }
}

function makeTempId() {
  return `tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export default function DocCommentsSidebar({
  isOpen,
  onClose,
  docId,
  currentUser,
  pendingAnchor = null,
  // Phase F polish — DocPage hands us a callback so inline comment
  // highlight marks stay in sync after add / edit / delete / resolve.
  // Optional; the sidebar still functions if it's omitted (highlights
  // just don't refresh until the user reopens the doc).
  onChanged,
}) {
  const toast = useToast();
  // Stable ref so we can call onChanged from inside callbacks without
  // having to thread it through every dep array.
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);
  const notifyChanged = useCallback(() => {
    try { onChangedRef.current?.(); } catch { /* no-op */ }
  }, []);
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [newBody, setNewBody] = useState('');
  // Per-thread reply drafts: { [threadId]: string }
  const [replyDrafts, setReplyDrafts] = useState({});
  // Per-comment edit drafts: { [commentId]: string | undefined }
  const [editDrafts, setEditDrafts] = useState({});
  // Track which kebab menu is open: { [commentId]: boolean }
  const [openMenu, setOpenMenu] = useState(null);
  const composerRef = useRef(null);

  // Fetch threads whenever the panel opens for a new docId.
  //
  // Deliberately omit `toast` from deps — `useToast()` returns a fresh
  // object on every render, which would re-fire this effect on every
  // re-render and yank `loading` back to true mid-paint (the symptom that
  // made the test's `getByText('Other Person')` race with a re-mount of
  // the "Loading comments…" placeholder). toast is only used inside the
  // `.catch`; a stale reference is harmless.
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);
  useEffect(() => {
    if (!isOpen || !docId) return;
    let cancelled = false;
    setLoading(true);
    listDocComments(docId)
      .then((data) => {
        if (cancelled) return;
        setThreads(Array.isArray(data?.threads) ? data.threads : []);
      })
      .catch((err) => {
        if (cancelled) return;
        toastRef.current?.error?.(getErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, docId]);

  // Auto-focus the composer when a pendingAnchor arrives so the user can
  // start typing immediately after hitting "Comment on selection".
  useEffect(() => {
    if (!pendingAnchor || !isOpen) return;
    const t = setTimeout(() => {
      composerRef.current?.focus?.();
    }, 80);
    return () => clearTimeout(t);
  }, [pendingAnchor, isOpen]);

  const visibleThreads = useMemo(() => {
    if (filter === 'open') return threads.filter((t) => !t.resolved);
    if (filter === 'resolved') return threads.filter((t) => t.resolved);
    return threads;
  }, [threads, filter]);

  // ─── thread mutations ───────────────────────────────────────────────

  const handleSubmitTopLevel = useCallback(async () => {
    const body = newBody.trim();
    if (!body) return;
    const anchorText = pendingAnchor?.text || '';
    if (!anchorText) {
      toast.error('Highlight text in the doc first, then add a comment.');
      return;
    }
    const tempId = makeTempId();
    const optimistic = {
      id: tempId,
      docId,
      parentId: null,
      authorId: currentUser?.id,
      author: currentUser
        ? { id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar }
        : null,
      body,
      anchorText,
      anchorFrom: pendingAnchor?.from ?? null,
      anchorTo: pendingAnchor?.to ?? null,
      resolved: false,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: new Date().toISOString(),
      replies: [],
      __optimistic: true,
    };
    setThreads((prev) => [optimistic, ...prev]);
    setNewBody('');
    try {
      const data = await addDocComment(docId, {
        body,
        anchorText,
        anchorFrom: pendingAnchor?.from,
        anchorTo: pendingAnchor?.to,
      });
      const real = data?.comment;
      if (real) {
        setThreads((prev) => prev.map((t) => (
          t.id === tempId ? { ...real, replies: [] } : t
        )));
      }
      notifyChanged();
    } catch (err) {
      setThreads((prev) => prev.filter((t) => t.id !== tempId));
      toast.error(getErrorMessage(err));
    }
  }, [newBody, pendingAnchor, docId, currentUser, toast, notifyChanged]);

  const handleSubmitReply = useCallback(async (parentThread) => {
    const draft = (replyDrafts[parentThread.id] || '').trim();
    if (!draft) return;
    const tempId = makeTempId();
    const optimistic = {
      id: tempId,
      docId,
      parentId: parentThread.id,
      authorId: currentUser?.id,
      author: currentUser
        ? { id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar }
        : null,
      body: draft,
      anchorText: parentThread.anchorText,
      anchorFrom: parentThread.anchorFrom,
      anchorTo: parentThread.anchorTo,
      resolved: false,
      createdAt: new Date().toISOString(),
      __optimistic: true,
    };
    setThreads((prev) => prev.map((t) => (
      t.id === parentThread.id
        ? { ...t, replies: [...(t.replies || []), optimistic] }
        : t
    )));
    setReplyDrafts((d) => ({ ...d, [parentThread.id]: '' }));
    try {
      const data = await addDocComment(docId, {
        body: draft,
        anchorText: parentThread.anchorText,
        anchorFrom: parentThread.anchorFrom,
        anchorTo: parentThread.anchorTo,
        parentId: parentThread.id,
      });
      const real = data?.comment;
      if (real) {
        setThreads((prev) => prev.map((t) => (
          t.id === parentThread.id
            ? {
              ...t,
              replies: (t.replies || []).map((r) => (r.id === tempId ? real : r)),
            }
            : t
        )));
      }
      notifyChanged();
    } catch (err) {
      setThreads((prev) => prev.map((t) => (
        t.id === parentThread.id
          ? { ...t, replies: (t.replies || []).filter((r) => r.id !== tempId) }
          : t
      )));
      toast.error(getErrorMessage(err));
    }
  }, [replyDrafts, docId, currentUser, toast, notifyChanged]);

  const handleStartEdit = useCallback((comment) => {
    setEditDrafts((d) => ({ ...d, [comment.id]: comment.body }));
    setOpenMenu(null);
  }, []);

  const handleCancelEdit = useCallback((commentId) => {
    setEditDrafts((d) => {
      const next = { ...d };
      delete next[commentId];
      return next;
    });
  }, []);

  const handleSubmitEdit = useCallback(async (comment) => {
    const draft = (editDrafts[comment.id] || '').trim();
    if (!draft) return;
    try {
      const data = await updateDocComment(docId, comment.id, { body: draft });
      const real = data?.comment;
      setThreads((prev) => prev.map((t) => {
        if (t.id === comment.id && !comment.parentId) {
          return { ...t, ...real, replies: t.replies || [] };
        }
        return {
          ...t,
          replies: (t.replies || []).map((r) => (r.id === comment.id ? { ...r, ...real } : r)),
        };
      }));
      handleCancelEdit(comment.id);
      notifyChanged();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }, [editDrafts, docId, toast, handleCancelEdit, notifyChanged]);

  const handleDelete = useCallback(async (comment) => {
    setOpenMenu(null);
    // eslint-disable-next-line no-alert
    const ok = typeof window !== 'undefined' && window.confirm
      ? window.confirm('Delete this comment?')
      : true;
    if (!ok) return;
    const snapshot = threads;
    // Optimistic: drop from UI.
    setThreads((prev) => {
      if (!comment.parentId) {
        return prev.filter((t) => t.id !== comment.id);
      }
      return prev.map((t) => (
        t.id === comment.parentId
          ? { ...t, replies: (t.replies || []).filter((r) => r.id !== comment.id) }
          : t
      ));
    });
    try {
      const data = await deleteDocComment(docId, comment.id);
      // Soft-delete: server kept the row but rewrote body. Re-insert with
      // body = '[deleted]' so the thread structure stays visible.
      if (data?.mode === 'soft' && !comment.parentId) {
        setThreads((prev) => {
          // We already removed it above — restore with marker body.
          const existing = snapshot.find((t) => t.id === comment.id);
          if (!existing) return prev;
          return [{ ...existing, body: DELETED_MARKER }, ...prev];
        });
      }
      notifyChanged();
    } catch (err) {
      setThreads(snapshot);
      toast.error(getErrorMessage(err));
    }
  }, [threads, docId, toast, notifyChanged]);

  const handleResolveToggle = useCallback(async (thread) => {
    setOpenMenu(null);
    const isResolving = !thread.resolved;
    const snapshot = threads;
    // Optimistic flip.
    setThreads((prev) => prev.map((t) => (
      t.id === thread.id
        ? {
          ...t,
          resolved: isResolving,
          resolvedAt: isResolving ? new Date().toISOString() : null,
          resolvedBy: isResolving ? currentUser?.id : null,
        }
        : t
    )));
    try {
      const data = isResolving
        ? await resolveDocComment(docId, thread.id)
        : await unresolveDocComment(docId, thread.id);
      const real = data?.comment;
      if (real) {
        setThreads((prev) => prev.map((t) => (
          t.id === thread.id ? { ...t, ...real, replies: t.replies || [] } : t
        )));
      }
      notifyChanged();
    } catch (err) {
      setThreads(snapshot);
      toast.error(getErrorMessage(err));
    }
  }, [threads, docId, currentUser, toast, notifyChanged]);

  // ─── render ─────────────────────────────────────────────────────────

  return (
    <SidePanel
      open={isOpen}
      onClose={onClose}
      side="right"
      width={360}
      mode="overlay"
      ariaLabel="Doc comments"
      closeOnEscape
      closeOnOutsideClick
    >
      <div
        className="flex items-center gap-2 px-4 py-3 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <MessageSquare size={16} className="text-zinc-500" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-text-primary">Comments</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comments"
          className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100 hover:text-text-secondary transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Filter comments"
        className="px-4 py-2 flex items-center gap-1.5 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        {FILTERS.map((f) => {
          const active = filter === f;
          return (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-colors ${
                active
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : 'bg-surface-100 text-text-secondary hover:bg-surface-200'
              }`}
            >
              {f}
            </button>
          );
        })}
      </div>

      <div
        className="flex-1 overflow-y-auto px-3 py-3 space-y-3"
        data-testid="doc-comments-list"
      >
        {loading && (
          <div className="text-xs text-zinc-500 px-1">Loading comments…</div>
        )}
        {!loading && visibleThreads.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-zinc-500 leading-relaxed">
            {EMPTY_PROMPT}
          </div>
        )}
        {!loading && visibleThreads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            currentUser={currentUser}
            replyDraft={replyDrafts[thread.id] || ''}
            onReplyDraftChange={(v) => setReplyDrafts((d) => ({ ...d, [thread.id]: v }))}
            onSubmitReply={() => handleSubmitReply(thread)}
            editDrafts={editDrafts}
            setEditDrafts={setEditDrafts}
            onStartEdit={handleStartEdit}
            onCancelEdit={handleCancelEdit}
            onSubmitEdit={handleSubmitEdit}
            onDelete={handleDelete}
            onResolveToggle={handleResolveToggle}
            openMenu={openMenu}
            setOpenMenu={setOpenMenu}
          />
        ))}
      </div>

      <div
        className="flex-shrink-0 px-3 py-3 space-y-2"
        style={{
          borderTop: '1px solid var(--layout-border-color, #e2e2e2)',
          backgroundColor: 'var(--surface-50, #f8f9fb)',
        }}
      >
        {pendingAnchor?.text && (
          <div
            data-testid="pending-anchor-chip"
            className="flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-emerald-50 border border-emerald-200 text-[11px] text-emerald-800 dark:bg-emerald-900/20 dark:border-emerald-800 dark:text-emerald-200"
          >
            <Quote size={11} className="mt-0.5 flex-shrink-0" />
            <span className="line-clamp-2 italic break-words">
              “{pendingAnchor.text.slice(0, 140)}{pendingAnchor.text.length > 140 ? '…' : ''}”
            </span>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={composerRef}
            aria-label="New comment"
            rows={2}
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleSubmitTopLevel();
              }
            }}
            placeholder={pendingAnchor?.text
              ? 'Add a comment on the highlighted text…'
              : 'Highlight text in the doc first…'}
            disabled={!pendingAnchor?.text}
            className="flex-1 text-sm px-2.5 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-text-primary resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleSubmitTopLevel}
            disabled={!pendingAnchor?.text || !newBody.trim()}
            aria-label="Send comment"
            className="p-2 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </SidePanel>
  );
}

// ─── thread + reply rendering ──────────────────────────────────────────

function ThreadCard({
  thread,
  currentUser,
  replyDraft,
  onReplyDraftChange,
  onSubmitReply,
  editDrafts,
  setEditDrafts,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onDelete,
  onResolveToggle,
  openMenu,
  setOpenMenu,
}) {
  const greyed = !!thread.resolved;
  return (
    <div
      data-testid="doc-comment-thread"
      data-resolved={greyed ? 'true' : 'false'}
      className={`rounded-lg border ${
        greyed
          ? 'bg-zinc-50 dark:bg-zinc-900/60 border-zinc-200 dark:border-zinc-800 opacity-70'
          : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800'
      } shadow-sm`}
    >
      <div className="px-3 py-2.5">
        {thread.anchorText && (
          <div className="mb-2 px-2 py-1 rounded bg-zinc-50 dark:bg-zinc-800/50 border-l-2 border-emerald-400 text-[11px] text-zinc-600 dark:text-zinc-400 italic">
            “{String(thread.anchorText).slice(0, 100)}{thread.anchorText.length > 100 ? '…' : ''}”
          </div>
        )}
        <CommentRow
          comment={thread}
          currentUser={currentUser}
          editDrafts={editDrafts}
          setEditDrafts={setEditDrafts}
          onStartEdit={onStartEdit}
          onCancelEdit={onCancelEdit}
          onSubmitEdit={onSubmitEdit}
          onDelete={onDelete}
          onResolveToggle={() => onResolveToggle(thread)}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          isResolved={greyed}
        />

        {!greyed && (thread.replies || []).length > 0 && (
          <div className="mt-2 pl-3 space-y-2 border-l border-zinc-200 dark:border-zinc-800">
            {(thread.replies || []).map((reply) => (
              <CommentRow
                key={reply.id}
                comment={reply}
                currentUser={currentUser}
                editDrafts={editDrafts}
                setEditDrafts={setEditDrafts}
                onStartEdit={onStartEdit}
                onCancelEdit={onCancelEdit}
                onSubmitEdit={onSubmitEdit}
                onDelete={onDelete}
                onResolveToggle={null}
                openMenu={openMenu}
                setOpenMenu={setOpenMenu}
                isReply
              />
            ))}
          </div>
        )}

        {!greyed && (
          <div className="mt-2 flex items-end gap-1.5">
            <input
              type="text"
              aria-label="Reply"
              value={replyDraft}
              onChange={(e) => onReplyDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onSubmitReply();
                }
              }}
              placeholder="Reply…"
              className="flex-1 text-xs px-2 py-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-text-primary focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <button
              type="button"
              onClick={onSubmitReply}
              disabled={!replyDraft.trim()}
              aria-label="Send reply"
              className="p-1.5 rounded-md text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  currentUser,
  editDrafts,
  setEditDrafts,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onDelete,
  onResolveToggle,
  openMenu,
  setOpenMenu,
  isReply,
  isResolved,
}) {
  const isAuthor = currentUser?.id && comment.authorId === currentUser.id;
  const isDeleted = comment.body === DELETED_MARKER;
  const isEditing = Object.prototype.hasOwnProperty.call(editDrafts, comment.id);
  const menuOpen = openMenu === comment.id;
  return (
    <div className="flex items-start gap-2" data-testid="doc-comment-row">
      <LetterAvatar
        name={comment.author?.name || 'Unknown'}
        image={comment.author?.avatar}
        size={isReply ? 'xs' : 'sm'}
        shape="circle"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-xs font-semibold text-text-primary truncate">
            {comment.author?.name || 'Unknown user'}
          </span>
          <span className="text-[10px] text-zinc-400">
            {safeTimeAgo(comment.createdAt)}
          </span>
          {isResolved && !isReply && (
            <span
              className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600 ml-auto"
              data-testid="resolved-badge"
            >
              <CheckCircle2 size={10} /> Resolved
            </span>
          )}
        </div>
        {isEditing ? (
          <div className="space-y-1.5">
            <textarea
              aria-label="Edit comment"
              rows={2}
              value={editDrafts[comment.id] || ''}
              onChange={(e) => setEditDrafts((d) => ({ ...d, [comment.id]: e.target.value }))}
              className="w-full text-xs px-2 py-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-text-primary resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onSubmitEdit(comment)}
                className="text-[10px] px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => onCancelEdit(comment.id)}
                className="text-[10px] px-2 py-0.5 rounded text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            className={`text-xs leading-relaxed ${
              isDeleted ? 'italic text-zinc-400' : 'text-text-primary'
            } whitespace-pre-wrap break-words`}
          >
            {comment.body}
          </div>
        )}
      </div>
      {!isDeleted && (isAuthor || onResolveToggle) && (
        <div className="relative flex-shrink-0">
          <button
            type="button"
            aria-label="Comment actions"
            onClick={() => setOpenMenu(menuOpen ? null : comment.id)}
            className="p-1 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-7 z-10 min-w-[140px] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1 text-xs"
            >
              {isAuthor && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => onStartEdit(comment)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-text-primary"
                >
                  <Edit3 size={11} /> Edit
                </button>
              )}
              {isAuthor && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => onDelete(comment)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-red-600"
                >
                  <Trash2 size={11} /> Delete
                </button>
              )}
              {onResolveToggle && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={onResolveToggle}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-text-primary"
                >
                  {isResolved ? <Undo2 size={11} /> : <Check size={11} />}
                  {isResolved ? 'Reopen' : 'Resolve'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
