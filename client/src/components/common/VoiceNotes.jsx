import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Mic, Square, X, ChevronDown, ChevronUp, Clock, FileText,
  Trash2, Save, Settings, AlertCircle, Shield, AlertTriangle,
  Sparkles, List, CheckSquare, FileText as FileTextIcon,
  Users, UserPlus, ArrowRight, RotateCcw, Copy, Check, Edit2, Headphones,
} from 'lucide-react';
import api from '../../services/api';
import useSpeechToText from '../../hooks/useSpeechToText';
import useMeetingTranscription from '../../hooks/useMeetingTranscription';

const DEFAULT_SETTINGS = {
  language: 'en-US',
  continuous: true,
  maxSilenceDuration: 'none',
  highAccuracyMode: false,
};

// Stable palette for speaker bubbles.
const SPEAKER_COLORS = [
  { bg: 'bg-emerald-50', text: 'text-emerald-700', dark: 'dark:bg-emerald-900/30 dark:text-emerald-300', dot: 'bg-emerald-500' },
  { bg: 'bg-violet-50',  text: 'text-violet-700',  dark: 'dark:bg-violet-900/30 dark:text-violet-300',   dot: 'bg-violet-500' },
  { bg: 'bg-amber-50',   text: 'text-amber-700',   dark: 'dark:bg-amber-900/30 dark:text-amber-300',    dot: 'bg-amber-500' },
  { bg: 'bg-blue-50',    text: 'text-blue-700',    dark: 'dark:bg-blue-900/30 dark:text-blue-300',      dot: 'bg-blue-500' },
  { bg: 'bg-rose-50',    text: 'text-rose-700',    dark: 'dark:bg-rose-900/30 dark:text-rose-300',      dot: 'bg-rose-500' },
  { bg: 'bg-cyan-50',    text: 'text-cyan-700',    dark: 'dark:bg-cyan-900/30 dark:text-cyan-300',      dot: 'bg-cyan-500' },
];
function speakerColor(label, mapRef) {
  const map = mapRef.current;
  if (map.has(label)) return SPEAKER_COLORS[map.get(label) % SPEAKER_COLORS.length];
  const idx = map.size;
  map.set(label, idx);
  return SPEAKER_COLORS[idx % SPEAKER_COLORS.length];
}

function formatSegmentsAsText(segments, labelOverrides = {}) {
  return segments.map(s => {
    const label = labelOverrides[s.speaker] || s.speaker;
    return `${label}: ${s.text}`;
  }).join('\n');
}

const LANGUAGES = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'es-ES', label: 'Spanish' },
  { value: 'fr-FR', label: 'French' },
  { value: 'de-DE', label: 'German' },
  { value: 'ja-JP', label: 'Japanese' },
  { value: 'zh-CN', label: 'Chinese (Simplified)' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'ar-SA', label: 'Arabic' },
  { value: 'ko-KR', label: 'Korean' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'ru-RU', label: 'Russian' },
];

const SILENCE_OPTIONS = [
  { value: '5', label: '5 seconds' },
  { value: '10', label: '10 seconds' },
  { value: '30', label: '30 seconds' },
  { value: '60', label: '60 seconds' },
  { value: 'none', label: 'No limit' },
];

const PROCESS_TYPES = [
  { id: 'clean', label: 'Clean Transcript', desc: 'Fix grammar, remove filler words', icon: Sparkles, color: 'emerald' },
  { id: 'summarize', label: 'Summarize', desc: 'Key points summary', icon: List, color: 'blue' },
  { id: 'action_items', label: 'Action Items', desc: 'Tasks, decisions, follow-ups', icon: CheckSquare, color: 'violet' },
  { id: 'meeting_notes', label: 'Meeting Notes', desc: 'Formatted meeting notes', icon: FileTextIcon, color: 'amber' },
];

