import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  FileText, Archive, RotateCcw,
  Sparkles, Check, AlertCircle, Loader2, History, MessageSquare, Save,
  MoreHorizontal, Link2, Wand2, ChevronDown, ChevronRight, LayoutGrid, RefreshCw,
  PanelRight, PanelRightClose,
} from 'lucide-react'; // History + MessageSquare — Phase F + H header buttons. Save — May 2026 manual-save button. May 2026 Notion-style refactor: MoreHorizontal/Link2/Wand2/ChevronDown for the new AI + More menus. ChevronRight + LayoutGrid added for the Editorial breadcrumb (May 2026 Editorial pass). RefreshCw — live peer-update refresh pill. PanelRight/PanelRightClose — June 2026 right-rail docs navigator toggle.
import PortalDropdown from '../../components/common/PortalDropdown';
import { AnimatePresence, motion } from 'framer-motion';
import api from '../../services/api';
import {
  getDoc, archiveDoc as archiveDocApi, restoreDoc as restoreDocApi,
  listMentionableUsers, listSearchableTasks, listDocComments,
  // Phase G follow-up — owner-only migration of an existing doc to Y.js.
  migrateDocToCollab,
  // Bidirectional unshare — revoke the explicit grant when an @name chip is
  // removed from the shared-with bar.
  removeCollaborator,
} from '../../services/docsService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../components/common/Toast';
import EmptyState from '../../components/common/EmptyState';
import LetterAvatar from '../../components/common/LetterAvatar';
import ErrorBoundary from '../../components/common/ErrorBoundary';
// Phase A made this editor real. Phase B uses it as the doc body for
// legacy `contentFormat='tiptap_json'` docs.
import RichTextEditor from '../../components/common/RichTextEditor';
// Phase 6 — Notion-style BlockNote editor for new personal docs
// (contentFormat='blocknote_json'). Lazy import so the BlockNote bundle
// (~400kb gzipped) only loads when a BlockNote doc is opened.
const BlockNoteEditor = React.lazy(() => import('../../components/common/BlockNoteEditor'));
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
// Phase H — version history modal.
import DocVersionHistoryModal from './DocVersionHistoryModal';
// Phase 8 — DocSharePanel replaces the old DocShareDropdown. It manages
// real per-user doc_access rows (owner / mention / manual_share /
// legacy_workspace) instead of the legacy `sharePolicy` enum.
import DocSharePanel from './DocSharePanel';
// Shared-with @name bar — renders the doc's collaborators as @mention
// chips just under the title, with owner-only unshare. Reflects live
// share/unshare via the `shareVersion` reload key bumped by DocSharePanel.
import DocSharedWithBar from './DocSharedWithBar';
// June 2026 — in-editor right rail to switch between docs (department-grouped
// for Tier 1/2) without bouncing back to /docs. Open/close persisted in
// localStorage so it survives refresh, ChatGPT/Claude-sidebar style.
import DocsSidePanel from './DocsSidePanel';

