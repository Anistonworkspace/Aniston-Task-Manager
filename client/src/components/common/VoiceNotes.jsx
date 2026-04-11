import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Mic, Square, X, ChevronDown, ChevronUp, Clock, FileText,
  Trash2, Save, Settings, AlertCircle, Shield, AlertTriangle,
} from 'lucide-react';
import api from '../../services/api';
import useSpeechToText from '../../hooks/useSpeechToText';

const DEFAULT_SETTINGS = {
  language: 'en-US',
  continuous: true,
  maxSilenceDuration: 'none',
};

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
  const [transcript, setTranscript] = useState('');
  const [duration, setDuration] = useState(0);
  const [recentNotes, setRecentNotes] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showRecent, setShowRecent] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(loadSettings);
  const [micPermission, setMicPermission] = useState('unknown');

  const timerRef = useRef(null);
  const silenceTimerRef = useRef(null);

  const { isListening, interim, error: speechError, startListening, stopListening } =
    useSpeechToText({
      lang: settings.language,
      continuous: settings.continuous,
      interimResults: true,
    });

  const speechSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  useEffect(() => { checkMicPermission(); }, []);
  useEffect(() => { if (isOpen) loadRecentNotes(); }, [isOpen]);
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };
  }, []);

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

  const handleFinalTranscript = useCallback((finalText) => {
    if (window.__SPEECH_DEBUG__) {
      console.log('%c[VoiceNotes] final:', 'color:#f59e0b', JSON.stringify(finalText));
    }
    setTranscript((prev) => {
      const sep = prev.length > 0 && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
      return prev + sep + finalText;
    });

    // Reset silence timer
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (settings.maxSilenceDuration !== 'none') {
      const ms = parseInt(settings.maxSilenceDuration) * 1000;
      silenceTimerRef.current = setTimeout(() => handleStopRecording(), ms);
    }
  }, [settings.maxSilenceDuration]);

  const handleStartRecording = useCallback(async () => {
    if (!speechSupported) return;

    if (micPermission !== 'granted') {
      const granted = await requestMicPermission();
      if (!granted) return;
    }

    setSaveError(null);

    // Start speech recognition — NO separate getUserMedia stream.
    // Opening a second mic stream (for audio level meter) can block
    // Chrome's SpeechRecognition from receiving audio on Windows.
    startListening(handleFinalTranscript);

    setDuration(0);
    timerRef.current = setInterval(() => setDuration((p) => p + 1), 1000);

    if (settings.maxSilenceDuration !== 'none') {
      const ms = parseInt(settings.maxSilenceDuration) * 1000;
      silenceTimerRef.current = setTimeout(() => handleStopRecording(), ms);
    }

    setShowSettings(false);
  }, [speechSupported, micPermission, settings, startListening, handleFinalTranscript]);

  const handleStopRecording = useCallback(() => {
    stopListening();
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
  }, [stopListening]);

  const saveNote = async () => {
    const content = transcript.trim();
    if (!content) return;

    setSaving(true);
    setSaveError(null);

    const title = content.length > 60 ? content.substring(0, 60) + '...' : content;
    const payload = { title, content, duration, type: 'voice_note', lang: settings.language };

    if (window.__NOTES_DEBUG__) {
      console.log('[VoiceNotes] saveNote payload:', payload);
    }

    try {
      const res = await api.post('/notes', payload);
      if (window.__NOTES_DEBUG__) {
        console.log('[VoiceNotes] saveNote success:', res.data);
      }
      setTranscript('');
      setDuration(0);
      loadRecentNotes();
    } catch (err) {
      console.error('[VoiceNotes] save failed:', err);
      // Show the actual backend error message, not a generic one
      const backendMsg = err?.response?.data?.message;
      const status = err?.response?.status;
      if (window.__NOTES_DEBUG__) {
        console.log('[VoiceNotes] save error details:', { status, backendMsg, err: err.message });
      }
      setSaveError(backendMsg || `Save failed (${status || 'network error'}). Please try again.`);
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = async (noteId) => {
    try {
      await api.delete(`/notes/${noteId}`);
      setRecentNotes((prev) => prev.filter((n) => n.id !== noteId));
    } catch {}
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

  return (
    <div className="fixed bottom-[76px] right-4 z-[9998]" style={{ animation: 'voicePanelSlideIn 250ms cubic-bezier(0.16,1,0.3,1) both' }}>
      <style>{`
        @keyframes voicePanelSlideIn {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes voicePulse {
          0%, 100% { transform: scaleY(0.4); }
          50%      { transform: scaleY(1); }
        }
      `}</style>
      <div className="w-80 bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-emerald-500 to-teal-500 text-white">
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

        {/* Banners */}
        {!speechSupported && (
          <div className="px-4 py-3 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="text-amber-500 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-400">Speech not supported. Use Chrome or Edge.</p>
            </div>
          </div>
        )}
        {speechSupported && micPermission === 'denied' && (
          <div className="px-4 py-3 bg-red-50 dark:bg-red-900/30 border-b border-red-200 dark:border-red-800">
            <div className="flex items-start gap-2">
              <Shield size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-red-700 dark:text-red-400">Microphone access denied. Allow in browser settings.</p>
            </div>
          </div>
        )}
        {speechSupported && micPermission === 'prompt' && !isListening && !showSettings && (
          <div className="px-4 py-3 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800">
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
          <div className="px-4 py-2.5 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
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
        {showSettings && !isListening && (
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 space-y-3 max-h-[280px] overflow-y-auto">
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
            <p className="text-[9px] text-gray-400 italic">Web Speech API · Chrome/Edge recommended</p>
          </div>
        )}

        {/* Main area */}
        <div className="p-4">
          {isListening ? (
            <div className="space-y-3">
              {/* Recording header */}
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                <span className="text-sm font-medium text-red-600 dark:text-red-400">Recording</span>
                <span className="text-sm text-gray-500 ml-auto font-mono">{fmt(duration)}</span>
              </div>

              {/* Audio level bars (CSS animation, no getUserMedia) */}
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

              {/* Live transcript */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 min-h-[80px] max-h-[160px] overflow-y-auto text-sm text-gray-700 dark:text-gray-300">
                {transcript && <span>{transcript} </span>}
                {interim && <span className="text-gray-400 italic">{interim}</span>}
                {!transcript && !interim && (
                  <span className="text-gray-400 italic">Listening... speak now</span>
                )}
              </div>

              <button onClick={handleStopRecording} className="w-full flex items-center justify-center gap-2 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors">
                <Square size={14} /> Stop
              </button>
            </div>
          ) : transcript ? (
            <div className="space-y-3">
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 min-h-[60px] max-h-[120px] overflow-y-auto text-sm text-gray-700 dark:text-gray-300">{transcript}</div>
              <div className="flex items-center gap-1 text-xs text-gray-400"><Clock size={11} /><span>{fmt(duration)}</span></div>
              {saveError && <div className="flex items-center gap-2 text-xs text-red-500"><AlertTriangle size={12} /><span>{saveError}</span></div>}
              <div className="flex gap-2">
                <button onClick={saveNote} disabled={saving} className="flex-1 flex items-center justify-center gap-2 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                  <Save size={14} /> {saving ? 'Saving...' : 'Save Note'}
                </button>
                <button onClick={() => { setTranscript(''); setDuration(0); setSaveError(null); }} className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-lg text-sm transition-colors">
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
            </div>
          )}
        </div>

        {/* Recent notes */}
        <div className="border-t border-gray-200 dark:border-gray-700">
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
