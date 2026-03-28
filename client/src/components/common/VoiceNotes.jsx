import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Square, X, ChevronDown, ChevronUp, Clock, FileText, Trash2, Save, Settings } from 'lucide-react';
import api from '../../services/api';

const DEFAULT_SETTINGS = {
  language: 'en-US',
  continuous: true,
  autoPunctuation: true,
  maxSilenceDuration: 'none',
  sensitivity: 'medium',
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

const SENSITIVITY_OPTIONS = [
  { value: 'low', label: 'Low', maxAlternatives: 1 },
  { value: 'medium', label: 'Medium', maxAlternatives: 3 },
  { value: 'high', label: 'High', maxAlternatives: 5 },
];

function loadSettings() {
  try {
    const saved = localStorage.getItem('voiceNoteSettings');
    if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  try {
    localStorage.setItem('voiceNoteSettings', JSON.stringify(settings));
  } catch {}
}

export default function VoiceNotes({ isOpen, onClose }) {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [duration, setDuration] = useState(0);
  const [recentNotes, setRecentNotes] = useState([]);
  const [saving, setSaving] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [supported, setSupported] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState(loadSettings);

  const recognitionRef = useRef(null);
  const timerRef = useRef(null);
  const silenceTimerRef = useRef(null);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) loadRecentNotes();
  }, [isOpen]);

  async function loadRecentNotes() {
    try {
      const res = await api.get('/notes/my');
      setRecentNotes((res.data.notes || []).slice(0, 5));
    } catch {}
  }

  const updateSetting = (key, value) => {
    setSettings(prev => {
      const updated = { ...prev, [key]: value };
      saveSettings(updated);
      return updated;
    });
  };

  const resetSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (settings.maxSilenceDuration !== 'none' && isRecording) {
      const ms = parseInt(settings.maxSilenceDuration) * 1000;
      silenceTimerRef.current = setTimeout(() => {
        stopRecording();
      }, ms);
    }
  }, [settings.maxSilenceDuration, isRecording]);

  const startRecording = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = settings.continuous;
    recognition.interimResults = true;
    recognition.lang = settings.language;

    const sensOption = SENSITIVITY_OPTIONS.find(s => s.value === settings.sensitivity);
    recognition.maxAlternatives = sensOption ? sensOption.maxAlternatives : 3;

    recognition.onresult = (event) => {
      let final = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript + ' ';
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      setTranscript(prev => {
        if (final.trim()) return (prev + ' ' + final).trim();
        return prev;
      });
      setInterimTranscript(interim);

      // Reset silence timer on any speech
      if (final.trim() || interim.trim()) {
        resetSilenceTimer();
      }
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      if (event.error !== 'no-speech') {
        stopRecording();
      }
    };

    recognition.onend = () => {
      // Auto-restart if still recording (browser may stop it)
      if (isRecording && recognitionRef.current) {
        try { recognitionRef.current.start(); } catch {}
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
    setDuration(0);
    setTranscript('');
    setInterimTranscript('');
    setShowSettings(false);

    timerRef.current = setInterval(() => {
      setDuration(prev => prev + 1);
    }, 1000);

    // Start silence timer
    if (settings.maxSilenceDuration !== 'none') {
      const ms = parseInt(settings.maxSilenceDuration) * 1000;
      silenceTimerRef.current = setTimeout(() => {
        stopRecording();
      }, ms);
    }
  }, [isRecording, settings]);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsRecording(false);
    setInterimTranscript('');
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const saveNote = async () => {
    const content = transcript.trim();
    if (!content) return;

    setSaving(true);
    try {
      const title = content.length > 60 ? content.substring(0, 60) + '...' : content;
      await api.post('/notes', {
        title,
        content,
        duration,
        type: 'voice_note',
      });
      setTranscript('');
      setDuration(0);
      loadRecentNotes();
    } catch (err) {
      console.error('Failed to save note:', err);
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = async (id) => {
    try {
      await api.delete(`/notes/${id}`);
      setRecentNotes(prev => prev.filter(n => n.id !== id));
    } catch {}
  };

  const formatDuration = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  };

  const handleClose = () => {
    if (isRecording) stopRecording();
    setShowSettings(false);
    onClose();
  };

  if (!supported) return null;
  if (!isOpen) return null;

  return (
    <div
      className="fixed bottom-[76px] right-4 z-[9998]"
      style={{
        animation: 'voicePanelSlideIn 250ms cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
    >
      <style>{`
        @keyframes voicePanelSlideIn {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
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
            {!isRecording && (
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`p-1 rounded-md transition-colors ${showSettings ? 'bg-white/30' : 'hover:bg-white/20'}`}
                title="Settings"
              >
                <Settings size={14} />
              </button>
            )}
            <button onClick={handleClose} className="p-1 hover:bg-white/20 rounded-md transition-colors">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && !isRecording && (
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">Recording Settings</p>

            {/* Language */}
            <div>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1 block">Language</label>
              <select
                value={settings.language}
                onChange={e => updateSetting('language', e.target.value)}
                className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 focus:outline-none focus:border-emerald-400"
              >
                {LANGUAGES.map(l => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>

            {/* Continuous Mode */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 block">Continuous Mode</label>
                <p className="text-[10px] text-gray-400">Keep recording during pauses</p>
              </div>
              <button
                onClick={() => updateSetting('continuous', !settings.continuous)}
                className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${
                  settings.continuous ? 'bg-emerald-500 justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'
                }`}
              >
                <div className="w-4 h-4 rounded-full bg-white shadow-sm transition-transform" />
              </button>
            </div>

            {/* Auto-punctuation */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 block">Auto-punctuation</label>
                <p className="text-[10px] text-gray-400">Browser-dependent feature</p>
              </div>
              <button
                onClick={() => updateSetting('autoPunctuation', !settings.autoPunctuation)}
                className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${
                  settings.autoPunctuation ? 'bg-emerald-500 justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'
                }`}
              >
                <div className="w-4 h-4 rounded-full bg-white shadow-sm transition-transform" />
              </button>
            </div>

            {/* Max Silence Duration */}
            <div>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1 block">Max Silence Duration</label>
              <select
                value={settings.maxSilenceDuration}
                onChange={e => updateSetting('maxSilenceDuration', e.target.value)}
                className="w-full text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 focus:outline-none focus:border-emerald-400"
              >
                {SILENCE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {/* Sensitivity */}
            <div>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1 block">Sensitivity</label>
              <div className="flex gap-1.5">
                {SENSITIVITY_OPTIONS.map(o => (
                  <button
                    key={o.value}
                    onClick={() => updateSetting('sensitivity', o.value)}
                    className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-all border ${
                      settings.sensitivity === o.value
                        ? 'bg-emerald-500 text-white border-emerald-500'
                        : 'text-gray-500 border-gray-200 dark:border-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-[9px] text-gray-400 italic">Powered by Web Speech API (Chrome recommended)</p>
          </div>
        )}

        {/* Recording Area */}
        <div className="p-4">
          {isRecording ? (
            <div className="space-y-3">
              {/* Recording indicator */}
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                <span className="text-sm font-medium text-red-600 dark:text-red-400">Recording</span>
                <span className="text-sm text-gray-500 ml-auto font-mono">{formatDuration(duration)}</span>
              </div>

              {/* Live transcript */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 min-h-[80px] max-h-[160px] overflow-y-auto text-sm text-gray-700 dark:text-gray-300">
                {transcript && <span>{transcript} </span>}
                {interimTranscript && <span className="text-gray-400 italic">{interimTranscript}</span>}
                {!transcript && !interimTranscript && (
                  <span className="text-gray-400 italic">Start speaking...</span>
                )}
              </div>

              {/* Controls */}
              <div className="flex gap-2">
                <button onClick={stopRecording}
                  className="flex-1 flex items-center justify-center gap-2 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors">
                  <Square size={14} /> Stop
                </button>
              </div>
            </div>
          ) : transcript ? (
            <div className="space-y-3">
              {/* Transcript preview */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 min-h-[60px] max-h-[120px] overflow-y-auto text-sm text-gray-700 dark:text-gray-300">
                {transcript}
              </div>
              <div className="flex items-center gap-1 text-xs text-gray-400">
                <Clock size={11} />
                <span>{formatDuration(duration)}</span>
              </div>

              {/* Save / Discard */}
              <div className="flex gap-2">
                <button onClick={saveNote} disabled={saving}
                  className="flex-1 flex items-center justify-center gap-2 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                  <Save size={14} /> {saving ? 'Saving...' : 'Save Note'}
                </button>
                <button onClick={() => { setTranscript(''); setDuration(0); }}
                  className="px-3 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-lg text-sm transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-4">
              <button onClick={startRecording}
                className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white flex items-center justify-center mx-auto shadow-lg hover:shadow-xl transition-all transform hover:scale-105">
                <Mic size={24} />
              </button>
              <p className="text-xs text-gray-400 mt-3">Tap to start recording</p>
              <p className="text-[10px] text-gray-300 dark:text-gray-600 mt-1">
                {LANGUAGES.find(l => l.value === settings.language)?.label || 'English'} | {settings.continuous ? 'Continuous' : 'Single'} | {settings.sensitivity} sensitivity
              </p>
            </div>
          )}
        </div>

        {/* Recent Notes */}
        <div className="border-t border-gray-200 dark:border-gray-700">
          <button onClick={() => setShowRecent(!showRecent)}
            className="flex items-center justify-between w-full px-4 py-2.5 text-xs text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <span className="font-medium">Recent Notes ({recentNotes.length})</span>
            {showRecent ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
          {showRecent && recentNotes.length > 0 && (
            <div className="max-h-[200px] overflow-y-auto">
              {recentNotes.map(note => (
                <div key={note.id} className="flex items-start gap-2 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-800 group border-t border-gray-100 dark:border-gray-800">
                  <FileText size={13} className="text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-700 dark:text-gray-300 truncate">{note.title}</p>
                    <div className="flex items-center gap-2 text-[10px] text-gray-400 mt-0.5">
                      <span>{formatDate(note.createdAt)}</span>
                      {note.duration > 0 && <span>{formatDuration(note.duration)}</span>}
                    </div>
                  </div>
                  <button onClick={() => deleteNote(note.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all">
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
