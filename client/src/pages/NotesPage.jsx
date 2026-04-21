import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Mic, MicOff, FileText, Search, Trash2, Edit3, Clock, Save, X,
  ChevronDown, Plus, AlertTriangle, Globe, ArrowLeft,
  Sparkles, List, CheckSquare, RotateCcw, Copy, Check,
} from 'lucide-react';
import api from '../services/api';
import useSpeechToText from '../hooks/useSpeechToText';

const AI_PROCESS_TYPES = [
  { id: 'clean', label: 'Clean', icon: Sparkles, color: 'emerald' },
  { id: 'summarize', label: 'Summarize', icon: List, color: 'blue' },
  { id: 'action_items', label: 'Actions', icon: CheckSquare, color: 'violet' },
  { id: 'meeting_notes', label: 'Meeting Notes', icon: FileText, color: 'amber' },
];

const LANGUAGES = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'es-ES', label: 'Spanish' },
];

const TYPE_BADGES = {
  voice_note: { label: 'Voice', color: '#00c875', bg: '#00c87515' },
  text_note: { label: 'Text', color: '#0073ea', bg: '#0073ea15' },
};

function isSpeechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// ─── NoteEditor ───────────────────────────────────────────────
function NoteEditor({ note, onSaved, onCancel }) {
  const isNew = !note;

  const [title, setTitle] = useState(note?.title || '');
  const [content, setContent] = useState(note?.content || '');
  const [lang, setLang] = useState(note?.lang || 'en-US');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [titleError, setTitleError] = useState(false);
  const [dirty, setDirty] = useState(false);

  // AI processing state
  const [aiProcessing, setAiProcessing] = useState(false);
  const [aiProcessType, setAiProcessType] = useState(null);
  const [aiResult, setAiResult] = useState('');
  const [aiError, setAiError] = useState(null);
  const [aiCopied, setAiCopied] = useState(false);

  const textareaRef = useRef(null);
  const titleRef = useRef(null);

  const speechSupported = isSpeechSupported();

  const { isListening, interim, error: speechError, startListening, stopListening } =
    useSpeechToText({ lang, continuous: true, interimResults: true });

  // Mark dirty on any change
  useEffect(() => {
    if (isNew) {
      setDirty(title.trim() !== '' || content.trim() !== '');
    } else {
      setDirty(title !== note.title || content !== note.content || lang !== (note.lang || 'en-US'));
    }
  }, [title, content, lang, note, isNew]);

  // Unsaved changes warning
  useEffect(() => {
    const handler = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Stop speech on unmount
  useEffect(() => {
    return () => { stopListening(); };
  }, [stopListening]);

  // Clear title error when user starts typing title
  useEffect(() => {
    if (title.trim()) setTitleError(false);
  }, [title]);

  // Append each finalized speech chunk to the content field.
  // Using onFinal callback preserves pre-existing typed content, allows
  // multi-session resume-recording, and doesn't clobber manual edits.
  const handleFinalTranscript = useCallback((finalText) => {
    if (!finalText) return;
    setContent((prev) => {
      // Safety net: drop already-appended chunks that mobile engines can
      // replay after auto-restart cycles (keeps user-typed prefix intact).
      const chunkTrim = finalText.trim();
      if (chunkTrim) {
        const prevTail = prev.trimEnd().toLowerCase();
        if (prevTail.endsWith(chunkTrim.toLowerCase())) return prev;
      }
      const sep = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
      return prev + sep + finalText;
    });
  }, []);

  const toggleMic = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening(handleFinalTranscript);
    }
  };

  const handleAiProcess = async (type) => {
    if (!content.trim()) return;
    setAiProcessing(true);
    setAiProcessType(type);
    setAiError(null);
    setAiResult('');
    try {
      const res = await api.post('/notes/process', { text: content, processType: type });
      setAiResult(res.data?.result || '');
    } catch (err) {
      setAiError(err.response?.data?.message || 'AI processing failed. Is an AI provider configured?');
    } finally {
      setAiProcessing(false);
    }
  };

  const handleUseAiResult = () => {
    if (aiResult) {
      setContent(aiResult);
      setAiResult('');
      setAiProcessType(null);
    }
  };

  const handleCopyAiResult = () => {
    navigator.clipboard.writeText(aiResult || content);
    setAiCopied(true);
    setTimeout(() => setAiCopied(false), 2000);
  };

  const handleSave = async () => {
    // Resolve the effective title: use what user typed, or auto-generate from content
    let effectiveTitle = title.trim();
    const effectiveContent = content.trim();

    if (!effectiveTitle) {
      // Auto-generate title from content for notes with body text
      if (effectiveContent) {
        effectiveTitle = effectiveContent.length > 60
          ? effectiveContent.substring(0, 60) + '...'
          : effectiveContent;
        setTitle(effectiveTitle);
      } else {
        // Both title and content are empty — show validation error
        setTitleError(true);
        setSaveError('Please enter a title or some content for your note.');
        if (titleRef.current) titleRef.current.focus();
        return;
      }
    }

    if (window.__NOTES_DEBUG__) {
      console.log('[NoteEditor] handleSave', { effectiveTitle, effectiveContent, isNew });
    }

    setSaving(true);
    setSaveError(null);
    setTitleError(false);

    try {
      const payload = {
        title: effectiveTitle,
        content: effectiveContent,
        lang,
      };

      if (isNew) {
        payload.type = effectiveContent ? 'voice_note' : 'text_note';
        if (window.__NOTES_DEBUG__) {
          console.log('[NoteEditor] POST /notes', payload);
        }
        const res = await api.post('/notes', payload);
        if (window.__NOTES_DEBUG__) {
          console.log('[NoteEditor] POST response:', res.data);
        }
      } else {
        if (window.__NOTES_DEBUG__) {
          console.log('[NoteEditor] PUT /notes/' + note.id, payload);
        }
        const res = await api.put(`/notes/${note.id}`, payload);
        if (window.__NOTES_DEBUG__) {
          console.log('[NoteEditor] PUT response:', res.data);
        }
      }

      setDirty(false);
      // Notify other surfaces (VoiceNotes panel) so their lists refresh.
      window.dispatchEvent(new CustomEvent('notes:changed', {
        detail: { action: isNew ? 'created' : 'updated', id: note?.id },
      }));
      onSaved();
    } catch (err) {
      console.error('[NoteEditor] Save failed:', err);
      const msg = err?.response?.data?.message || 'Failed to save note. Please try again.';
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (dirty && !window.confirm('You have unsaved changes. Discard them?')) return;
    stopListening();
    onCancel();
  };

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-6 shadow-sm">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={handleCancel}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          <ArrowLeft size={14} /> Back to notes
        </button>
        <span className="text-xs text-gray-400">{isNew ? 'New Note' : 'Edit Note'}</span>
      </div>

      {/* Title input */}
      <div className="mb-3">
        <input
          ref={titleRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Note title (auto-generated if left empty)..."
          className={`w-full px-3 py-2.5 text-base font-medium border rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 ${
            titleError
              ? 'border-red-400 focus:border-red-400 focus:ring-red-400/30'
              : 'border-gray-200 dark:border-gray-700 focus:border-emerald-400 focus:ring-emerald-400/30'
          }`}
        />
        {titleError && (
          <p className="mt-1 text-xs text-red-500">Please enter a title or some content to save.</p>
        )}
      </div>

      {/* Language selector + mic toggle row */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-gray-400" />
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            disabled={isListening}
            className="text-sm border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 focus:outline-none focus:border-emerald-400 disabled:opacity-50"
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </div>

        {speechSupported && (
          <button
            onClick={toggleMic}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              isListening
                ? 'bg-red-500 hover:bg-red-600 text-white'
                : 'bg-emerald-500 hover:bg-emerald-600 text-white'
            }`}
          >
            {isListening ? (
              <><MicOff size={14} /> Stop Recording</>
            ) : (
              <><Mic size={14} /> Start Recording</>
            )}
          </button>
        )}

        {isListening && (
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
            <span className="text-xs text-red-500 font-medium">Listening...</span>
          </div>
        )}
      </div>

      {/* Speech error */}
      {speechError && (
        <div className="flex items-start gap-2 px-3 py-2.5 mb-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <AlertTriangle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-xs text-red-600 dark:text-red-400 whitespace-pre-line">{speechError}</p>
            <button
              onClick={toggleMic}
              className="mt-1.5 px-2.5 py-1 bg-red-500 hover:bg-red-600 text-white text-[11px] font-medium rounded transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      )}

      {/* Textarea for content */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={isListening ? 'Speak now — your words will appear here...' : 'Type your note here, or use the microphone to dictate...'}
        rows={10}
        className="w-full px-3 py-3 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 resize-y focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/30 font-mono leading-relaxed"
      />

      {/* Interim transcript preview */}
      {interim && (
        <div className="mt-1 px-3 py-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-dashed border-gray-300 dark:border-gray-600">
          <span className="text-xs text-gray-400 italic">{interim}</span>
        </div>
      )}

      {/* AI Processing Section */}
      {content.trim() && !isListening && (
        <div className="mt-4 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-gradient-to-r from-violet-50 to-indigo-50 dark:from-violet-900/10 dark:to-indigo-900/10 border-b border-gray-200 dark:border-gray-700">
            <p className="text-xs font-semibold text-violet-700 dark:text-violet-400 flex items-center gap-1.5">
              <Sparkles size={13} /> AI Enhancement
            </p>
          </div>
          <div className="p-3">
            {/* Process type buttons */}
            <div className="flex flex-wrap gap-1.5 mb-3">
              {AI_PROCESS_TYPES.map((pt) => (
                <button
                  key={pt.id}
                  onClick={() => handleAiProcess(pt.id)}
                  disabled={aiProcessing}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border disabled:opacity-50 ${
                    aiProcessType === pt.id && aiProcessing
                      ? 'bg-violet-100 border-violet-300 text-violet-700 dark:bg-violet-900/30 dark:border-violet-700 dark:text-violet-400'
                      : pt.color === 'emerald' ? 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/20 dark:border-emerald-800'
                      : pt.color === 'blue' ? 'text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100 dark:text-blue-400 dark:bg-blue-900/20 dark:border-blue-800'
                      : pt.color === 'violet' ? 'text-violet-700 bg-violet-50 border-violet-200 hover:bg-violet-100 dark:text-violet-400 dark:bg-violet-900/20 dark:border-violet-800'
                      : 'text-amber-700 bg-amber-50 border-amber-200 hover:bg-amber-100 dark:text-amber-400 dark:bg-amber-900/20 dark:border-amber-800'
                  }`}
                >
                  {aiProcessType === pt.id && aiProcessing ? (
                    <div className="w-3 h-3 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
                  ) : (
                    <pt.icon size={12} />
                  )}
                  {pt.label}
                </button>
              ))}
            </div>

            {/* AI Error */}
            {aiError && (
              <div className="flex items-start gap-2 px-3 py-2 mb-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <AlertTriangle size={12} className="text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-red-600 dark:text-red-400">{aiError}</p>
              </div>
            )}

            {/* AI Result */}
            {aiResult && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {(() => {
                    const pt = AI_PROCESS_TYPES.find((p) => p.id === aiProcessType);
                    return pt ? (
                      <span className="text-[10px] font-medium text-violet-600 bg-violet-50 dark:bg-violet-900/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <pt.icon size={10} /> {pt.label}
                      </span>
                    ) : null;
                  })()}
                  <span className="text-[10px] text-gray-400">AI Processed</span>
                </div>
                <div className="bg-violet-50/50 dark:bg-violet-900/10 border border-violet-200 dark:border-violet-800 rounded-lg p-3 max-h-[200px] overflow-y-auto text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
                  {aiResult}
                </div>
                <div className="flex gap-1.5">
                  <button onClick={handleUseAiResult} className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-500 hover:bg-violet-600 text-white rounded-lg text-xs font-medium transition-colors">
                    <Check size={12} /> Use This
                  </button>
                  <button onClick={handleCopyAiResult} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-lg text-xs font-medium transition-colors">
                    {aiCopied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                  </button>
                  <button onClick={() => { setAiResult(''); setAiProcessType(null); }} className="flex items-center gap-1.5 px-3 py-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs transition-colors">
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Save error */}
      {saveError && (
        <div className="flex items-center gap-2 px-3 py-2 mt-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <AlertTriangle size={14} className="text-red-500 flex-shrink-0" />
          <span className="text-xs text-red-600 dark:text-red-400">{saveError}</span>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center justify-between mt-4">
        <div className="text-xs text-gray-400">
          {dirty && <span className="text-amber-500 font-medium">Unsaved changes</span>}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            <Save size={14} /> {saving ? 'Saving...' : 'Save Note'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── NotesList ────────────────────────────────────────────────
function NotesList({ notes, loading, searchQuery, onSearchChange, onEdit, onDelete, onNew }) {
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const filtered = notes.filter(
    (n) =>
      !searchQuery ||
      n.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      n.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const formatDuration = (secs) => {
    if (!secs) return '';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/notes/${id}`);
      onDelete(id);
      setDeleteConfirm(null);
      if (expandedId === id) setExpandedId(null);
      // Notify other surfaces (VoiceNotes panel) so their lists refresh.
      window.dispatchEvent(new CustomEvent('notes:changed', { detail: { action: 'deleted', id } }));
    } catch (err) {
      console.error('Failed to delete note:', err);
    }
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Mic size={24} className="text-emerald-500" />
            My Notes
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {notes.length} note{notes.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={onNew}
          className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
        >
          <Plus size={14} /> New Note
        </button>
      </div>

      {/* Unsupported browser warning */}
      {!isSpeechSupported() && (
        <div className="flex items-center gap-3 px-4 py-3 mb-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl">
          <AlertTriangle size={16} className="text-amber-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              Speech-to-Text not supported
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
              Your browser does not support the Web Speech API. Voice dictation is unavailable.
              Please use <strong>Google Chrome</strong> or <strong>Microsoft Edge</strong> for
              full functionality. You can still create and edit text notes.
            </p>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search notes..."
          className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 placeholder:text-gray-400 focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/30"
        />
      </div>

      {/* Notes list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-xl p-5 border border-gray-100 dark:border-gray-800 animate-pulse">
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-2" />
              <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-1/4" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <Mic size={40} className="text-gray-300 dark:text-gray-600 mx-auto mb-3" />
          <p className="text-sm text-gray-400">
            {searchQuery ? 'No notes match your search.' : 'No notes yet. Create a new note to get started.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((note) => {
            const isExpanded = expandedId === note.id;
            const badge = TYPE_BADGES[note.type] || TYPE_BADGES.text_note;
            const langLabel = LANGUAGES.find((l) => l.value === note.lang)?.label;

            return (
              <div key={note.id} className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl overflow-hidden hover:border-gray-200 dark:hover:border-gray-700 transition-colors shadow-sm">
                <div className="flex items-center gap-3 px-5 py-3.5 cursor-pointer" onClick={() => setExpandedId(isExpanded ? null : note.id)}>
                  <ChevronDown size={14} className={`text-gray-400 transition-transform flex-shrink-0 ${isExpanded ? '' : '-rotate-90'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{note.title}</p>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ color: badge.color, backgroundColor: badge.bg }}>{badge.label}</span>
                      {langLabel && <span className="text-[10px] text-gray-400 flex-shrink-0">{langLabel}</span>}
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-0.5">
                      <span>{formatDate(note.createdAt)}</span>
                      {note.duration > 0 && <span className="flex items-center gap-1"><Clock size={10} /> {formatDuration(note.duration)}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => onEdit(note)} className="p-1.5 text-gray-400 hover:text-blue-500 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" title="Edit note">
                      <Edit3 size={13} />
                    </button>
                    <button onClick={() => setDeleteConfirm(note.id)} className="p-1.5 text-gray-400 hover:text-red-500 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" title="Delete note">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="px-5 pb-4 border-t border-gray-100 dark:border-gray-800 pt-3">
                    <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                      {note.content || <span className="italic text-gray-400">No content</span>}
                    </p>
                  </div>
                )}
                {deleteConfirm === note.id && (
                  <div className="px-5 pb-3 flex items-center gap-2 text-xs">
                    <span className="text-red-500 font-medium">Delete this note?</span>
                    <button onClick={() => handleDelete(note.id)} className="px-2 py-1 bg-red-500 text-white rounded text-[11px] font-medium hover:bg-red-600 transition-colors">Yes, delete</button>
                    <button onClick={() => setDeleteConfirm(null)} className="px-2 py-1 text-gray-500 hover:text-gray-700 text-[11px] transition-colors">Cancel</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ─── NotesPage (parent) ──────────────────────────────────────
export default function NotesPage() {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [view, setView] = useState('list');
  const [editingNote, setEditingNote] = useState(null);

  useEffect(() => { loadNotes(); }, []);

  // Cross-surface invalidation: when any other component (e.g. the Voice
  // Notes panel) creates/deletes a note, it dispatches `notes:changed` so
  // this list refetches without a page reload.
  useEffect(() => {
    const handler = () => loadNotes();
    window.addEventListener('notes:changed', handler);
    return () => window.removeEventListener('notes:changed', handler);
  }, []);

  async function loadNotes() {
    setLoading(true);
    if (window.__NOTES_DEBUG__) console.log('[NotesPage] loadNotes starting...');
    try {
      const res = await api.get('/notes/my');
      if (window.__NOTES_DEBUG__) console.log('[NotesPage] loadNotes response:', res.data);
      setNotes(res.data.notes || []);
    } catch (err) {
      console.error('[NotesPage] loadNotes failed:', err?.response?.status, err?.response?.data || err.message);
    } finally {
      setLoading(false);
    }
  }

  const handleNew = () => { setEditingNote(null); setView('editor'); };
  const handleEdit = (note) => { setEditingNote(note); setView('editor'); };
  const handleSaved = () => { loadNotes(); setView('list'); setEditingNote(null); };
  const handleCancel = () => { setView('list'); setEditingNote(null); };
  const handleDelete = (id) => { setNotes((prev) => prev.filter((n) => n.id !== id)); };

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {view === 'editor' ? (
        <NoteEditor note={editingNote} onSaved={handleSaved} onCancel={handleCancel} />
      ) : (
        <NotesList
          notes={notes} loading={loading} searchQuery={searchQuery}
          onSearchChange={setSearchQuery} onEdit={handleEdit} onDelete={handleDelete} onNew={handleNew}
        />
      )}
    </div>
  );
}
