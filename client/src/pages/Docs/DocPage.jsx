import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Archive, RotateCcw,
  Sparkles, Check, AlertCircle, Loader2, History, MessageSquare, Save,
} from 'lucide-react'; // History + MessageSquare — Phase F + H header buttons. Save — May 2026 manual-save button.
import { AnimatePresence, motion } from 'framer-motion';
import api from '../../services/api';
import {
  getDoc, archiveDoc as archiveDocApi, restoreDoc as restoreDocApi,
  listMentionableUsers, listSearchableTasks, listDocComments,
  // Phase G follow-up — owner-only migration of an existing doc to Y.js.
  migrateDocToCollab,
} from '../../services/docsService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../components/common/Toast';
import EmptyState from '../../components/common/EmptyState';
import LetterAvatar from '../../components/common/LetterAvatar';
// Phase A made this editor real. Phase B uses it as the doc body.
import RichTextEditor from '../../components/common/RichTextEditor';
import SidekickPanel from '../../components/sidekick/SidekickPanel';
import { formatDistanceToNow } from 'date-fns';
import useDocAutosave from './useDocAutosave';
// Phase G — real-time collab session (Y.js + Hocuspocus). Gates HTTP
// autosave: when collab is connected, Y.js owns persistence and we
// disable useDocAutosave's debounced body-save path.
import useDocCollab, { pickColor } from './useDocCollab';
// Phase H polish — image drag-paste upload helper.
import { uploadInlineImage } from '../../services/uploadService';
// Phase D Slice 2b — create-task-from-doc modal + realtime chip refresh.
import NewTaskFromDocModal from './NewTaskFromDocModal';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';
// May 2026 — Doc/Board/Task Summarize all use the shared AISummaryModal
// (portal-centered, backdrop, visible loader). Replaces the inline
// AISummaryPopover that proved invisible in some user environments.
import aiSummary from '../../services/aiSummaryService';
import AISummaryModal from '../../components/sidekick/AISummaryModal';
// Phase F — side-panel comments anchored to selection.
import DocCommentsSidebar from '../../components/common/DocCommentsSidebar';
// Phase H — version history modal + share dropdown (replaces the
// old copy-URL-only Share button).
import DocVersionHistoryModal from './DocVersionHistoryModal';
import DocShareDropdown from './DocShareDropdown';

/**
 * DocPage — collaborative document viewer/editor (Doc Editor Phase B).
 *
 * Route: `/workspaces/:workspaceId/docs/:docId`
 *
 * Layout:
 *   - Sticky header: title (inline-edit), save indicator, AI button, share, ⋯
 *   - Centered 720px content column with RichTextEditor body
 *
 * Autosave:
 *   - Body edits → debounced 1.2s via useDocAutosave
 *   - Title rename → immediate flush (saves on blur or Enter)
 *
 * Real-time collab (Y.js) lands in Phase G — for now the page is single-user
 * HTTP autosave. Two tabs editing the same doc will fight each other (last
 * write wins); this is acceptable for the foundation slice.
 */

