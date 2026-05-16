import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, FileText, Share2, MoreHorizontal, Archive, RotateCcw,
  Sparkles, Check, AlertCircle, Loader2,
} from 'lucide-react';
import api from '../../services/api';
import {
  getDoc, archiveDoc as archiveDocApi, restoreDoc as restoreDocApi,
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

  const isOwner = useMemo(() => {
    if (!doc || !user) return false;
    return isSuperAdmin || doc.createdBy === user.id || user.role === 'admin' || user.role === 'manager';
  }, [doc, user, isSuperAdmin]);

  const { status, lastSavedAt, error: saveError, scheduleSave, flush } = useDocAutosave({
    docId,
    debounceMs: 1200,
    onSaved: (updated) => {
      // Server returned the canonical doc — merge it but don't overwrite
      // the body the user is actively typing.
      setDoc((prev) => (prev ? { ...prev, ...updated, contentJson: prev.contentJson } : updated));
    },
  });

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

  // Body edits → schedule autosave with the HTML re-serialized into a
  // Tiptap JSON doc. RichTextEditor emits HTML but the backend stores
  // contentJson (the Tiptap source of truth). We send BOTH the HTML body
  // (converted via htmlToTiptapJson) and the derived plain text.
  const handleBodyChange = useCallback((html) => {
    if (!initialLoadedRef.current) return; // ignore the first synthetic update
    setBodyDraft(html);
    const contentJson = htmlToTiptapJson(html);
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

  function handleShareCopy() {
    const url = `${window.location.origin}/workspaces/${workspaceId}/docs/${docId}`;
    navigator.clipboard?.writeText(url).then(
      () => toast.success('Link copied'),
      () => toast.info('Copy failed — ' + url)
    );
  }

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

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowSidekick(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/10 transition-colors"
            title="Ask AI about this doc"
          >
            <Sparkles size={13} /> Ask AI
          </button>
          <button
            type="button"
            onClick={handleShareCopy}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium text-text-secondary border border-border bg-surface hover:border-primary-300 hover:text-primary"
          >
            <Share2 size={13} /> Share
          </button>
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

          <div className="rich-doc-body">
            <RichTextEditor
              value={bodyDraft}
              onUpdate={handleBodyChange}
              disabled={!isOwner || doc.isArchived}
              placeholder="Start writing… Try / for block commands."
              minHeight={400}
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
    </div>
  );
}

function SaveIndicator({ status, lastSavedAt, error }) {
  if (status === 'saving') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-text-tertiary">
        <Loader2 size={11} className="animate-spin" />
        Saving…
      </span>
    );
  }
  if (status === 'dirty') {
    return <span className="text-xs text-text-tertiary">Unsaved changes…</span>;
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-danger" title={error}>
        <AlertCircle size={11} />
        Save failed
      </span>
    );
  }
  if (status === 'saved' && lastSavedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-text-tertiary">
        <Check size={11} className="text-success" />
        Saved {formatDistanceToNow(lastSavedAt, { addSuffix: true })}
      </span>
    );
  }
  return null;
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

function htmlToTiptapJson(html) {
  // Lazy parse — only spin up an editor when actually saving.
  if (!html || typeof html !== 'string') {
    return { type: 'doc', content: [] };
  }
  // We can't import Tiptap modules at module-top in a way that's tree-
  // shakable, so we do it inline. Tiptap's getJSON() does the real work;
  // this code path runs every ~1.2s during active typing, but the editor
  // construction is cheap (no plugins beyond StarterKit needed for the
  // parse).
  try {
    const { Editor } = require('@tiptap/core');
    const StarterKit = require('@tiptap/starter-kit').default;
    const editor = new Editor({
      extensions: [StarterKit],
      content: html,
    });
    const json = editor.getJSON();
    editor.destroy();
    return json;
  } catch (e) {
    safeLog.warn('[DocPage] htmlToTiptapJson fallback (returning empty doc)', e);
    return { type: 'doc', content: [] };
  }
}