/**
 * DocPage — collaborative document viewer/editor.
 *
 * Route: `/docs/:docId` (workspace was dropped from the URL in
 * feat/docs-personal-notion Phase 1; it's now derived from doc.workspaceId
 * after the doc loads and used only for the mention/task pickers and the
 * AI sidekick pageState).
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

// localStorage key for the right-rail docs navigator open/close state.
// Global (not per-user / per-doc) so the rail preference is one toggle the
// user sets once and it sticks everywhere in Docs.
const DOCS_PANEL_STORAGE_KEY = 'docsRightPanelOpen';

export default function DocPage() {
  // feat/docs-personal-notion Phase 1: URL is now /docs/:docId — workspaceId
  // is no longer in the URL. It comes from the loaded doc (doc.workspaceId)
  // so the mention picker, task-chip picker, and back-navigation still work
  // without a workspace-scoped route. Phase 2 will further detach the
  // pickers from workspace context.
  const { docId } = useParams();
  const navigate = useNavigate();
  const { user, isSuperAdmin, canManage } = useAuth();
  const toast = useToast();

  const [doc, setDoc] = useState(null);
  // Derived from doc.workspaceId once the doc loads. Used by mention/task
  // pickers and share URL only — NOT a URL param anymore.
  const workspaceId = doc?.workspaceId;
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
  // Live collaboration (May 2026 — non-CRDT path). When a peer saves the
  // doc, the server fires `doc:updated`; we re-fetch the body and bump
  // `editorRemountKey` to remount the editor with the fresh content (the
  // BlockNote/Tiptap editors only read `value` on mount, so a key bump is
  // the canonical way to apply external content — neither fires onChange
  // for initial content, so there's no echo-save loop). If the local user
  // has unsaved edits we don't clobber them — we surface a Refresh pill
  // (`peerUpdated`) instead.
  const [editorRemountKey, setEditorRemountKey] = useState(0);
  const [peerUpdated, setPeerUpdated] = useState(false);
  // Bumped whenever the Share panel mutates collaborators so the
  // shared-with @name bar re-fetches.
  const [shareVersion, setShareVersion] = useState(0);

  // June 2026 — right-rail docs navigator. Open/close persists in
  // localStorage (global key, not per-doc) so the rail stays as the user
  // left it across navigations and refreshes. Defaults to OPEN on first
  // visit so the new switcher is discoverable. When open, the editor column
  // re-centers within the narrower remaining space (shifts left, ChatGPT
  // style); when closed it centers in the full width.
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      const v = localStorage.getItem(DOCS_PANEL_STORAGE_KEY);
      return v === null ? true : v === '1';
    } catch {
      return true;
    }
  });
  const togglePanel = useCallback(() => {
    setPanelOpen((v) => {
      const next = !v;
      try { localStorage.setItem(DOCS_PANEL_STORAGE_KEY, next ? '1' : '0'); } catch { /* quota / privacy mode */ }
      return next;
    });
  }, []);

  // Post-Phase-2: server returns `callerAccessLevel` from getDoc, computed
  // by docAccessService.getDocAccessLevel. It's the single source of truth
  // for what this caller can do on this doc — owner > edit > comment > view,
  // with super-admin bypass already collapsed to 'owner' upstream. Role/tier
  // membership does NOT promote anyone to owner anymore; the legacy
  // `user.role === 'admin'` shortcut here was the reason any
  // admin/manager could trigger PATCH autosaves on other people's docs and
  // get "you have comment" toast spam.
  const serverAccessLevel = doc?.callerAccessLevel || null;

  // isOwner gates destructive UI (archive / restore / rename / share-panel
  // mutations). Strictly the doc owner or super-admin.
  const isOwner = useMemo(() => {
    if (!doc || !user) return false;
    if (isSuperAdmin) return true;
    if (serverAccessLevel === 'owner') return true;
    // Safe fallback for the brief window before the server starts surfacing
    // callerAccessLevel on every response (e.g. an older cached payload).
    const ownerId = doc.ownerUserId || doc.createdBy;
    return !!ownerId && ownerId === user.id;
  }, [doc, user, isSuperAdmin, serverAccessLevel]);

  // canEdit gates body writes (autosave PATCH, manual Save). Only owners
  // and explicit edit-level grants. View / comment users see a read-only
  // editor; archived docs are read-only regardless of access.
  const canEdit = useMemo(() => {
    if (!doc || doc.isArchived) return false;
    if (isOwner) return true;
    return serverAccessLevel === 'edit';
  }, [doc, isOwner, serverAccessLevel]);

  // canComment gates the floating "Comment" affordance. Owners + edit-level
  // users can always comment; comment-level collaborators can too (even
  // though their editor body is read-only). View-only users + archived docs
  // get no comment affordance.
  const canComment = useMemo(() => {
    if (!doc || doc.isArchived) return false;
    if (canEdit) return true;
    return serverAccessLevel === 'comment';
  }, [doc, canEdit, serverAccessLevel]);

  // Editor-agnostic comment trigger. BlockNote (new docs) doesn't carry our
  // Comment pill in its own toolbar, and comment-level collaborators get a
  // read-only editor where TipTap's bubble menu is suppressed — so neither
  // path surfaced a way to comment. We instead watch native text selection
  // inside the doc body and float a small "Comment" pill next to it. Works
  // for both editor types and in read-only mode.
  const docBodyRef = useRef(null);
  const [commentBtn, setCommentBtn] = useState(null); // { top, left, text } | null

  useEffect(() => {
    if (!canComment) { setCommentBtn(null); return undefined; }
    let raf = 0;
    const evaluate = () => {
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setCommentBtn(null); return; }
      const text = sel.toString();
      if (!text || !text.trim()) { setCommentBtn(null); return; }
      const range = sel.getRangeAt(0);
      // Only when the selection lives inside this doc's body (not the
      // comments composer, sidebar, or anywhere else on the page).
      const body = docBodyRef.current;
      if (!body || !body.contains(range.commonAncestorContainer)) { setCommentBtn(null); return; }
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) { setCommentBtn(null); return; }
      // position:fixed → viewport coords. Clamp inside the viewport.
      const top = Math.min(rect.bottom + 8, window.innerHeight - 44);
      const left = Math.min(Math.max(rect.left + rect.width / 2 - 48, 12), window.innerWidth - 120);
      setCommentBtn({ top, left, text: text.trim().slice(0, 1000) });
    };
    const onSelectionChange = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(evaluate);
    };
    const onScroll = () => setCommentBtn(null);
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [canComment]);

  // Open the comments sidebar with the captured selection pre-anchored.
  // anchorText is the server's source of truth for re-anchoring; from/to are
  // left null (native-selection path doesn't carry ProseMirror offsets).
  const startCommentFromSelection = useCallback(() => {
    if (!commentBtn) return;
    setPendingCommentAnchor({ text: commentBtn.text, from: null, to: null });
    setCommentsOpen(true);
    setCommentBtn(null);
    try { window.getSelection()?.removeAllRanges(); } catch (_) { /* no-op */ }
  }, [commentBtn]);

  // Phase 4 — global active-user mention picker. No longer scoped to the
  // doc's workspace (per decision 17.5 any active user can mention any
  // active user). The memoized wrapper is now stable across the lifetime
  // of the page; we keep the useMemo to preserve referential stability for
  // RichTextEditor's extension list (which would otherwise re-init the
  // Tiptap instance on every keystroke-driven re-render).
  const mentionsConfig = useMemo(() => ({
    suggest: async (query) => {
      try {
        const { users } = await listMentionableUsers({ q: query });
        return Array.isArray(users) ? users : [];
      } catch (err) {
        safeLog.warn('[DocPage] mentionable users fetch failed', err);
        return [];
      }
    },
  }), []);

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

  // feat/docs-personal-notion Phase 7 — Y.js/Hocuspocus collab path is
  // DEPRECATED (decision 17.4). We still call useDocCollab so the hook's
  // teardown code runs cleanly on unmount, but `enabled: false` keeps the
  // WebSocket from ever opening. The hook returns its idle state and the
  // editor below mounts in single-user mode (HTTP autosave only). The
  // useDocCollab.js / docCollabService.js / routes/docCollab.js files stay
  // on disk for now — a future cleanup phase deletes them en bloc.
  const collab = useDocCollab({
    docId: doc?.id,
    enabled: false, // Phase 7 — Y.js path retired
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
    // Gate autosave on the caller's actual edit ability. View / comment
    // users never fire PATCH requests — without this, a Tier-4 viewer
    // opening a legacy doc they have 'comment' on would trigger the
    // editor's first synthetic onChange → PATCH → 403 → "you have comment"
    // toast spam. Owners/editors get full debounced autosave.
    enabled: canEdit,
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
    // Read-only callers shouldn't be able to trigger a PATCH via Ctrl+S
    // either. Without this, Ctrl+S in a doc the user only has 'comment' on
    // returns the same 403 toast pattern the autosave path now avoids.
    if (!canEdit) {
      try { toast.info('You have read-only access to this doc.'); } catch (_) { /* no-op */ }
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
  }, [docId, doc?.isArchived, canEdit, flush, toast]);

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
  //
  // June 2026 — every doc now renders in the BlockNote (Notion-style) editor.
  // Legacy `tiptap_json` docs are converted to BlockNote blocks IN MEMORY on
  // load (withBlockNoteContent) so the old TipTap editor never mounts and the
  // "Switch to new editor" affordance is gone. When the caller can edit, we
  // also persist the migration once (PATCH) so the doc is permanently
  // BlockNote — the server snapshots the original TipTap JSON into
  // legacyContentJson + version history before overwriting, so nothing is lost.
  useEffect(() => {
    if (!docId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    initialLoadedRef.current = false;
    getDoc(docId)
      .then(async ({ doc: loaded }) => {
        if (cancelled) return;
        const hydrated = await withBlockNoteContent(loaded);
        if (cancelled) return;
        setDoc(hydrated);
        setTitleDraft(hydrated?.title || '');
        setBodyDraft(tiptapJsonToHtml(loaded?.contentJson));
        initialLoadedRef.current = true;
        // Persist the one-time TipTap → BlockNote migration so the doc never
        // round-trips through the legacy editor again. Fire-and-forget — a
        // failure just means we re-convert in memory on the next open.
        const migrated = loaded?.contentFormat === 'tiptap_json'
          && hydrated?.contentFormat === 'blocknote_json';
        if (migrated) {
          const ownerId = loaded.ownerUserId || loaded.createdBy;
          const lvl = loaded.callerAccessLevel;
          // Persist for anyone who can edit the body — the server flips the
          // format losslessly (it snapshots the original Tiptap JSON first).
          // Comment/view callers can't edit, so they just get the in-memory
          // BlockNote render and we re-convert on each open.
          const callerCanMigrate = !loaded.isArchived && (
            isSuperAdmin || lvl === 'owner' || lvl === 'edit'
            || (ownerId && user && ownerId === user.id)
          );
          if (callerCanMigrate) {
            api.patch(`/docs/${loaded.id}`, {
              contentJson: hydrated.contentJson,
              contentFormat: 'blocknote_json',
            }).catch((err) => safeLog.warn('[DocPage] auto-migrate to BlockNote failed (non-fatal)', err));
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        safeLog.error('[DocPage] load error', err);
        setError(getErrorMessage(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, isSuperAdmin, user?.id]);

  // ─── Live collaboration (non-CRDT) ────────────────────────────
  // Re-fetch the doc and remount the editor with the fresh content. Used
  // when a peer's edit arrives (`doc:updated`) or our access level changes
  // (`doc:access:granted`). The editor only reads `value` on mount, so a
  // key bump is how external content is applied — and neither editor fires
  // onChange for initial content, so there's no echo-save loop.
  const reloadDocBody = useCallback(() => {
    if (!docId) return;
    getDoc(docId)
      .then(async ({ doc: fresh }) => {
        if (!fresh) return;
        const hydrated = await withBlockNoteContent(fresh);
        setDoc((prev) => (prev ? { ...prev, ...hydrated } : hydrated));
        setBodyDraft(tiptapJsonToHtml(fresh?.contentJson));
        setEditorRemountKey((k) => k + 1);
        setPeerUpdated(false);
      })
      .catch((err) => {
        safeLog.warn('[DocPage] reloadDocBody failed', err);
      });
  }, [docId]);

  // Apply a peer refresh, but never clobber the local user's unsaved edits:
  // if we're mid-edit (dirty/saving), surface a manual Refresh pill instead.
  const applyPeerRefresh = useCallback(() => {
    if (status === 'dirty' || status === 'saving') {
      setPeerUpdated(true);
      return;
    }
    reloadDocBody();
  }, [status, reloadDocBody]);

  // Peer edited the doc body/title. Ignore our own saves (actorId === me).
  useRealtimeEvent('doc:updated', useCallback((payload) => {
    if (!payload || payload.docId !== docId) return;
    if (payload.actorId && user && payload.actorId === user.id) return;
    applyPeerRefresh();
  }, [docId, user, applyPeerRefresh]));

  // Our access to this doc was granted or its level changed (e.g. view →
  // edit). Re-fetch so callerAccessLevel / canEdit recompute and the editor
  // re-mounts with the correct editable state.
  useRealtimeEvent('doc:access:granted', useCallback((payload) => {
    if (!payload || payload.docId !== docId) return;
    applyPeerRefresh();
  }, [docId, applyPeerRefresh]));

  // Our access to this doc was revoked — bounce back to the docs list.
  useRealtimeEvent('doc:access:revoked', useCallback((payload) => {
    if (!payload || payload.docId !== docId) return;
    try { toast.info('Your access to this doc was removed.'); } catch (_) { /* no-op */ }
    navigate('/docs');
  }, [docId, navigate, toast]));

  // Strip every @mention of `userId` from the live editor body. Returns true
  // if anything was removed. The edit fires the editor's onChange → autosave,
  // so the server's mention-sync then drops the mention-derived access row.
  const removeMentionFromEditor = useCallback((userId) => {
    const editor = editorRef.current?.getEditor?.();
    if (!editor || !userId) return false;
    if (doc?.contentFormat === 'blocknote_json') {
      return removeBlockNoteMention(editor, userId);
    }
    return removeTiptapMention(editor, userId);
  }, [doc?.contentFormat]);

  // Unshare a collaborator from the "Shared with" bar. Keeps the bar and the
  // doc body in sync: removes the person's @mention from the content (so the
  // next save can't re-grant mention access) AND revokes any explicit
  // doc_access grant. Bumps shareVersion so the bar/panel refresh.
  const handleUnshareCollaborator = useCallback(async (row) => {
    const userId = row?.user?.id;
    if (!userId) return;
    // 1. Remove the @mention from the body, then flush so it persists now.
    try {
      const removed = removeMentionFromEditor(userId);
      if (removed) { try { await flush(); } catch (_) { /* non-fatal */ } }
    } catch (err) {
      safeLog.warn('[DocPage] removeMentionFromEditor failed', err);
    }
    // 2. Revoke the explicit grant. A mention-only collaborator may already
    //    have had their row cleared by the save above → tolerate 404.
    try {
      await removeCollaborator(docId, userId);
    } catch (err) {
      const status = err?.response?.status;
      if (status && status !== 404) throw err;
    }
    // 3. Refresh the shared-with bar + Share panel.
    setShareVersion((v) => v + 1);
  }, [docId, removeMentionFromEditor, flush]);

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

  // Phase 6 — BlockNote change handler. The editor emits Block[] directly;
  // we forward as-is. Server-side `sanitizeContentJson` accepts both
  // shapes (Tiptap doc envelope OR BlockNote block array) so no transform
  // is needed at the wire boundary.
  const handleBlockNoteChange = useCallback((blocks) => {
    if (!initialLoadedRef.current) return;
    if (!Array.isArray(blocks)) return;
    scheduleSave({ contentJson: blocks });
  }, [scheduleSave]);

  async function handleArchive() {
    if (!doc?.id) return;
    const ok = window.confirm(`Archive "${doc.title}"? You can restore it from the workspace archive later.`);
    if (!ok) return;
    try {
      await archiveDocApi(doc.id);
      toast.success('Doc archived');
      navigate('/docs');
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

  // June 2026 — switching docs from the right rail must NOT unmount the rail
  // or re-render the whole page; only the editor COLUMN should swap. So we no
  // longer early-return a full-page skeleton/error here (that wiped the whole
  // tree, including the rail, which then re-fetched and flashed). Instead the
  // header + rail render persistently and only the editor column below reacts
  // to loading / error / doc. `doc` persists across a doc→doc switch (we never
  // clear it), so the header keeps showing the previous title until the new
  // doc loads, while the rail stays put.
  const showSkeleton = loading;
  const showError = !loading && (error || !doc);
  const showDoc = !loading && !error && !!doc;

  const titleDisplay = (
    <h1
      className="doc-page-notion__title"
      onClick={() => isOwner && setEditingTitle(true)}
      title={isOwner ? 'Click to rename' : doc?.title}
    >
      {doc?.title || <span className="doc-page-notion__title-placeholder">Untitled</span>}
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
      placeholder="Untitled"
      className="doc-page-notion__title doc-page-notion__title--editing"
    />
  );

  return (
    <div className="flex flex-col h-full doc-page-notion">
      {/* Editorial minimal sticky toolbar (May 2026 redesign).
          Left:  app-grid › Monday Aniston › <doc title (truncated)>.
          Right: SaveIndicator · AI · Comments · Share · inline Save (only
                 while dirty/saving) · More.
          History / Archive / Copy-link / Convert all live in More. */}
      <header className="doc-page-notion__header">
        <div className="doc-page-notion__breadcrumb">
          <button
            type="button"
            onClick={() => navigate('/docs')}
            className="doc-page-notion__breadcrumb-app"
            aria-label="Back to docs"
            title="Back to docs"
          >
            <LayoutGrid size={14} aria-hidden="true" />
            <span>Monday Aniston</span>
          </button>
          <ChevronRight size={12} className="doc-page-notion__breadcrumb-sep" aria-hidden="true" />
          <span className="doc-page-notion__breadcrumb-title" title={doc?.title}>
            {doc?.title || 'Untitled'}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Doc-dependent controls. Absent on the very first load (no doc
              yet) but kept rendered with the PREVIOUS doc during a doc→doc
              switch so the header doesn't flash. The rail toggle below stays
              outside this guard so it's always available. */}
          {doc && (
          <>
          <SaveIndicator status={status} lastSavedAt={lastSavedAt} error={saveError} />
          {/* Live peer-update pill — shown only when a collaborator's edit
              arrived while we had unsaved local changes (so we didn't auto-
              clobber the editor). Clicking loads the latest. */}
          {peerUpdated && (
            <button
              type="button"
              onClick={reloadDocBody}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100"
              title="This doc was updated by someone else — click to load the latest"
            >
              <RefreshCw size={12} /> Updated · Refresh
            </button>
          )}
          {/* Collab presence pill — currently no-op since collab is off
              (enabled:false), but harmless if the flag ever flips. */}
          <CollabStatusPill
            status={collab.status}
            peerCount={collab.peerCount}
            error={collab.error}
          />
          {isOwner && collab.error && collab.error._collabMigrationMissing && (
            <MigrateToCollabButton docId={doc.id} />
          )}
          {/* AI menu — Summarize + Ask AI behind one sparkle. */}
          <DocAIMenu
            onSummarize={async () => {
              if (preparingSummary || summaryOpen) return;
              setPreparingSummary(true);
              try {
                try { await flush(); } catch (_) { /* non-fatal */ }
                setSummaryOpen(true);
              } finally {
                setPreparingSummary(false);
              }
            }}
            onAskAI={async () => {
              try { await flush(); } catch (_) { /* non-fatal */ }
              setShowSidekick(true);
            }}
            preparing={preparingSummary}
          />

          {/* Comments — single icon button; opens sidebar on click. */}
          <button
            type="button"
            onClick={() => { setPendingCommentAnchor(null); setCommentsOpen(true); }}
            className="doc-page-notion__icon-btn"
            aria-label="Open comments"
            title="Comments"
          >
            <MessageSquare size={15} />
          </button>

          {/* Share popover (DocSharePanel already renders as a Popover).
              onChanged bumps shareVersion so the shared-with @name bar
              under the title re-fetches after any add/level-change/remove. */}
          <DocSharePanel
            docId={doc.id}
            canEdit={isOwner}
            onChanged={() => setShareVersion((v) => v + 1)}
          />

          {/* Inline Save affordance — only appears while dirty/error so the
              header stays minimal during clean autosave loops. Full Save
              entry also lives in the More menu below. */}
          {canEdit && (status === 'dirty' || status === 'error' || status === 'saving') && (
            <button
              type="button"
              onClick={handleManualSave}
              disabled={status === 'saving'}
              className="doc-page-notion__inline-save"
              title="Save now (Ctrl/Cmd + S)"
            >
              {status === 'saving' ? (
                <><Loader2 size={12} className="animate-spin" /> Saving…</>
              ) : (
                <><Save size={12} /> Save</>
              )}
            </button>
          )}

          {/* Restore is a primary recovery action — keep inline when archived.
              June 2026: archive/restore are Tier 1/2 (canManage) actions. */}
          {canManage && doc.isArchived && (
            <button
              type="button"
              onClick={handleUnarchive}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[12px] font-medium text-primary border border-primary-200 bg-primary-50 hover:bg-primary-100"
              title="Restore doc"
            >
              <RotateCcw size={12} /> Restore
            </button>
          )}

          {/* More menu — History, Save, Copy link, Archive. */}
          <DocMoreMenu
            canEdit={canEdit}
            canManage={canManage}
            doc={doc}
            saveStatus={status}
            onOpenHistory={() => setVersionsOpen(true)}
            onManualSave={handleManualSave}
            onCopyLink={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                toast.success('Link copied');
              } catch (err) {
                toast.error('Could not copy link');
              }
            }}
            onArchive={handleArchive}
          />
          </>
          )}

          {/* Right-rail docs navigator toggle. Sits at the far right edge so
              it reads as the control for the panel on that edge. Highlighted
              while open. State persists in localStorage. */}
          <button
            type="button"
            onClick={togglePanel}
            className={`doc-page-notion__icon-btn${panelOpen ? ' doc-page-notion__icon-btn--active' : ''}`}
            aria-pressed={panelOpen}
            aria-label={panelOpen ? 'Hide docs panel' : 'Show docs panel'}
            title={panelOpen ? 'Hide docs panel' : 'Show docs panel'}
          >
            {panelOpen ? <PanelRightClose size={16} /> : <PanelRight size={16} />}
          </button>
        </div>
      </header>

      {/* Super-admin override banner — slim calm strip (audit-required
          per decision 17.7a). Token-driven; matches the approved Editorial
          spec: mx-4, 8px y-padding, rounded, 6px accent dot. */}
      {(isSuperAdmin || canManage) && doc && doc.ownerUserId && doc.ownerUserId !== user?.id && (
        <div className="doc-page-notion__sa-banner" role="status">
          <span className="doc-page-notion__sa-banner-dot" aria-hidden="true" />
          <span className="truncate">
            <strong>{isSuperAdmin ? 'Super admin view' : 'Admin view'}</strong>
            {' — viewing '}
            {doc.owner?.name ? `${doc.owner.name}'s` : "another user's"}
            {' doc. Actions are logged.'}
          </span>
        </div>
      )}

      {/* Editorial centered page column. Floating doc icon + large title +
          compact meta + chromeless editor body. (Cover band removed
          May 2026 — felt too heavy; icon now sits flush at the top of
          the column.)

          June 2026 — wrapped in a flex row with the docs navigator rail on
          the right. The editor scroll area is flex-1, so when the rail is
          open the centered column re-centers in the narrower space (shifts
          left, ChatGPT/Claude style); when the rail is closed it centers in
          the full width. */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 overflow-auto">
          {showSkeleton ? (
            <div className="doc-page-notion__column" aria-busy="true">
              <div className="doc-page-notion__page-icon" aria-hidden="true" />
              <div className="h-8 w-2/3 rounded animate-pulse mt-5 mb-4" style={{ background: 'var(--surface-100, #f0f2f5)' }} />
              <div className="h-4 w-full rounded animate-pulse mb-2" style={{ background: 'var(--surface-100, #f0f2f5)' }} />
              <div className="h-4 w-5/6 rounded animate-pulse mb-2" style={{ background: 'var(--surface-100, #f0f2f5)' }} />
              <div className="h-4 w-2/3 rounded animate-pulse" style={{ background: 'var(--surface-100, #f0f2f5)' }} />
            </div>
          ) : showError ? (
            <div className="doc-page-notion__column">
              <EmptyState
                title="Couldn't load this doc"
                description={error || 'The doc may have been archived or you may not have access.'}
                primaryAction={{ label: 'Back to docs', onClick: () => navigate('/docs') }}
              />
            </div>
          ) : showDoc ? (
          <div className="doc-page-notion__column">
          <div className="doc-page-notion__title-block">
            <div className="doc-page-notion__page-icon" aria-hidden="true">
              <FileText size={22} />
            </div>
            {editingTitle && isOwner ? titleEditor : titleDisplay}
            <div className="doc-page-notion__meta">
              {doc.creator && (
                <span className="inline-flex items-center gap-1.5">
                  <LetterAvatar name={doc.creator.name} size="xs" shape="circle" />
                  {doc.creator.name}
                </span>
              )}
              {doc.lastEditedAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Edited {formatDistanceToNow(new Date(doc.lastEditedAt), { addSuffix: true })}</span>
                </>
              )}
              {doc.isArchived && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-amber-600 font-semibold">Archived</span>
                </>
              )}
            </div>
            {/* Shared-with @name bar — collaborators rendered as @mention
                chips. Owner can unshare inline. Re-fetches on shareVersion
                (bumped by the Share panel) so it stays in sync. */}
            <DocSharedWithBar
              docId={doc.id}
              canEdit={isOwner}
              reloadKey={shareVersion}
              onChanged={() => setShareVersion((v) => v + 1)}
              onUnshare={handleUnshareCollaborator}
            />
          </div>
          {/* Phase D Slice 2c — delegated click handler. When the user
              clicks a task chip we look up the chip's data-task-id +
              data-board-id and navigate to /boards/<board>?taskId=<id>,
              which BoardPage already deep-links to TaskModal. Holding
              Ctrl/Cmd opens in a new tab. */}
          <div
            ref={docBodyRef}
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
            {/* Phase 6 — format-aware editor selection.
                  - blocknote_json (NEW docs, default) → BlockNote editor
                  - tiptap_json (legacy) → RichTextEditor with all the
                    existing extensions (mentions, task chips, AI, comments,
                    optional Y.js collab)
                The branch is keyed on doc.contentFormat which the server
                sets at create time. Legacy docs created before Phase 6
                continue to render in Tiptap; new docs render BlockNote.
                Phase 7 adds an explicit "Convert to new editor" affordance
                for legacy docs that wires through legacyContentJson. */}
            {/* Defensive ErrorBoundary around the editor body. If BlockNote
                chokes on a malformed contentJson (e.g. a Tiptap envelope
                sneaking in under contentFormat='blocknote_json') or Tiptap
                throws on an exotic legacy node, this catches the render
                error and shows an inline retry card instead of bubbling to
                App.jsx's full-page ErrorBoundary. Reset key on doc id +
                contentFormat so navigating to another doc clears the
                error state. */}
            <ErrorBoundary
              variant="section"
              name="DocEditor"
              resetKeys={[doc.id, doc.contentFormat]}
            >
            {doc.contentFormat === 'blocknote_json' ? (
              <React.Suspense fallback={<div className="text-sm text-text-tertiary py-12">Loading editor…</div>}>
                <BlockNoteEditor
                  // Key bump remounts the editor with fresh content after a
                  // peer edit / version restore / access change.
                  key={`bn-${editorRemountKey}`}
                  ref={editorRef}
                  value={doc.contentJson}
                  onChange={handleBlockNoteChange}
                  disabled={!canEdit}
                  placeholder="Press / for commands, @ to mention someone"
                  minHeight={500}
                  // Phase 7 — @-mention picker. Reuses the same mentionsConfig
                  // as the legacy editor (global active-user search via
                  // /api/users/mentions). Selecting a user inserts a mention
                  // inline content node; the doc-save path's syncDocMentionsAndNotify
                  // then creates the DocMention row + doc_access grant.
                  mentions={mentionsConfig}
                />
              </React.Suspense>
            ) : (
              <RichTextEditor
                // Key bump remounts the editor with fresh content after a
                // peer edit / version restore / access change.
                key={`rt-${editorRemountKey}`}
                ref={editorRef}
                // Phase G — when collab is active, Y.js owns content. We
                // intentionally still pass the cached HTML for non-collab
                // mode (single-user fallback) so initial-render text shows
                // immediately; RichTextEditor ignores `value` when its
                // `collab` prop is set.
                value={bodyDraft}
                onUpdate={handleBodyChange}
                disabled={!canEdit}
                placeholder="Press / for commands, @ to mention someone, + to link a task"
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
            )}
            </ErrorBoundary>
          </div>
          </div>
          ) : null}
        </div>

        {/* Right-rail docs navigator. Lives OUTSIDE the loading/error branch
            above so switching docs only swaps the editor column — the rail
            stays mounted (no re-fetch, no flash). activeDocId reads the URL
            param so the highlight is correct even while the new doc loads.
            AnimatePresence runs the slide-in/out animation on open/close;
            closing is owned by the header toggle only. */}
        <AnimatePresence initial={false}>
          {panelOpen && (
            <DocsSidePanel key="docs-rail" activeDocId={docId} />
          )}
        </AnimatePresence>
      </div>

      {/* Doc-scoped overlays (comment pill, sidekick, task/comment/version
          modals). Guarded on `doc` so they never read a null doc during the
          first load or a failed load — the rail and header above stay up
          regardless. */}
      {doc && (
      <>
      {/* Floating "Comment" pill — appears next to a text selection in the
          doc body for anyone who can comment (owner / edit / comment). The
          editor-agnostic path so BlockNote docs and read-only comment-level
          collaborators can both start a comment.

          Suppressed for EDITABLE TipTap docs because that editor's own
          bubble menu already carries a Comment pill (wired via
          commentsConfig) — showing both would be a double button. BlockNote
          has no such pill, and read-only editors suppress the bubble, so the
          floating pill is the only affordance in those cases. */}
      {commentBtn && canComment
        && (doc.contentFormat === 'blocknote_json' || !canEdit)
        && typeof document !== 'undefined' && createPortal(
        <button
          type="button"
          // Keep the selection alive through the click so the captured text
          // isn't lost before onClick runs.
          onMouseDown={(e) => e.preventDefault()}
          onClick={startCommentFromSelection}
          className="fixed z-[9999] inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold shadow-lg hover:bg-emerald-700"
          style={{ top: commentBtn.top, left: commentBtn.left }}
          title="Comment on selection"
        >
          <MessageSquare size={13} /> Comment
        </button>,
        document.body,
      )}

      <SidekickPanel
        isOpen={showSidekick}
        onClose={() => setShowSidekick(false)}
        scope="doc"
        scopeId={doc.id}
        scopeLabel="this doc"
        pageContext={`Doc: ${doc.title}`}
        pageState={{ route: `/docs/${doc.id}`, docId: doc.id }}
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
          getDoc(doc.id).then(async ({ doc: reloaded }) => {
            const hydrated = await withBlockNoteContent(reloaded);
            setDoc(hydrated);
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
      </>
      )}
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

/**
 * DocAIMenu — single sparkle entry point that fronts Summarize + Ask AI.
 * Replaces the two large coloured buttons that used to sit in the header.
 * Inline expansion later (Improve writing / Shorter / Longer / Fix grammar)
 * just adds rows here without touching DocPage.
 */
function DocAIMenu({ onSummarize, onAskAI, preparing }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="doc-page-notion__menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title="AI actions"
      >
        {preparing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
        <span className="doc-page-notion__menu-trigger-label">AI</span>
        <ChevronDown size={11} className="opacity-60" />
      </button>
      <PortalDropdown anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} align="right" width={220}>
        <div className="doc-page-notion__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="doc-page-notion__menu-item"
            onClick={() => { setOpen(false); onSummarize(); }}
          >
            <Sparkles size={14} className="text-emerald-500" />
            <div className="flex-1 text-left">
              <div className="doc-page-notion__menu-item-title">Summarize</div>
              <div className="doc-page-notion__menu-item-hint">One-shot recap of this doc</div>
            </div>
          </button>
          <button
            type="button"
            role="menuitem"
            className="doc-page-notion__menu-item"
            onClick={() => { setOpen(false); onAskAI(); }}
          >
            <Wand2 size={14} className="text-violet-500" />
            <div className="flex-1 text-left">
              <div className="doc-page-notion__menu-item-title">Ask AI</div>
              <div className="doc-page-notion__menu-item-hint">Open Sidekick on this doc</div>
            </div>
          </button>
        </div>
      </PortalDropdown>
    </>
  );
}

/**
 * DocMoreMenu — overflow menu for the document-level actions that aren't
 * needed in the primary bar: History, Manual Save, Copy link, Archive.
 * Each item gates itself on the same permissions the inline buttons used to
 * check. June 2026: Archive is a Tier 1/2 (canManage) action; the legacy
 * "Switch to new editor" convert item was removed when all docs moved to the
 * BlockNote editor.
 */
function DocMoreMenu({
  canEdit, canManage, doc, saveStatus,
  onOpenHistory, onManualSave, onCopyLink, onArchive,
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="doc-page-notion__icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More"
      >
        <MoreHorizontal size={16} />
      </button>
      <PortalDropdown anchorRef={anchorRef} open={open} onClose={close} align="right" width={220}>
        <div className="doc-page-notion__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="doc-page-notion__menu-item"
            onClick={() => { close(); onOpenHistory(); }}
          >
            <History size={14} />
            <span className="doc-page-notion__menu-item-title">Version history</span>
          </button>
          {canEdit && (
            <button
              type="button"
              role="menuitem"
              className="doc-page-notion__menu-item"
              onClick={() => { close(); onManualSave(); }}
              disabled={saveStatus === 'saving'}
            >
              {saveStatus === 'saving' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              <span className="doc-page-notion__menu-item-title">
                {saveStatus === 'saving' ? 'Saving…' : 'Save now'}
              </span>
              <span className="doc-page-notion__menu-kbd">Ctrl S</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="doc-page-notion__menu-item"
            onClick={() => { close(); onCopyLink(); }}
          >
            <Link2 size={14} />
            <span className="doc-page-notion__menu-item-title">Copy link</span>
          </button>
          {canManage && !doc.isArchived && (
            <>
              <div className="doc-page-notion__menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="doc-page-notion__menu-item doc-page-notion__menu-item--danger"
                onClick={() => { close(); onArchive(); }}
              >
                <Archive size={14} />
                <span className="doc-page-notion__menu-item-title">Archive doc</span>
              </button>
            </>
          )}
        </div>
      </PortalDropdown>
    </>
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

// June 2026 — convert a legacy Tiptap `contentJson` envelope into BlockNote
// blocks. Renders the Tiptap JSON to HTML, then spins up a throwaway headless
// BlockNote editor to parse that HTML into blocks. Returns null on failure so
// callers can fall back to rendering the original content unchanged.
async function tiptapJsonToBlockNoteBlocks(contentJson) {
  try {
    const html = tiptapJsonToHtml(contentJson) || '';
    const { BlockNoteEditor: HeadlessEditor } = await import('@blocknote/core');
    const tmp = HeadlessEditor.create({});
    const blocks = await tmp.tryParseHTMLToBlocks(html);
    return Array.isArray(blocks) ? blocks : null;
  } catch {
    return null;
  }
}

// Returns a doc whose body is always BlockNote-shaped. A `blocknote_json`
// doc is returned untouched; a legacy `tiptap_json` doc is converted in
// memory so the BlockNote editor (the only editor we mount now) can render
// it. On conversion failure the original doc is returned so the page still
// loads (the ErrorBoundary around the editor catches any downstream render
// error).
async function withBlockNoteContent(loaded) {
  if (!loaded || loaded.contentFormat !== 'tiptap_json') return loaded;
  const blocks = await tiptapJsonToBlockNoteBlocks(loaded.contentJson);
  if (!blocks) return loaded;
  return { ...loaded, contentFormat: 'blocknote_json', contentJson: blocks };
}

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

// ─── Mention removal helpers (bidirectional unshare) ────────────
//
// Remove every @mention of a given user from the live editor so unsharing
// from the "Shared with" bar also strips them from the doc body. Both
// helpers mutate the editor in place, which fires the editor's onChange →
// schedules an autosave; the server's mention-sync then drops the
// mention-derived doc_access row. Each returns true if anything changed.

function removeTiptapMention(editor, userId) {
  const state = editor?.state;
  const view = editor?.view;
  if (!state || !view) return false;
  const ranges = [];
  state.doc.descendants((node, pos) => {
    if (node.type?.name === 'mention' && node.attrs?.id === userId) {
      ranges.push({ from: pos, to: pos + node.nodeSize });
    }
    return true;
  });
  if (!ranges.length) return false;
  // Delete last-to-first so earlier positions stay valid as we splice.
  ranges.sort((a, b) => b.from - a.from);
  let tr = state.tr;
  for (const r of ranges) tr = tr.delete(r.from, r.to);
  tr.setMeta('addToHistory', true);
  view.dispatch(tr);
  return true;
}

function removeBlockNoteMention(editor, userId) {
  if (!editor) return false;
  let changed = false;
  const walk = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (Array.isArray(block?.content)) {
        const hasMention = block.content.some(
          (c) => c?.type === 'mention' && c?.props?.userId === userId,
        );
        if (hasMention) {
          const newContent = block.content.filter(
            (c) => !(c?.type === 'mention' && c?.props?.userId === userId),
          );
          try {
            editor.updateBlock(block, { content: newContent });
            changed = true;
          } catch (_) { /* block gone / editor unmounting */ }
        }
      }
      if (Array.isArray(block?.children) && block.children.length) walk(block.children);
    }
  };
  try { walk(editor.document); } catch (_) { /* editor unmounting */ }
  return changed;
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