export default function DocPage() {
  const { workspaceId, docId } = useParams();
  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const toast = useToast();

  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [bodyDraft, setBodyDraft] = useState(''); // HTML body
  const [showSidekick, setShowSidekick] = useState(false);
  const initialLoadedRef = useRef(false);
  // Phase D Slice 2b — editor ref (for live chip-status updates) + new-task modal state.
  const editorRef = useRef(null);
  const [newTaskState, setNewTaskState] = useState(null); // { query, insertChip }
  // May 2026 — DocSummaryModal visibility + a "preparing" flag for the
  // trigger button. The "preparing" flag is true between the click and
  // the modal opening, so the trigger immediately shows a spinner even
  // if the modal's portal takes a frame to mount.
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [preparingSummary, setPreparingSummary] = useState(false);
  // Phase F — comments sidebar visibility + the selection captured at the
  // moment the user clicked the "Comment" bubble pill. Passed to the
  // sidebar as `pendingAnchor` so the composer can pre-fill the quoted
  // snippet and the comment row anchors back to the right text range.
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [pendingCommentAnchor, setPendingCommentAnchor] = useState(null);
  // Phase H — version history modal visibility. Loads versions on demand.
  const [versionsOpen, setVersionsOpen] = useState(false);
  // Phase F polish — list of {commentId, anchorText} so the editor can
  // re-apply CommentMark highlights. Refreshes on doc load + whenever the
  // sidebar dispatches `doc-comments-changed` (after add/edit/delete/resolve).
  const [commentMarks, setCommentMarks] = useState([]);

  // "Owner" is the strict role used to gate destructive UI (archive /
  // restore / rename). Anyone who can READ a doc passed the workspace
  // visibility gate server-side, so we trust them to also write the body —
  // matches the Notion-style collab default we now enforce on the backend.
  const isOwner = useMemo(() => {
    if (!doc || !user) return false;
    return isSuperAdmin || doc.createdBy === user.id || user.role === 'admin' || user.role === 'manager';
  }, [doc, user, isSuperAdmin]);

  // canEdit is the looser gate for body writes — true for any caller who
  // successfully loaded the doc and the doc isn't archived. (If the load
  // failed, we don't render the editor at all.)
  const canEdit = !!doc && !doc.isArchived;

  // Phase D Slice 1 — pass a stable `mentions.suggest` to RichTextEditor.
  // The function calls /api/docs/mentionable scoped to this doc's
  // workspace. We memoize the wrapper so RichTextEditor's extension array
  // stays stable across renders (which keeps the Tiptap editor instance
  // alive instead of remounting on every keystroke-driven re-render).
  const mentionsConfig = useMemo(() => {
    if (!workspaceId) return null;
    return {
      suggest: async (query) => {
        try {
          const { users } = await listMentionableUsers(workspaceId, { q: query });
          return Array.isArray(users) ? users : [];
        } catch (err) {
          safeLog.warn('[DocPage] mentionable users fetch failed', err);
          return [];
        }
      },
    };
  }, [workspaceId]);

  // Phase D Slice 2 — task-chip support. Symmetrical to mentionsConfig —
  // memoized so the editor extension list stays stable. Backend caps at
  // 25 results per query.
  // Slice 2b adds `onCreateNew`: when the picker's footer row is chosen,
  // the suggestion plugin clears the typed range and hands us a
  // continuation (`insertChip(task)`). We stash both in state to open the
  // NewTaskFromDocModal, then call the continuation after the create
  // succeeds.
  const tasksConfig = useMemo(() => {
    if (!workspaceId) return null;
    return {
      suggest: async (query) => {
        try {
          const { tasks } = await listSearchableTasks(workspaceId, { q: query });
          return Array.isArray(tasks) ? tasks : [];
        } catch (err) {
          safeLog.warn('[DocPage] searchable tasks fetch failed', err);
          return [];
        }
      },
      onCreateNew: ({ query, insertChip }) => {
        setNewTaskState({ query: query || '', insertChip });
      },
    };
  }, [workspaceId]);

  // Phase E — inline AI transform on selected text. Memoized so the
  // RichTextEditor extension list reference stays stable.
  const aiConfig = useMemo(() => ({
    onTransform: async ({ mode, text }) => {
      const result = await aiSummary.transformInline({ mode, text });
      return { output: result?.output || '' };
    },
  }), []);

  // Phase H polish — paste / drop image upload. Memoized for editor
  // extension-list stability. Errors surface as a toast; the placeholder
  // is auto-removed by the extension on failure.
  const imagesConfig = useMemo(() => ({
    uploadFn: async (file) => {
      const { url } = await uploadInlineImage(file);
      return { url };
    },
    onError: (err) => {
      const msg = err?.message || 'Image upload failed';
      try { toast.error(msg); } catch { /* no-op */ }
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // Phase F — bubble menu "Comment" pill + Phase-F-polish marked ranges.
  // Both flows share the same `comments` prop on RichTextEditor so the
  // extension list stays stable across updates.
  const commentsConfig = useMemo(() => ({
    onStartComment: ({ text, from, to }) => {
      setPendingCommentAnchor({ text, from, to });
      setCommentsOpen(true);
    },
    markedRanges: commentMarks,
  }), [commentMarks]);

  // Fetch the doc's comments once per docId so we can render anchor
  // highlights. Also auto-refresh on a sidebar-dispatched event so
  // creates/deletes/resolves stay in sync without prop drilling.
  const loadCommentMarks = useCallback(async () => {
    if (!docId) return;
    try {
      const data = await listDocComments(docId);
      const threads = Array.isArray(data?.threads) ? data.threads : [];
      // Only top-level comments anchor; replies inherit their parent's anchor.
      const ranges = threads
        .filter((t) => !t.resolved && t.anchorText)
        .map((t) => ({ commentId: t.id, anchorText: t.anchorText }));
      setCommentMarks(ranges);
    } catch (err) {
      // Silent — marks are a polish layer; failure shouldn't surface as a toast.
      safeLog.warn('[DocPage] loadCommentMarks failed', err);
    }
  }, [docId]);
  useEffect(() => { loadCommentMarks(); }, [loadCommentMarks]);
  useEffect(() => {
    const h = () => loadCommentMarks();
    window.addEventListener('doc-comments-changed', h);
    return () => window.removeEventListener('doc-comments-changed', h);
  }, [loadCommentMarks]);
  // Phase F polish v2 — peer comment mutations propagate via the
  // `doc:comments:changed` realtime event. Server-side fan-out targets
  // workspace member user rooms; we filter by docId so a comment landing
  // on a different doc doesn't trigger an unnecessary refetch here.
  useRealtimeEvent('doc:comments:changed', useCallback((payload) => {
    if (payload?.docId === docId) loadCommentMarks();
  }, [docId, loadCommentMarks]));

  // Phase D Slice 2b — live chip status sync.
  // When a task linked from this doc is updated anywhere (status change,
  // rename), we walk the live editor's ProseMirror doc, find every
  // `taskChip` node referencing the updated taskId, and patch its attrs
  // in place via a single transaction. No re-fetch, no autosave thrash —
  // the chip just visually catches up.
  const applyTaskChipUpdate = useCallback((task) => {
    const editor = editorRef.current?.getEditor?.();
    if (!editor || !task?.id) return;
    const { state, view } = editor;
    if (!state || !view) return;
    let tr = state.tr;
    let touched = false;
    state.doc.descendants((node, pos) => {
      if (node.type?.name === 'taskChip' && node.attrs?.taskId === task.id) {
        tr = tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          label: task.title || node.attrs.label,
          status: task.status || node.attrs.status,
        });
        touched = true;
      }
      return true;
    });
    if (touched) {
      // setMeta('addToHistory', false) so the patch doesn't sit on the
      // undo stack — it's an external event, not a user edit.
      tr.setMeta('addToHistory', false);
      view.dispatch(tr);
    }
  }, []);

  useRealtimeEvent('task:updated', (payload) => {
    const t = payload?.task || payload;
    applyTaskChipUpdate(t);
  });

  // Phase G — open the collab session once the doc has loaded and the
  // user is allowed to edit. The hook handles its own retry/teardown
  // lifecycle; `currentUser` carries the awareness identity so peers
  // see "Sara: |" instead of a faceless cursor. The pickColor helper
  // deterministically maps user.id → palette entry so the same person
  // always gets the same cursor color.
  const collab = useDocCollab({
    docId: doc?.id,
    enabled: !!doc && !doc.isArchived,
    currentUser: user
      ? { id: user.id, name: user.name, color: pickColor(user.id) }
      : null,
  });
  // "In collab" = the WS is healthy AND no fatal error (e.g. doc not
  // migrated). When this flag is true, the editor mounts in CRDT mode
  // and HTTP autosave for body content is disabled.
  const inCollab = collab.status === 'connected' && !collab.error;

  // Track the last error toast we surfaced so we don't spam the user with
  // identical messages while their network is degraded. Reset on successful
  // save.
  const lastSaveErrorRef = useRef('');

  // May 2026 — HTTP autosave runs ALONGSIDE Y.js collab.
  //
  // Why: the Hocuspocus server's `onStoreDocument` only persists `yjsState`
  // (binary CRDT bytes). It NEVER updates the doc's `contentJson` or
  // `contentText` columns because that would require running a Tiptap
  // schema server-side. Without an HTTP shadow-save:
  //   - DocsListPage excerpts are blank (reads `contentText`)
  //   - AI Sidekick gets empty doc context (reads `contentJson`)
  //   - Any non-collab reader sees a blank doc
  //
  // Both writers touch DIFFERENT columns (yjsState vs contentJson), so
  // they don't fight. We slow the debounce to 2.5s in collab mode to
  // dampen network thrash when multiple peers are typing — Y.js still
  // carries the live sync, the HTTP path is just the canonical-JSON
  // snapshot.
  const { status, lastSavedAt, error: saveError, scheduleSave, flush } = useDocAutosave({
    docId,
    debounceMs: inCollab ? 2500 : 1200,
    enabled: true,
    onSaved: (updated) => {
      // Server returned the canonical doc — merge it but don't overwrite
      // the body the user is actively typing.
      setDoc((prev) => (prev ? { ...prev, ...updated, contentJson: prev.contentJson } : updated));
      // Clear the error-dedup memo on the next clean save so a future
      // failure surfaces a fresh toast (the issue likely changed).
      lastSaveErrorRef.current = '';
    },
    onError: (msg) => {
      // Surface persistent autosave failures as a toast — the SaveIndicator's
      // "Save failed" pill is easy to miss in a long writing session.
      // Dedup so a long network outage doesn't queue 50 toasts.
      if (msg && msg !== lastSaveErrorRef.current) {
        lastSaveErrorRef.current = msg;
        try { toast.error(`Couldn't save your doc: ${msg}`); } catch (_) { /* no-op */ }
      }
    },
  });

  // Manual save handler. Used by Ctrl+S and the explicit "Save" button.
  // Always triggers an HTTP flush — even in collab mode — because the
  // HTTP path is what persists `contentJson` / `contentText` (Y.js only
  // persists the binary `yjsState`).
  const handleManualSave = useCallback(async () => {
    if (!docId) return;
    if (doc?.isArchived) {
      try { toast.info('This doc is archived. Restore it to save edits.'); } catch (_) { /* no-op */ }
      return;
    }
    try {
      await flush();
      try { toast.success('Saved'); } catch (_) { /* no-op */ }
    } catch (err) {
      safeLog.error('[DocPage] manual save failed', err);
      const msg = getErrorMessage(err);
      try { toast.error(`Couldn't save: ${msg}`); } catch (_) { /* no-op */ }
    }
  }, [docId, doc?.isArchived, flush, toast]);

  // Ctrl+S / Cmd+S inside the doc editor saves the doc, NOT the browser's
  // "save page as HTML" dialog. Window-capture listener so we beat the
  // browser shortcut even when focus is inside the ProseMirror editor.
  // Scoped to DocPage — cleanup on unmount restores default shortcuts
  // everywhere else.
  useEffect(() => {
    if (!docId) return undefined;
    function onKeyDown(e) {
      // Match both `s` and `S` so Shift+Ctrl+S doesn't slip through (would
      // hit browser "Save as", which is the same UX failure).
      const isS = e.key === 's' || e.key === 'S';
      if (!isS) return;
      const isModified = e.ctrlKey || e.metaKey;
      if (!isModified) return;
      e.preventDefault();
      e.stopPropagation();
      handleManualSave();
    }
    // Capture phase so we run before the browser/Chromium's native handler.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [docId, handleManualSave]);

  // Load doc on mount + when docId changes.
  useEffect(() => {
    if (!docId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    initialLoadedRef.current = false;
    getDoc(docId)
      .then(({ doc: loaded }) => {
        if (cancelled) return;
        setDoc(loaded);
        setTitleDraft(loaded?.title || '');
        setBodyDraft(tiptapJsonToHtml(loaded?.contentJson));
        initialLoadedRef.current = true;
      })
      .catch((err) => {
        if (cancelled) return;
        safeLog.error('[DocPage] load error', err);
        setError(getErrorMessage(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [docId]);

  // Title commit (on blur or Enter).
  const commitTitle = useCallback(async () => {
    if (!editingTitle) return;
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === doc?.title) {
      setTitleDraft(doc?.title || '');
      return;
    }
    try {
      await flush({ title: trimmed });
      setDoc((d) => (d ? { ...d, title: trimmed } : d));
      toast.success('Renamed');
    } catch (err) {
      setTitleDraft(doc?.title || '');
      toast.error(getErrorMessage(err));
    }
  }, [editingTitle, titleDraft, doc?.title, flush, toast]);

  // Body edits → schedule autosave with the lossless Tiptap JSON. The
  // backend stores contentJson (Tiptap's source of truth). We prefer the
  // live editor's JSON passed as onUpdate's 2nd arg over re-parsing the
  // HTML — re-parsing through a StarterKit-only temp editor strips any
  // custom node types (mentions, task chips). The htmlToTiptapJson
  // fallback only fires when the live JSON isn't available.
  const handleBodyChange = useCallback((html, contentJsonFromEditor) => {
    if (!initialLoadedRef.current) return; // ignore the first synthetic update
    setBodyDraft(html);
    const contentJson = contentJsonFromEditor || htmlToTiptapJson(html);
    scheduleSave({ contentJson });
  }, [scheduleSave]);

  async function handleArchive() {
    if (!doc?.id) return;
    const ok = window.confirm(`Archive "${doc.title}"? You can restore it from the workspace archive later.`);
    if (!ok) return;
    try {
      await archiveDocApi(doc.id);
      toast.success('Doc archived');
      navigate(`/workspaces/${workspaceId}/docs`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function handleUnarchive() {
    if (!doc?.id) return;
    try {
      const { doc: updated } = await restoreDocApi(doc.id);
      setDoc((d) => ({ ...d, ...updated }));
      toast.success('Doc restored');
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  // handleShareCopy removed in Phase H — replaced by DocShareDropdown
  // which handles copy-link as part of the public_link mode.

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="h-7 w-56 bg-surface-100 rounded animate-pulse mb-2" />
        <div className="h-3 w-48 bg-surface-100 rounded animate-pulse mb-8" />
        <div className="h-4 w-full bg-surface-100 rounded animate-pulse mb-2" />
        <div className="h-4 w-5/6 bg-surface-100 rounded animate-pulse mb-2" />
        <div className="h-4 w-2/3 bg-surface-100 rounded animate-pulse" />
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load this doc"
          description={error || 'The doc may have been archived or you may not have access.'}
          primaryAction={{ label: 'Back to docs', onClick: () => navigate(`/workspaces/${workspaceId}/docs`) }}
        />
      </div>
    );
  }

  const titleDisplay = (
    <h1
      className="text-2xl font-bold text-text-primary hover:bg-surface-50 rounded px-1 -ml-1 cursor-text"
      onClick={() => isOwner && setEditingTitle(true)}
      title={isOwner ? 'Click to rename' : doc.title}
    >
      {doc.title || 'Untitled doc'}
    </h1>
  );

  const titleEditor = (
    <input
      autoFocus
      value={titleDraft}
      onChange={(e) => setTitleDraft(e.target.value)}
      onBlur={commitTitle}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitTitle(); }
        if (e.key === 'Escape') { setEditingTitle(false); setTitleDraft(doc?.title || ''); }
      }}
      maxLength={300}
      className="text-2xl font-bold text-text-primary bg-transparent border-b-2 border-primary outline-none w-full"
    />
  );

  return (
    <div className="flex flex-col h-full">
      {/* Sticky header */}
      <header
        className="flex items-center gap-2 px-6 py-3 bg-surface flex-shrink-0"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <button
          type="button"
          onClick={() => navigate(`/workspaces/${workspaceId}/docs`)}
          aria-label="Back to docs"
          className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100 hover:text-text-secondary"
        >
          <ArrowLeft size={16} />
        </button>
        <span
          className="w-7 h-7 rounded-md inline-flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(87, 155, 252, 0.15)', color: '#579bfc' }}
        >
          <FileText size={13} />
        </span>

        <SaveIndicator status={status} lastSavedAt={lastSavedAt} error={saveError} />
        <CollabStatusPill
          status={collab.status}
          peerCount={collab.peerCount}
          error={collab.error}
        />
        {/* Phase G follow-up — owner-only "Migrate to collab" affordance.
            Only shown when collab actually failed BECAUSE the server said
            the doc isn't migrated (so we don't surface it on transient
            network errors). One-click action with a confirm dialog;
            on success we hard-reload the page so the useDocCollab hook
            re-handshakes against the fresh yjsState. */}
        {isOwner && collab.error && collab.error._collabMigrationMissing && (
          <MigrateToCollabButton docId={doc.id} />
        )}

        <div className="ml-auto flex items-center gap-1">
          {/* Slice 2d — one-shot Summarize. Sits next to "Ask AI" because
              both surface the AI tier but for very different intents:
              Summarize is one click → one paragraph + bullets; Ask AI is
              the multi-turn Sidekick panel.

              May 2026: moved off AISummaryPopover (invisible in some
              browsers) onto a dedicated centered DocSummaryModal. The
              trigger shows its own spinner the instant it's clicked so
              the user has immediate feedback even before the modal
              mounts. */}
          <button
            type="button"
            onClick={async () => {
              if (preparingSummary || summaryOpen) return;
              setPreparingSummary(true);
              try {
                // Flush pending edits FIRST so the AI reads the body the
                // user actually sees on screen (race with 1.2-2.5s autosave
                // debounce otherwise — summary of an empty doc).
                try { await flush(); } catch (_) { /* non-fatal */ }
                setSummaryOpen(true);
              } finally {
                setPreparingSummary(false);
              }
            }}
            disabled={preparingSummary}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 transition-colors disabled:opacity-70 disabled:cursor-wait"
            title="Summarize this doc"
          >
            {preparingSummary ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Preparing…
              </>
            ) : (
              <>
                <Sparkles size={13} /> Summarize
              </>
            )}
          </button>
          <button
            type="button"
            onClick={async () => {
              // Same rationale as Summarize: ensure the AI Sidekick reads
              // the latest doc body, not what was on disk 2 seconds ago.
              try { await flush(); } catch (_) { /* non-fatal */ }
              setShowSidekick(true);
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/10 transition-colors"
            title="Ask AI about this doc"
          >
            <Sparkles size={13} /> Ask AI
          </button>
          {/* May 2026 — explicit manual save. Autosave handles the common
              path, but the button gives users a definitive "save now"
              affordance and matches the Ctrl+S keyboard shortcut. The
              button stays enabled in collab mode (HTTP path persists
              contentJson; Y.js only persists yjsState). Disabled while a
              save is mid-flight to avoid double-clicks. */}
          {canEdit && (
            <button
              type="button"
              onClick={handleManualSave}
              disabled={status === 'saving'}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium text-text-secondary border border-border bg-surface hover:border-primary-300 hover:text-primary disabled:opacity-50 disabled:cursor-wait"
              title="Save now (Ctrl/Cmd + S)"
            >
              {status === 'saving' ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> Saving…
                </>
              ) : (
                <>
                  <Save size={12} /> Save
                </>
              )}
            </button>
          )}
          {/* Phase F — open comments side panel. Clears any stale
              pending-anchor; user is browsing thread list, not commenting
              on a specific selection. */}
          <button
            type="button"
            onClick={() => { setPendingCommentAnchor(null); setCommentsOpen(true); }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium text-text-secondary border border-border bg-surface hover:border-primary-300 hover:text-primary"
            title="Open comments"
          >
            <MessageSquare size={13} /> Comments
          </button>
          {/* Phase H — version history modal. Disabled-styled while
              loading since the modal does its own fetch on open. */}
          <button
            type="button"
            onClick={() => setVersionsOpen(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium text-text-secondary border border-border bg-surface hover:border-primary-300 hover:text-primary"
            title="Version history"
          >
            <History size={13} /> History
          </button>
          {/* Phase H — share dropdown replaces the old copy-URL button.
              Surfaces all three sharePolicy options + copy-link for
              public_link. Stays read-only for non-editors. */}
          <DocShareDropdown
            docId={doc.id}
            currentSharePolicy={doc.sharePolicy || 'workspace'}
            canEdit={isOwner}
            onChanged={(next) => setDoc((d) => (d ? { ...d, sharePolicy: next } : d))}
          />
          {isOwner && !doc.isArchived && (
            <button
              type="button"
              onClick={handleArchive}
              aria-label="Archive doc"
              className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100"
              title="Archive doc"
            >
              <Archive size={14} />
            </button>
          )}
          {isOwner && doc.isArchived && (
            <button
              type="button"
              onClick={handleUnarchive}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-medium text-primary border border-primary-200 bg-primary-50 hover:bg-primary-100"
              title="Restore doc"
            >
              <RotateCcw size={12} /> Restore
            </button>
          )}
        </div>
      </header>

      {/* Centered 720px column */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto px-6 pt-8 pb-24">
          <div className="mb-4">
            {editingTitle && isOwner ? titleEditor : titleDisplay}
            <div className="mt-2 flex items-center gap-2 text-xs text-text-tertiary">
              {doc.creator && (
                <span className="inline-flex items-center gap-1.5">
                  <LetterAvatar name={doc.creator.name} size="xs" shape="circle" />
                  Created by {doc.creator.name}
                </span>
              )}
              {doc.lastEditedAt && (
                <>
                  <span>·</span>
                  <span>Edited {formatDistanceToNow(new Date(doc.lastEditedAt), { addSuffix: true })}</span>
                </>
              )}
              {doc.isArchived && (
                <>
                  <span>·</span>
                  <span className="text-amber-600 font-semibold">Archived</span>
                </>
              )}
            </div>
          </div>

          {/* Phase D Slice 2c — persistent hint that surfaces the doc's
              three power-features. Users who don't know about the trigger
              chars now see them every time they open a doc. */}
          {canEdit && (
            <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-text-tertiary">
              <span className="inline-flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-surface-100 border border-border text-[10px] font-mono">/</kbd>
                blocks
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-surface-100 border border-border text-[10px] font-mono">@</kbd>
                mention a teammate
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-surface-100 border border-border text-[10px] font-mono">+</kbd>
                link or create a task
              </span>
            </div>
          )}
          {/* Phase D Slice 2c — delegated click handler. When the user
              clicks a task chip we look up the chip's data-task-id +
              data-board-id and navigate to /boards/<board>?taskId=<id>,
              which BoardPage already deep-links to TaskModal. Holding
              Ctrl/Cmd opens in a new tab. */}
          <div
            className="rich-doc-body"
            onClick={(e) => {
              // Phase F polish — clicking a highlighted (commented) range
              // opens the comments sidebar. Takes priority over other
              // affordances because the mark may overlap with text the
              // user wants to edit; the click intent here is "show me the
              // thread", not "place a caret here".
              const mark = e.target?.closest?.('.comment-mark[data-comment-id]');
              if (mark) {
                e.preventDefault();
                setPendingCommentAnchor(null);
                setCommentsOpen(true);
                return;
              }
              // Chip-click navigation (Slice 2c).
              const chip = e.target?.closest?.('.task-chip[data-task-id]');
              if (chip) {
                const taskId = chip.getAttribute('data-task-id');
                const boardId = chip.getAttribute('data-board-id');
                if (taskId && boardId) {
                  e.preventDefault();
                  const url = `/boards/${boardId}?taskId=${taskId}`;
                  if (e.ctrlKey || e.metaKey) {
                    window.open(url, '_blank', 'noopener');
                  } else {
                    navigate(url);
                  }
                  return;
                }
              }
              // Click landed in the empty area below the last paragraph
              // (cursor never lands on the ProseMirror node because that
              // node is only as tall as the content). Focus the editor at
              // the end so the user can just keep typing.
              const inEditor = e.target?.closest?.('.ProseMirror');
              if (!inEditor && editorRef.current?.focus) {
                editorRef.current.focus();
              }
            }}
          >
            <RichTextEditor
              ref={editorRef}
              // Phase G — when collab is active, Y.js owns content. We
              // intentionally still pass the cached HTML for non-collab
              // mode (single-user fallback) so initial-render text shows
              // immediately; RichTextEditor ignores `value` when its
              // `collab` prop is set.
              value={bodyDraft}
              onUpdate={handleBodyChange}
              disabled={!canEdit}
              placeholder="Start writing… Type / for blocks, @ to mention a teammate, + to link a task."
              minHeight={500}
              // Slice 2c — chromeless wrapper for Notion-style writing.
              bordered={false}
              // Phase D Slice 1 — workspace-scoped @-mentions. The
              // RichTextEditor extension list adapts to the presence of
              // this prop; pass null / undefined to disable mentions.
              mentions={mentionsConfig}
              // Phase D Slice 2 — workspace-scoped task chips, triggered
              // by `+`. Same opt-in pattern as mentions.
              tasks={tasksConfig}
              // Phase E — inline AI on selection. Bubble menu gains an
              // "AI" pill; clicking it opens the action menu.
              ai={aiConfig}
              // Phase F — bubble menu gains a "💬 Comment" pill that
              // hands the live selection back to DocPage so the
              // comments sidebar opens with the snippet pre-quoted.
              comments={commentsConfig}
              // Phase G — real-time collab. Mounted only when the
              // provider is fully connected; until then the editor
              // works in single-user mode against `value` + HTTP
              // autosave so users never see a broken editor while the
              // WS is mid-handshake.
              collab={inCollab && user ? {
                ydoc: collab.ydoc,
                provider: collab.provider,
                currentUser: { name: user.name, color: pickColor(user.id) },
              } : null}
              // Phase H polish — drag/paste an image; uploads to
              // /api/files/upload-general and inserts at drop position.
              images={imagesConfig}
            />
          </div>
        </div>
      </div>

      <SidekickPanel
        isOpen={showSidekick}
        onClose={() => setShowSidekick(false)}
        scope="doc"
        scopeId={doc.id}
        scopeLabel="this doc"
        pageContext={`Doc: ${doc.title}`}
        pageState={{ route: `/workspaces/${workspaceId}/docs/${doc.id}`, docId: doc.id }}
      />

      {/* Phase D Slice 2b — create task right from the doc. The TaskChip
          suggestion plugin handed us the `insertChip` continuation pointing
          at the saved cursor range; we fire it once the task is created. */}
      <NewTaskFromDocModal
        isOpen={!!newTaskState}
        workspaceId={workspaceId}
        initialTitle={newTaskState?.query || ''}
        onSubmit={(task) => {
          try { newTaskState?.insertChip?.(task); } catch { /* no-op */ }
          toast.success('Task created');
        }}
        onClose={() => setNewTaskState(null)}
      />

      {/* Phase F — comments side panel. `pendingCommentAnchor` is set by
          the bubble's Comment pill; the composer is gated on it being
          non-empty so users never leave unanchored comments. */}
      <DocCommentsSidebar
        isOpen={commentsOpen}
        onClose={() => { setCommentsOpen(false); setPendingCommentAnchor(null); }}
        docId={doc.id}
        currentUser={user}
        pendingAnchor={pendingCommentAnchor}
        // Phase F polish — refresh inline highlight marks any time the
        // sidebar mutates a comment (add / reply / edit / delete / resolve).
        onChanged={loadCommentMarks}
      />

      {/* Phase H — version history. Restoring a version creates a new
          snapshot server-side and replaces the live doc; we reload to
          pick up the restored contentJson. */}
      <DocVersionHistoryModal
        isOpen={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        docId={doc.id}
        currentDocTitle={doc.title}
        onRestored={() => {
          // Force a fresh load so the editor re-mounts with the restored
          // body. Simpler than splicing the response into local state —
          // the editor's setContent path is the canonical refresh.
          setVersionsOpen(false);
          initialLoadedRef.current = false;
          setLoading(true);
          getDoc(doc.id).then(({ doc: reloaded }) => {
            setDoc(reloaded);
            setBodyDraft(tiptapJsonToHtml(reloaded?.contentJson));
            initialLoadedRef.current = true;
          }).catch((err) => {
            safeLog.error('[DocPage] reload after restore failed', err);
            toast.error(getErrorMessage(err));
          }).finally(() => setLoading(false));
        }}
      />

      {/* May 2026 — centered Summarize modal. Replaces the prior
          AISummaryPopover which proved invisible in some user
          environments. The trigger above flushes pending edits before
          opening so the AI reads the current doc body. */}
      <AISummaryModal
        isOpen={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        title="Doc summary"
        subtitle={doc.title}
        run={() => aiSummary.summarizeDoc(doc.id)}
      />
    </div>
  );
}

/**
 * Phase G — small presence/health pill that sits next to SaveIndicator.
 * Three visual states:
 *   🟢 "N editing" — provider connected; renders peerCount (excludes self)
 *   🟡 "Connecting…" — initial handshake or reconnect in flight
 *   🔴 "Solo mode (autosave)" — collab failed; HTTP autosave is owning
 *      persistence. Hovering shows the underlying error.
 *
 * We render nothing in 'idle' / 'disabled' states so archived or
 * read-only docs don't surface noise.
 */
function CollabStatusPill({ status, peerCount, error }) {
  if (error) {
    const isMigrationMissing = !!error._collabMigrationMissing;
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-600 ml-2"
        title={isMigrationMissing
          ? 'This doc has not been migrated for real-time collab yet. Your changes are still being saved via HTTP autosave.'
          : error.message || 'Collab unavailable'}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500" />
        Solo mode (autosave)
      </span>
    );
  }
  if (status === 'connecting') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-600 ml-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
        Connecting…
      </span>
    );
  }
  if (status === 'connected') {
    // peerCount = OTHER editors (we subtracted self in the hook). Render
    // a friendlier copy when it's only us — connected doesn't necessarily
    // mean somebody else is in the doc.
    const label = peerCount > 0
      ? `${peerCount + 1} editing`
      : 'Live';
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 ml-2"
        title={peerCount > 0
          ? `${peerCount} other ${peerCount === 1 ? 'person is' : 'people are'} editing this doc`
          : 'Real-time collab is active. Your edits sync immediately.'}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
        {label}
      </span>
    );
  }
  return null;
}

/**
 * Phase G follow-up — owner-only "Migrate to collab" affordance shown
 * when the server refused the Y.js handshake because the doc was created
 * pre-Phase-G and has non-trivial contentJson. One click:
 *   1. confirm
 *   2. POST /api/docs/:id/migrate-to-collab (server snapshots + resets yjsState)
 *   3. hard-reload the page so useDocCollab re-handshakes against the
 *      fresh yjsState. Reload is acceptable here because (a) it's a
 *      rare admin action, and (b) the user's current local edits in
 *      Solo mode have already been autosaved by useDocAutosave.
 */
function MigrateToCollabButton({ docId }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    if (busy) return;
    // eslint-disable-next-line no-alert
    const ok = typeof window !== 'undefined' && window.confirm
      ? window.confirm(
        'Migrate this doc to real-time collaboration?\n\n'
        + 'A snapshot of the current content will be saved to version '
        + 'history first, then the doc resets to a clean canvas. You can '
        + 'restore the snapshot from the History menu afterwards.',
      )
      : true;
    if (!ok) return;
    setBusy(true);
    try {
      await migrateDocToCollab(docId);
      // Full reload so the collab hook re-handshakes; simpler than
      // tearing down + rebuilding the provider in-place for an admin
      // one-shot action.
      window.location.reload();
    } catch (err) {
      safeLog.error('[DocPage] migrate failed', err);
      // eslint-disable-next-line no-alert
      window.alert(getErrorMessage(err));
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold text-white bg-primary hover:bg-primary-600 disabled:opacity-60 disabled:cursor-wait"
      title="Snapshot current content then enable real-time collab"
    >
      {busy ? 'Migrating…' : 'Migrate to collab'}
    </button>
  );
}

function SaveIndicator({ status, lastSavedAt, error }) {
  // Build the current content + a stable key per state so AnimatePresence
  // can crossfade between the four states (saving / dirty / error / saved).
  // Without this the previous indicator vanishes instantly and the next
  // one appears, which feels jumpy — the user explicitly called the doc
  // editor's UI "very static".
  let key = 'idle';
  let content = null;
  if (status === 'saving') {
    key = 'saving';
    content = (
      <>
        <Loader2 size={11} className="animate-spin" />
        Saving…
      </>
    );
  } else if (status === 'dirty') {
    key = 'dirty';
    content = <>Unsaved changes…</>;
  } else if (status === 'error') {
    key = 'error';
    content = (
      <>
        <AlertCircle size={11} />
        Save failed
      </>
    );
  } else if (status === 'saved' && lastSavedAt) {
    key = 'saved';
    content = (
      <>
        <Check size={11} className="text-success" />
        Saved {formatDistanceToNow(lastSavedAt, { addSuffix: true })}
      </>
    );
  } else {
    key = 'autosaved';
    content = (
      <>
        <Check size={11} className="text-success" />
        Autosaved
      </>
    );
  }

  const isError = status === 'error';
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${isError ? 'text-danger' : 'text-text-tertiary'}`}
      title={isError ? error : 'This doc autosaves every keystroke'}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={key}
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 2 }}
          transition={{ duration: 0.15 }}
          className="inline-flex items-center gap-1.5"
        >
          {content}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

// ─── Tiptap JSON ↔ HTML bridge ──────────────────────────────────
//
// The backend stores contentJson (Tiptap's JSON envelope). RichTextEditor
// works in HTML for the user-typed body. We bridge with two helpers:
//   - tiptapJsonToHtml: lossy-as-needed HTML rendering of the doc for the
//     initial editor mount. We only use this on the OUTBOUND boundary —
//     once RichTextEditor owns the doc, its own getHTML() is the truth.
//   - htmlToTiptapJson: parses HTML through a temporary Tiptap editor and
//     returns its JSON. Done lazily on save so we don't allocate an
//     editor for read-only views.
//
// Phase G (Y.js) will replace this bridge with a CRDT-backed Tiptap doc
// that emits both formats natively — until then, this is the boundary.

function tiptapJsonToHtml(json) {
  if (!json || typeof json !== 'object') return '';
  // Cheap path: handle the most common cases (heading / paragraph / list)
  // without spinning up a Tiptap editor. Anything fancy will round-trip
  // through htmlToTiptapJson the next save.
  try {
    return renderNode(json);
  } catch {
    return '';
  }
}

function renderNode(node) {
  if (!node) return '';
  if (typeof node.text === 'string') {
    let out = escapeHtml(node.text);
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (mark.type === 'bold')   out = `<strong>${out}</strong>`;
        if (mark.type === 'italic') out = `<em>${out}</em>`;
        if (mark.type === 'strike') out = `<s>${out}</s>`;
        if (mark.type === 'code')   out = `<code>${out}</code>`;
        if (mark.type === 'link' && mark.attrs?.href) {
          out = `<a href="${escapeAttr(mark.attrs.href)}" rel="noopener noreferrer">${out}</a>`;
        }
      }
    }
    return out;
  }
  const children = Array.isArray(node.content) ? node.content.map(renderNode).join('') : '';
  switch (node.type) {
    case 'doc':         return children;
    case 'paragraph':   return `<p>${children || ''}</p>`;
    case 'heading':     return `<h${node.attrs?.level || 1}>${children}</h${node.attrs?.level || 1}>`;
    case 'bulletList':  return `<ul>${children}</ul>`;
    case 'orderedList': return `<ol>${children}</ol>`;
    case 'listItem':    return `<li>${children}</li>`;
    case 'blockquote':  return `<blockquote>${children}</blockquote>`;
    case 'codeBlock':   return `<pre><code>${children}</code></pre>`;
    case 'horizontalRule': return '<hr>';
    case 'hardBreak':   return '<br>';
    // Phase D Slice 1 — mention nodes. We emit the same HTML shape the
    // Tiptap Mention extension uses on render (so the round-trip into
    // the live editor preserves the mention as a node, not just text).
    case 'mention': {
      const id = escapeAttr(String(node.attrs?.id || ''));
      const label = escapeHtml(String(node.attrs?.label || node.attrs?.id || 'mention'));
      return `<span class="mention" data-type="mention" data-id="${id}" data-label="${label}">@${label}</span>`;
    }
    // Phase D Slice 2 — task chips. Emit the exact span shape TaskChip's
    // parseHTML expects so the chip round-trips back into an atom node
    // (not a static span) when the editor re-mounts the doc on load.
    case 'taskChip':
    case 'task-chip': {
      const taskId = escapeAttr(String(node.attrs?.taskId || ''));
      const label = escapeHtml(String(node.attrs?.label || node.attrs?.taskId || 'task'));
      const status = escapeAttr(String(node.attrs?.status || ''));
      const boardId = escapeAttr(String(node.attrs?.boardId || ''));
      const statusAttr = status ? ` data-status="${status}"` : '';
      const boardAttr = boardId ? ` data-board-id="${boardId}"` : '';
      return `<span class="task-chip" data-type="task-chip" data-task-id="${taskId}" data-label="${label}"${statusAttr}${boardAttr}>+${label}</span>`;
    }
    default:            return children;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Last-resort fallback when the live editor JSON isn't available (it always
// should be — see handleBodyChange). Returns a single-paragraph doc with
// the HTML stripped to plain text so a save never crashes and the user's
// content isn't lost outright. Previously this called `require('@tiptap/core')`
// at runtime, which crashes Vite ESM browser bundles ("require is not
// defined"). The lossless live-JSON path makes that round-trip unnecessary.
function htmlToTiptapJson(html) {
  if (!html || typeof html !== 'string') {
    return { type: 'doc', content: [] };
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const text = (tmp.textContent || tmp.innerText || '').trim();
  if (!text) return { type: 'doc', content: [] };
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}