function loadSettings() {
  try {
    const saved = localStorage.getItem('voiceNoteSettings');
    if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettingsToStorage(settings) {
  try {
    localStorage.setItem('voiceNoteSettings', JSON.stringify(settings));
  } catch {}
}

export default function VoiceNotes({ isOpen, onClose }) {
  const [activeTab, setActiveTab] = useState('record');
  // savedTranscript holds the final text the user will save
  // (may include meeting-mode labels or AI-processed text)
  const [savedTranscript, setSavedTranscript] = useState('');
  const [duration, setDuration] = useState(0);
  const [recentNotes, setRecentNotes] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showRecent, setShowRecent] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(loadSettings);
  const [micPermission, setMicPermission] = useState('unknown');

  // Meeting mode state
  const [meetingMode, setMeetingMode] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState(1);

  // High Accuracy Meeting Mode (Deepgram-backed): speaker-labeled segments
  // accumulated via the onFinal callback from useMeetingTranscription.
  const [segments, setSegments] = useState([]);
  const [speakerLabelOverrides, setSpeakerLabelOverrides] = useState({});
  const [renamingSpeaker, setRenamingSpeaker] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const speakerColorMapRef = useRef(new Map());

  // AI processing state
  const [processing, setProcessing] = useState(false);
  const [processType, setProcessType] = useState(null);
  const [processedResult, setProcessedResult] = useState('');
  const [processError, setProcessError] = useState(null);
  const [copied, setCopied] = useState(false);

  const timerRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const liveTranscriptRef = useRef(null);
  const wakeLockRef = useRef(null);

  const highAccuracyMode = !!settings.highAccuracyMode;

  // Both engines are always mounted — they are inert until startListening() is
  // invoked. We pick one at start time based on highAccuracyMode.
  const webSpeech = useSpeechToText({
    lang: settings.language,
    continuous: settings.continuous,
    interimResults: true,
  });
  const meetingStream = useMeetingTranscription();

  const activeEngine = highAccuracyMode ? meetingStream : webSpeech;
  const {
    isListening,
    transcript: hookTranscript,
    interim,
    error: speechError,
    startListening,
    stopListening,
    resetTranscript,
  } = activeEngine;

  // ──────────────────────────────────────────────────────────────
  // VoiceNotes state machine (post-bugfix)
  //
  //   idle ──► recording ──► stopped (transcript visible)
  //     ▲        │                │
  //     │        │         ┌──────┴──────┐
  //     │        │         │             │
  //     │        │    (discard)      (saveNote)
  //     │        │         │             │
  //     │        │         ▼             ▼
  //     │        │       idle        saving (button disabled)
  //     │        │                       │
  //     │        │                   ┌───┴────────┐
  //     │        │                   │            │
  //     │        │                (success)    (error)
  //     │        │                   │            │
  //     └────────┴───────────────────┘            ▼
  //                                           stopped+err
  //
  // Invariants:
  //   • discard + save BOTH wipe: savedTranscript, hookTranscript
  //     (via engine.resetTranscript), segments, overrides, duration.
  //   • Save is idempotent: the click only fires one POST because
  //     `saving` disables the button AND success resets hookTranscript
  //     so the fallback text source is empty on the next click.
  //   • On success we dispatch `notes:changed` so any open NotesPage
  //     refetches — the panel and the main list stay in sync.
  // ──────────────────────────────────────────────────────────────

  const speechSupported = highAccuracyMode
    ? !!(window.AudioContext || window.webkitAudioContext) && !!navigator.mediaDevices?.getUserMedia
    : !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  // The "display transcript" is whichever has content:
  // during recording → hookTranscript (live from the hook)
  // after recording  → savedTranscript (possibly with meeting labels)
  const displayTranscript = isListening ? hookTranscript : (savedTranscript || hookTranscript);

  useEffect(() => { checkMicPermission(); }, []);
  useEffect(() => { if (isOpen) loadRecentNotes(); }, [isOpen]);
  // Keep Recent Notes in sync when another surface (e.g. NotesPage) mutates
  // the note list. Using a window event avoids a dedicated notes context for
  // a single cross-component fan-out.
  useEffect(() => {
    if (!isOpen) return undefined;
    const handler = () => loadRecentNotes();
    window.addEventListener('notes:changed', handler);
    return () => window.removeEventListener('notes:changed', handler);
  }, [isOpen]);
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

  // Auto-scroll live transcript to bottom when content changes
  useEffect(() => {
    if (liveTranscriptRef.current && isListening) {
      liveTranscriptRef.current.scrollTop = liveTranscriptRef.current.scrollHeight;
    }
  }, [hookTranscript, interim, isListening]);

  // savedTranscript is populated via the onFinal callback below (both in
  // meeting mode and normal mode), so no snapshot-on-stop effect is needed.
  // Snapshotting hookTranscript would clobber meeting-mode speaker labels.

  async function checkMicPermission() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const result = await navigator.permissions.query({ name: 'microphone' });
        setMicPermission(result.state);
        result.addEventListener('change', () => setMicPermission(result.state));
        return;
      }
      setMicPermission(navigator.mediaDevices ? 'prompt' : 'denied');
    } catch {
      setMicPermission('prompt');
    }
  }

  async function requestMicPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicPermission('granted');
      return true;
    } catch {
      setMicPermission('denied');
      return false;
    }
  }

  async function loadRecentNotes() {
    try {
      const res = await api.get('/notes/my');
      setRecentNotes((res.data.notes || []).slice(0, 5));
    } catch (err) {
      if (window.__NOTES_DEBUG__) console.error('[VoiceNotes] loadRecentNotes failed:', err);
    }
  }

  const updateSetting = (key, value) => {
    setSettings((prev) => {
      const updated = { ...prev, [key]: value };
      saveSettingsToStorage(updated);
      return updated;
    });
  };

  // Meeting mode refs for use inside the callback (avoids stale closures)
  const meetingModeRef = useRef(meetingMode);
  const currentSpeakerRef = useRef(currentSpeaker);
  const silenceDurationRef = useRef(settings.maxSilenceDuration);
  useEffect(() => { meetingModeRef.current = meetingMode; }, [meetingMode]);
  useEffect(() => { currentSpeakerRef.current = currentSpeaker; }, [currentSpeaker]);
  useEffect(() => { silenceDurationRef.current = settings.maxSilenceDuration; }, [settings.maxSilenceDuration]);

  // Called by the active engine for each finalized speech chunk.
  //   - useSpeechToText passes a string (legacy, Web Speech mode)
  //   - useMeetingTranscription passes { speaker, text, startMs, endMs }
  // We persist segments for the Deepgram path and plain text for Web Speech.
  const handleFinalTranscript = useCallback((payload) => {
    if (payload == null) return;

    const isSegment = typeof payload === 'object' && typeof payload.text === 'string';
    const rawText = isSegment ? payload.text : String(payload);

    // High Accuracy path: append a speaker segment and mirror text into the
    // plain transcript so AI processing / save still see readable content.
    if (isSegment) {
      setSegments(prev => [...prev, {
        speaker: payload.speaker || 'Speaker 0',
        text: rawText,
        startMs: payload.startMs || 0,
        endMs: payload.endMs || 0,
      }]);
    }

    setSavedTranscript((prev) => {
      // Safety net: if the incoming chunk is already a trailing suffix of the
      // existing transcript (can happen after auto-restart replays or buggy
      // mobile engines re-emitting cumulative text), drop it to prevent
      // duplicated phrases from accumulating.
      const chunkTrim = rawText.trim();
      if (chunkTrim) {
        const prevTail = prev.trimEnd().toLowerCase();
        if (prevTail.endsWith(chunkTrim.toLowerCase())) return prev;
      }
      if (isSegment) {
        const label = payload.speaker || 'Speaker 0';
        const tag = `[${label}]`;
        const lastSpeakerMatch = prev.match(/\[[^\]]+\][^[]*$/);
        if (!lastSpeakerMatch || !lastSpeakerMatch[0].startsWith(tag)) {
          const sep = prev ? '\n' : '';
          return prev + sep + tag + ': ' + rawText;
        }
        const sep = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
        return prev + sep + rawText;
      }
      if (meetingModeRef.current) {
        const speaker = currentSpeakerRef.current;
        const speakerTag = `[Speaker ${speaker}]`;
        const lastSpeakerMatch = prev.match(/\[Speaker \d+\][^[]*$/);
        if (!lastSpeakerMatch || !lastSpeakerMatch[0].startsWith(speakerTag)) {
          const sep = prev ? '\n' : '';
          return prev + sep + speakerTag + ': ' + rawText;
        }
        const sep = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
        return prev + sep + rawText;
      }
      const sep = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
      return prev + sep + rawText;
    });

    // Reset silence auto-stop timer on any speech, regardless of mode
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    const maxSilence = silenceDurationRef.current;
    if (maxSilence !== 'none') {
      const ms = parseInt(maxSilence) * 1000;
      silenceTimerRef.current = setTimeout(() => handleStopRecording(), ms);
    }
  }, []);

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && navigator.wakeLock?.request) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch { /* permission denied or not supported — non-fatal */ }
  }

  function releaseWakeLock() {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (lock && typeof lock.release === 'function') {
      try { lock.release(); } catch { /* ignore */ }
    }
  }

  const handleStartRecording = useCallback(async () => {
    if (!speechSupported) return;

    if (micPermission !== 'granted') {
      const granted = await requestMicPermission();
      if (!granted) return;
    }

    setSaveError(null);
    setSavedTranscript('');
    setSegments([]);
    setSpeakerLabelOverrides({});
    speakerColorMapRef.current = new Map();
    setProcessedResult('');
    setProcessError(null);
    setActiveTab('record');

    startListening(handleFinalTranscript);
    acquireWakeLock();

    setDuration(0);
    timerRef.current = setInterval(() => setDuration((p) => p + 1), 1000);

    const maxSilence = silenceDurationRef.current;
    if (maxSilence !== 'none') {
      const ms = parseInt(maxSilence) * 1000;
      silenceTimerRef.current = setTimeout(() => handleStopRecording(), ms);
    }

    setShowSettings(false);
  }, [speechSupported, micPermission, startListening, handleFinalTranscript]);

  const handleStopRecording = useCallback(() => {
    stopListening();
    releaseWakeLock();
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
  }, [stopListening]);

  // Re-acquire wake lock when the tab returns to foreground during recording.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible' && isListening && !wakeLockRef.current) {
        acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [isListening]);

  const handleNextSpeaker = () => {
    setCurrentSpeaker((prev) => prev + 1);
  };

  // AI Processing
  const handleProcess = async (type) => {
    const textToProcess = savedTranscript || hookTranscript;
    if (!textToProcess.trim()) return;
    setProcessType(type);
    setProcessing(true);
    setProcessError(null);
    setProcessedResult('');
    setActiveTab('process');

    try {
      const res = await api.post('/notes/process', {
        text: textToProcess,
        processType: type,
      });
      setProcessedResult(res.data?.result || '');
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to process transcript. Is AI configured?';
      setProcessError(msg);
    } finally {
      setProcessing(false);
    }
  };

  const handleCopyResult = () => {
    const text = processedResult || savedTranscript || hookTranscript;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleUseProcessed = () => {
    if (processedResult) {
      setSavedTranscript(processedResult);
      setProcessedResult('');
      setActiveTab('record');
    }
  };

  const saveNote = async (content) => {
    // Prefer the speaker-labeled rendering when segments exist so the saved
    // content matches what the user sees on screen.
    const segmentText = segments.length
      ? formatSegmentsAsText(segments, speakerLabelOverrides)
      : '';
    const text = (content || segmentText || savedTranscript || hookTranscript).trim();
    if (!text) return;

    setSaving(true);
    setSaveError(null);

    const title = text.length > 60 ? text.substring(0, 60) + '...' : text;
    const payload = { title, content: text, duration, type: 'voice_note', lang: settings.language };

    try {
      const res = await api.post('/notes', payload);
      const noteId = res.data?.data?.id || res.data?.id || res.data?.note?.id;
      // Persist raw segments so the speaker-rename endpoint can operate on a
      // structured row set (separate from the rendered `content` text).
      if (noteId && segments.length) {
        const payload2 = {
          segments: segments.map(s => ({
            speakerLabel: speakerLabelOverrides[s.speaker] || s.speaker,
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
          })),
        };
        try { await api.post(`/notes/${noteId}/segments`, payload2); }
        catch (segErr) { console.warn('[VoiceNotes] segments save failed:', segErr?.message); }
      }
      setSavedTranscript('');
      setSegments([]);
      setSpeakerLabelOverrides({});
      speakerColorMapRef.current = new Map();
      setProcessedResult('');
      setDuration(0);
      setActiveTab('record');
      // Wipe the engine-owned transcript too — otherwise hookTranscript would
      // still be non-empty, the saved-transcript view would stay visible, and
      // a second click on Save Raw would POST the same content again (Bug 3).
      resetTranscript();
      loadRecentNotes();
      // Signal any open NotesPage (or other listeners) to refetch so the main
      // list stays in sync with what was just persisted (Bug 2).
      window.dispatchEvent(new CustomEvent('notes:changed', { detail: { action: 'created' } }));
    } catch (err) {
      const backendMsg = err?.response?.data?.message;
      setSaveError(backendMsg || 'Save failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleRenameSpeaker = (speaker) => {
    setRenamingSpeaker(speaker);
    setRenameValue(speakerLabelOverrides[speaker] || speaker);
  };

  const handleConfirmRename = () => {
    const from = renamingSpeaker;
    const to = renameValue.trim();
    if (!from || !to || to === from) {
      setRenamingSpeaker(null);
      setRenameValue('');
      return;
    }
    // Local update is immediate — the remote PATCH happens after save once we
    // have a noteId, via the rename-speaker endpoint.
    setSpeakerLabelOverrides(prev => ({ ...prev, [from]: to }));
    setRenamingSpeaker(null);
    setRenameValue('');
  };

  const deleteNote = async (noteId) => {
    try {
      await api.delete(`/notes/${noteId}`);
      setRecentNotes((prev) => prev.filter((n) => n.id !== noteId));
      window.dispatchEvent(new CustomEvent('notes:changed', { detail: { action: 'deleted', id: noteId } }));
    } catch {}
  };

  const discardAll = () => {
    setSavedTranscript('');
    setSegments([]);
    setSpeakerLabelOverrides({});
    speakerColorMapRef.current = new Map();
    setProcessedResult('');
    setDuration(0);
    setSaveError(null);
    setProcessError(null);
    setCurrentSpeaker(1);
    setActiveTab('record');
    // Clear the engine-owned transcript so hasTranscript flips to false and
    // the panel falls back to the idle "Tap to start recording" view (Bug 1).
    resetTranscript();
  };

  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  const fmtDate = (d) => {
    const diff = Date.now() - new Date(d);
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(d).toLocaleDateString();
  };

  const handleClose = () => {
    if (isListening) handleStopRecording();
    setShowSettings(false);
    onClose();
  };

  if (!isOpen) return null;

  const hasTranscript = (savedTranscript || hookTranscript).trim().length > 0;
  const hasProcessedResult = processedResult.trim().length > 0;

  return (
    <div
      className="fixed z-[9998] bottom-2 right-2 left-2 sm:left-auto sm:bottom-[76px] sm:right-4"
      style={{
        animation: 'voicePanelSlideIn 250ms cubic-bezier(0.16,1,0.3,1) both',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      <style>{`
        @keyframes voicePanelSlideIn {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes voicePulse {
          0%, 100% { transform: scaleY(0.4); }
          50%      { transform: scaleY(1); }
        }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>
      <div className="w-full sm:w-[340px] max-h-[min(calc(100vh-24px),calc(100vh-100px))] sm:max-h-[calc(100vh-100px)] bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-emerald-500 to-teal-500 text-white flex-shrink-0">
          <div className="flex items-center gap-2">
            <Mic size={16} />
            <span className="font-semibold text-sm">Voice Notes</span>
          </div>
          <div className="flex items-center gap-1">
            {!isListening && (
              <button onClick={() => setShowSettings(!showSettings)} className={`p-1 rounded-md transition-colors ${showSettings ? 'bg-white/30' : 'hover:bg-white/20'}`}>
                <Settings size={14} />
              </button>
            )}
            <button onClick={handleClose} className="p-1 hover:bg-white/20 rounded-md transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Tabs — show when we have a transcript and not recording */}
        {hasTranscript && !isListening && (
          <div className="flex border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <button
              onClick={() => setActiveTab('record')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                activeTab === 'record'
                  ? 'text-emerald-600 border-b-2 border-emerald-500 bg-emerald-50/50 dark:bg-emerald-900/10'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <Mic size={12} /> Record
              </div>
            </button>
            <button
              onClick={() => setActiveTab('process')}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                activeTab === 'process'
                  ? 'text-violet-600 border-b-2 border-violet-500 bg-violet-50/50 dark:bg-violet-900/10'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <Sparkles size={12} /> AI Process
              </div>
            </button>
          </div>
        )}

        {/* Banners */}
        {!speechSupported && (
          <div className="px-4 py-3 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 flex-shrink-0">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-amber-500 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-400">Speech not supported. Use Chrome or Edge.</p>
            </div>
          </div>
        )}
        {speechSupported && micPermission === 'denied' && (
          <div className="px-4 py-3 bg-red-50 dark:bg-red-900/30 border-b border-red-200 dark:border-red-800 flex-shrink-0">
            <div className="flex items-start gap-2">
              <Shield size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-red-700 dark:text-red-400">Microphone access denied. Allow in browser settings.</p>
            </div>
          </div>
        )}
        {speechSupported && micPermission === 'prompt' && !isListening && !showSettings && activeTab === 'record' && (
          <div className="px-4 py-3 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 flex-shrink-0">
            <div className="flex items-start gap-2">
              <AlertCircle size={14} className="text-amber-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-[11px] text-amber-700 dark:text-amber-400">Microphone permission required.</p>
                <button onClick={requestMicPermission} className="mt-1.5 px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-medium rounded-md transition-colors">Allow Microphone</button>
              </div>
            </div>
          </div>
        )}
        {speechError && (
          <div className="px-4 py-2.5 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 flex-shrink-0">
            <div className="flex items-start gap-2">
              <AlertTriangle size={12} className="text-red-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-[11px] text-red-600 dark:text-red-400 whitespace-pre-line">{speechError}</p>
                <button onClick={handleStartRecording} className="mt-1.5 px-2.5 py-1 bg-red-500 hover:bg-red-600 text-white text-[10px] font-medium rounded transition-colors">Try Again</button>
              </div>
            </div>
          </div>
        )}

        {/* Settings */}
        {showSettings && !isListening && activeTab === 'record' && (
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 space-y-3 overflow-y-auto flex-shrink-0" style={{ maxHeight: 'min(280px, 40vh)' }}>
            <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Settings</p>
            <div>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1 block">Language</label>
              <select value={settings.language} onChange={(e) => updateSetting('language', e.target.value)} className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 focus:outline-none focus:border-emerald-400">
                {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 block">Continuous Mode</label>
                <p className="text-[10px] text-gray-400">Keep recording during pauses</p>
              </div>
              <button onClick={() => updateSetting('continuous', !settings.continuous)} className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${settings.continuous ? 'bg-emerald-500 justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'}`}>
                <div className="w-4 h-4 rounded-full bg-white shadow-sm" />
              </button>
            </div>
            <div>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1 block">Auto-stop on silence</label>
              <select value={settings.maxSilenceDuration} onChange={(e) => updateSetting('maxSilenceDuration', e.target.value)} className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 focus:outline-none focus:border-emerald-400">
                {SILENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between pt-1">
              <div>
                <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 block flex items-center gap-1">
                  <Users size={11} /> Meeting Mode (manual)
                </label>
                <p className="text-[10px] text-gray-400">Tag speakers sequentially (Next Speaker button)</p>
              </div>
              <button
                disabled={highAccuracyMode}
                onClick={() => { setMeetingMode(!meetingMode); setCurrentSpeaker(1); }}
                className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${meetingMode && !highAccuracyMode ? 'bg-violet-500 justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'} ${highAccuracyMode ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className="w-4 h-4 rounded-full bg-white shadow-sm" />
              </button>
            </div>
            <div className="flex items-center justify-between pt-1 border-t border-gray-200 dark:border-gray-700 mt-2">
              <div>
                <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 block flex items-center gap-1">
                  <Headphones size={11} /> High Accuracy Meeting Mode
                </label>
                <p className="text-[10px] text-gray-400">Deepgram streaming with automatic speaker diarization</p>
              </div>
              <button
                onClick={() => updateSetting('highAccuracyMode', !highAccuracyMode)}
                className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${highAccuracyMode ? 'bg-emerald-500 justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'}`}
              >
                <div className="w-4 h-4 rounded-full bg-white shadow-sm" />
              </button>
            </div>
            <p className="text-[9px] text-gray-400 italic">
              {highAccuracyMode
                ? 'Deepgram Live · Admin must configure a provider in Integrations'
                : 'Web Speech API · Chrome/Edge recommended'}
            </p>
          </div>
        )}

        {/* ─── RECORD TAB ────────────────────────────────────────── */}
        {activeTab === 'record' && (
          <div className="p-4 overflow-y-auto flex-1 min-h-0">
            {isListening ? (
              <div className="space-y-3">
                {/* Recording header */}
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                  <span className="text-sm font-medium text-red-600 dark:text-red-400">Recording</span>
                  <span className="text-sm text-gray-500 ml-auto font-mono">{fmt(duration)}</span>
                </div>

                {/* Meeting mode speaker controls (legacy manual mode only) */}
                {meetingMode && !highAccuracyMode && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-medium text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30 px-2 py-1 rounded-full flex items-center gap-1">
                      <Users size={10} /> Speaker {currentSpeaker}
                    </span>
                    <button
                      onClick={handleNextSpeaker}
                      className="flex items-center gap-1 text-[10px] font-medium text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 px-2 py-1 rounded-full border border-violet-200 dark:border-violet-800 transition-colors"
                    >
                      <UserPlus size={10} /> Next Speaker
                    </button>
                  </div>
                )}
                {highAccuracyMode && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-1 rounded-full flex items-center gap-1">
                      <Headphones size={10} /> High Accuracy · Auto-diarization
                    </span>
                  </div>
                )}

                {/* Audio level bars */}
                <div className="flex items-end justify-center gap-0.5 h-6">
                  {[0.3, 0.5, 0.8, 1, 0.7, 0.9, 0.4, 0.6, 1, 0.5, 0.7, 0.3].map((d, i) => (
                    <div
                      key={i}
                      className="w-1 bg-emerald-500 rounded-full"
                      style={{
                        animation: `voicePulse ${0.4 + d * 0.4}s ease-in-out ${i * 0.05}s infinite`,
                        height: '100%',
                      }}
                    />
                  ))}
                </div>

                {/* ── LIVE TRANSCRIPT ─────────────────────────────── */}
                <div ref={liveTranscriptRef} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 min-h-[80px] max-h-[220px] overflow-y-auto text-sm text-gray-700 dark:text-gray-300 space-y-1.5">
                  {highAccuracyMode && segments.length > 0 ? (
                    <>
                      {segments.map((seg, i) => {
                        const c = speakerColor(seg.speaker, speakerColorMapRef);
                        const label = speakerLabelOverrides[seg.speaker] || seg.speaker;
                        return (
                          <div key={i} className={`rounded-lg px-2.5 py-1.5 ${c.bg} ${c.dark}`}>
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                              <span className={`text-[10px] font-semibold ${c.text}`}>{label}</span>
                            </div>
                            <p className="text-[13px] leading-snug">{seg.text}</p>
                          </div>
                        );
                      })}
                      {interim && <p className="text-gray-400 italic text-[12px]">{interim}</p>}
                    </>
                  ) : (
                    <>
                      {hookTranscript && <span className="whitespace-pre-wrap">{hookTranscript} </span>}
                      {interim && <span className="text-gray-400 italic">{interim}</span>}
                      {!hookTranscript && !interim && (
                        <span className="text-gray-400 italic">Listening... speak now</span>
                      )}
                    </>
                  )}
                </div>

                <button onClick={handleStopRecording} className="w-full flex items-center justify-center gap-2 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors">
                  <Square size={14} /> Stop
                </button>
              </div>
            ) : hasTranscript ? (
              <div className="space-y-3">
                {/* Stopped: show saved transcript — segment bubbles in high-accuracy mode */}
                {segments.length > 0 ? (
                  <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 min-h-[60px] max-h-[220px] overflow-y-auto text-sm text-gray-700 dark:text-gray-300 space-y-1.5">
                    {segments.map((seg, i) => {
                      const c = speakerColor(seg.speaker, speakerColorMapRef);
                      const label = speakerLabelOverrides[seg.speaker] || seg.speaker;
                      const isRenaming = renamingSpeaker === seg.speaker;
                      return (
                        <div key={i} className={`rounded-lg px-2.5 py-1.5 ${c.bg} ${c.dark}`}>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                            {isRenaming ? (
                              <input
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') handleConfirmRename();
                                  if (e.key === 'Escape') { setRenamingSpeaker(null); setRenameValue(''); }
                                }}
                                onBlur={handleConfirmRename}
                                autoFocus
                                className={`text-[10px] font-semibold ${c.text} bg-transparent border-b border-current outline-none w-32`}
                              />
                            ) : (
                              <button
                                onClick={() => handleRenameSpeaker(seg.speaker)}
                                className={`text-[10px] font-semibold ${c.text} hover:underline flex items-center gap-1`}
                                title="Click to rename speaker"
                              >
                                {label} <Edit2 size={9} />
                              </button>
                            )}
                          </div>
                          <p className="text-[13px] leading-snug">{seg.text}</p>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 min-h-[60px] max-h-[120px] overflow-y-auto text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                    {savedTranscript || hookTranscript}
                  </div>
                )}
                <div className="flex items-center gap-1 text-xs text-gray-400"><Clock size={11} /><span>{fmt(duration)}</span></div>

                {/* AI Processing buttons */}
                <div>
                  <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wider mb-2">AI Enhancement</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {PROCESS_TYPES.map((pt) => (
                      <button
                        key={pt.id}
                        onClick={() => handleProcess(pt.id)}
                        disabled={processing}
                        className={`flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-[11px] font-medium transition-all border hover:shadow-sm disabled:opacity-50 ${
                          pt.color === 'emerald' ? 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100 dark:text-emerald-400 dark:bg-emerald-900/20 dark:border-emerald-800' :
                          pt.color === 'blue' ? 'text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100 dark:text-blue-400 dark:bg-blue-900/20 dark:border-blue-800' :
                          pt.color === 'violet' ? 'text-violet-700 bg-violet-50 border-violet-200 hover:bg-violet-100 dark:text-violet-400 dark:bg-violet-900/20 dark:border-violet-800' :
                          'text-amber-700 bg-amber-50 border-amber-200 hover:bg-amber-100 dark:text-amber-400 dark:bg-amber-900/20 dark:border-amber-800'
                        }`}
                      >
                        <pt.icon size={12} />
                        <span className="truncate">{pt.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {saveError && <div className="flex items-center gap-2 text-xs text-red-500"><AlertTriangle size={12} /><span>{saveError}</span></div>}

                <div className="flex gap-2">
                  <button onClick={() => saveNote()} disabled={saving} className="flex-1 flex items-center justify-center gap-2 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                    <Save size={14} /> {saving ? 'Saving...' : 'Save Raw'}
                  </button>
                  <button onClick={discardAll} className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-lg text-sm transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-center py-4">
                <button onClick={handleStartRecording} disabled={!speechSupported || micPermission === 'denied'} className={`w-16 h-16 rounded-full text-white flex items-center justify-center mx-auto shadow-lg transition-all transform hover:scale-105 ${!speechSupported || micPermission === 'denied' ? 'bg-gray-400 cursor-not-allowed' : 'bg-gradient-to-br from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 hover:shadow-xl'}`}>
                  <Mic size={24} />
                </button>
                <p className="text-xs text-gray-400 mt-3">
                  {!speechSupported ? 'Browser not supported' : micPermission === 'denied' ? 'Microphone access required' : 'Tap to start recording'}
                </p>
                {meetingMode && (
                  <p className="text-[10px] text-violet-500 mt-1 flex items-center justify-center gap-1">
                    <Users size={10} /> Meeting Mode active
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ─── AI PROCESS TAB ────────────────────────────────────── */}
        {activeTab === 'process' && (
          <div className="p-4 overflow-y-auto flex-1 min-h-0">
            {processing ? (
              <div className="space-y-3 py-4">
                <div className="flex items-center justify-center gap-2">
                  <div className="w-5 h-5 border-2 border-violet-200 border-t-violet-500 rounded-full animate-spin" />
                  <span className="text-sm font-medium text-violet-600 dark:text-violet-400">
                    {processType === 'clean' && 'Cleaning transcript...'}
                    {processType === 'summarize' && 'Summarizing...'}
                    {processType === 'action_items' && 'Extracting action items...'}
                    {processType === 'meeting_notes' && 'Formatting meeting notes...'}
                  </span>
                </div>
                <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ background: 'linear-gradient(90deg, #8b5cf6, #a78bfa, #8b5cf6)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite', width: '100%' }} />
                </div>
                <p className="text-[10px] text-gray-400 text-center">Sending to AI provider...</p>
              </div>
            ) : processError ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <AlertTriangle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-[11px] text-red-600 dark:text-red-400 flex-1">{processError}</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => handleProcess(processType)} className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-violet-500 hover:bg-violet-600 text-white rounded-lg text-xs font-medium transition-colors">
                    <RotateCcw size={12} /> Retry
                  </button>
                  <button onClick={() => setActiveTab('record')} className="flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-lg text-xs font-medium transition-colors">
                    <ArrowRight size={12} /> Back
                  </button>
                </div>
              </div>
            ) : hasProcessedResult ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  {(() => {
                    const pt = PROCESS_TYPES.find((p) => p.id === processType);
                    return pt ? (
                      <span className="text-[10px] font-medium text-violet-600 bg-violet-50 dark:bg-violet-900/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                        <pt.icon size={10} /> {pt.label}
                      </span>
                    ) : null;
                  })()}
                  <span className="text-[10px] text-gray-400 ml-auto">AI Processed</span>
                </div>
                <div className="bg-violet-50/50 dark:bg-violet-900/10 border border-violet-200 dark:border-violet-800 rounded-lg p-3 min-h-[80px] max-h-[200px] overflow-y-auto text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                  {processedResult}
                </div>
                <div className="flex gap-1.5">
                  <button onClick={() => saveNote(processedResult)} disabled={saving} className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
                    <Save size={12} /> {saving ? 'Saving...' : 'Save Processed'}
                  </button>
                  <button onClick={handleUseProcessed} className="flex items-center justify-center gap-1.5 px-2.5 py-2 bg-violet-100 hover:bg-violet-200 dark:bg-violet-900/30 dark:hover:bg-violet-900/50 text-violet-700 dark:text-violet-400 rounded-lg text-xs font-medium transition-colors" title="Replace raw with processed">
                    <ArrowRight size={12} />
                  </button>
                  <button onClick={handleCopyResult} className="flex items-center justify-center gap-1.5 px-2.5 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-lg text-xs font-medium transition-colors">
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
                <div>
                  <p className="text-[10px] text-gray-400 mb-1.5">Try another format:</p>
                  <div className="flex flex-wrap gap-1">
                    {PROCESS_TYPES.filter((pt) => pt.id !== processType).map((pt) => (
                      <button key={pt.id} onClick={() => handleProcess(pt.id)} className="text-[10px] text-gray-500 hover:text-violet-600 px-2 py-1 rounded border border-gray-200 dark:border-gray-700 hover:border-violet-300 transition-colors flex items-center gap-1">
                        <pt.icon size={10} /> {pt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3 py-2">
                <p className="text-xs text-gray-500 text-center">Select how to process your transcript</p>
                <div className="space-y-2">
                  {PROCESS_TYPES.map((pt) => (
                    <button key={pt.id} onClick={() => handleProcess(pt.id)} className="w-full flex items-center gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-violet-300 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/10 transition-all text-left">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                        pt.color === 'emerald' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400' :
                        pt.color === 'blue' ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' :
                        pt.color === 'violet' ? 'bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400' :
                        'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'
                      }`}>
                        <pt.icon size={16} />
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300">{pt.label}</p>
                        <p className="text-[10px] text-gray-400">{pt.desc}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Recent notes */}
        <div className="border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
          <button onClick={() => setShowRecent(!showRecent)} className="flex items-center justify-between w-full px-4 py-2.5 text-xs text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <span className="font-medium">Recent Notes ({recentNotes.length})</span>
            {showRecent ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
          {showRecent && recentNotes.length > 0 && (
            <div className="max-h-[200px] overflow-y-auto">
              {recentNotes.map((note) => (
                <div key={note.id} className="flex items-start gap-2 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 group border-t border-gray-100 dark:border-gray-800">
                  <FileText size={13} className="text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-700 dark:text-gray-300 truncate">{note.title}</p>
                    <div className="flex items-center gap-2 text-[10px] text-gray-400 mt-0.5">
                      <span>{fmtDate(note.createdAt)}</span>
                      {note.duration > 0 && <span>{fmt(note.duration)}</span>}
                    </div>
                  </div>
                  <button onClick={() => deleteNote(note.id)} className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all">
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
