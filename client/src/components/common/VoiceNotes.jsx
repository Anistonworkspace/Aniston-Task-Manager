import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, Square, X, ChevronDown, ChevronUp, Clock, FileText, Trash2, Save, Settings, AlertCircle, Volume2, Shield } from 'lucide-react';
import api from '../../services/api';

const DEFAULT_SETTINGS = {
  language: 'en-US',
  continuous: true,
  autoPunctuation: true,
  maxSilenceDuration: 'none',
  sensitivity: 'high',
  gainBoost: true,
  noiseSuppression: false,
  echoCancellation: true,
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
  { value: 'low', label: 'Low', gain: 1.0, maxAlternatives: 1 },
  { value: 'medium', label: 'Medium', gain: 2.0, maxAlternatives: 3 },
  { value: 'high', label: 'High', gain: 3.5, maxAlternatives: 5 },
  { value: 'max', label: 'Max', gain: 5.0, maxAlternatives: 5 },
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
  const [micPermission, setMicPermission] = useState('unknown'); // 'unknown' | 'granted' | 'denied' | 'prompt'
  const [audioLevel, setAudioLevel] = useState(0);

  const recognitionRef = useRef(null);
  const timerRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const gainNodeRef = useRef(null);
  const animFrameRef = useRef(null);
  const isRecordingRef = useRef(false);

  // Keep ref in sync with state for use in callbacks
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  // Check Speech API support
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSupported(false);
    }
  }, []);

  // Check microphone permission on mount
  useEffect(() => {
    checkMicPermission();
  }, []);

  useEffect(() => {
    if (isOpen) loadRecentNotes();
  }, [isOpen]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupAudio();
      if (timerRef.current) clearInterval(timerRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  async function checkMicPermission() {
    try {
      // Use Permissions API if available
      if (navigator.permissions && navigator.permissions.query) {
        const result = await navigator.permissions.query({ name: 'microphone' });
        setMicPermission(result.state); // 'granted', 'denied', or 'prompt'
        result.addEventListener('change', () => setMicPermission(result.state));
        return;
      }
      // Fallback: check if we can enumerate devices
      if (navigator.mediaDevices) {
        setMicPermission('prompt');
      } else {
        setMicPermission('denied');
      }
    } catch {
      setMicPermission('prompt');
    }
  }

  async function requestMicPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        }
      });
      // Permission granted - stop the test stream
      stream.getTracks().forEach(t => t.stop());
      setMicPermission('granted');
      return true;
    } catch (err) {
      console.error('Mic permission denied:', err);
      setMicPermission('denied');
      return false;
    }
  }

  function cleanupAudio() {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try { audioContextRef.current.close(); } catch {}
      audioContextRef.current = null;
    }
    gainNodeRef.current = null;
    analyserRef.current = null;
    setAudioLevel(0);
  }

  async function setupAudioProcessing() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
        }
      });
      mediaStreamRef.current = stream;

      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);

      // Create gain node for sensitivity boost
      const gainNode = audioContext.createGain();
      const sensOption = SENSITIVITY_OPTIONS.find(s => s.value === settings.sensitivity);
      gainNode.gain.value = settings.gainBoost ? (sensOption?.gain || 2.0) : 1.0;
      gainNodeRef.current = gainNode;

      // Create analyser for audio level visualization
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      analyserRef.current = analyser;

      source.connect(gainNode);
      gainNode.connect(analyser);
      // Don't connect to destination (we don't want to play back audio)

      // Start audio level monitoring
      monitorAudioLevel();

      return true;
    } catch (err) {
      console.error('Audio setup failed:', err);
      return false;
    }
  }

  function monitorAudioLevel() {
    if (!analyserRef.current) return;

    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);

    function update() {
      if (!analyserRef.current || !isRecordingRef.current) {
        setAudioLevel(0);
        return;
      }
      analyserRef.current.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      setAudioLevel(Math.min(100, Math.round((avg / 128) * 100)));
      animFrameRef.current = requestAnimationFrame(update);
    }
    update();
  }

  async function loadRecentNotes() {
    try {
      const res = await api.get('/notes/my');
      setRecentNotes((res.data.notes || []).slice(0, 5));
    } catch {}
  }

  const updateSetting = (key, value) => {
    setSettings(prev => {
      const updated = { ...prev, [key]: value };
      saveSettingsToStorage(updated);
      return updated;
    });
  };

  const resetSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (settings.maxSilenceDuration !== 'none' && isRecordingRef.current) {
      const ms = parseInt(settings.maxSilenceDuration) * 1000;
      silenceTimerRef.current = setTimeout(() => {
        stopRecording();
      }, ms);
    }
  }, [settings.maxSilenceDuration]);

  const startRecording = useCallback(async () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    // Step 1: Request mic permission if needed
    if (micPermission !== 'granted') {
      const granted = await requestMicPermission();
      if (!granted) return;
    }

    // Step 2: Setup audio processing for gain boost and level meter
    await setupAudioProcessing();

    // Step 3: Start speech recognition
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

      if (final.trim() || interim.trim()) {
        resetSilenceTimer();
      }
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      if (event.error === 'not-allowed') {
        setMicPermission('denied');
        stopRecording();
      } else if (event.error !== 'no-speech') {
        stopRecording();
      }
    };

    recognition.onend = () => {
      if (isRecordingRef.current && recognitionRef.current) {
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

    if (settings.maxSilenceDuration !== 'none') {
      const ms = parseInt(settings.maxSilenceDuration) * 1000;
      silenceTimerRef.current = setTimeout(() => {
        stopRecording();
      }, ms);
    }
  }, [settings, micPermission, resetSilenceTimer]);

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
    cleanupAudio();
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

        {/* Permission Required Banner */}
        {micPermission === 'denied' && (
          <div className="px-4 py-3 bg-red-50 dark:bg-red-900/30 border-b border-red-200 dark:border-red-800">
            <div className="flex items-start gap-2">
              <Shield size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs font-medium text-red-700 dark:text-red-400">Microphone access denied</p>
                <p className="text-[10px] text-red-600 dark:text-red-500 mt-0.5">
                  To use voice recording, allow microphone access in your browser settings.
                  On mobile: Settings → App → Permissions → Microphone
                </p>
              </div>
            </div>
          </div>
        )}

        {micPermission === 'prompt' && !isRecording && !showSettings && (
          <div className="px-4 py-3 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800">
            <div className="flex items-start gap-2">
              <AlertCircle size={14} className="text-amber-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Microphone permission required</p>
                <p className="text-[10px] text-amber-600 dark:text-amber-500 mt-0.5">
                  Click below to allow microphone access for voice recording.
                </p>
                <button
                  onClick={requestMicPermission}
                  className="mt-2 px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-medium rounded-md transition-colors"
                >
                  Allow Microphone
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Settings Panel */}
        {showSettings && !isRecording && (
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 space-y-3 max-h-[340px] overflow-y-auto">
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

            {/* Sensitivity / Gain */}
            <div>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                Sensitivity (pickup range)
              </label>
              <div className="flex gap-1">
                {SENSITIVITY_OPTIONS.map(o => (
                  <button
                    key={o.value}
                    onClick={() => updateSetting('sensitivity', o.value)}
                    className={`flex-1 px-1.5 py-1.5 rounded-lg text-[10px] font-medium transition-all border ${
                      settings.sensitivity === o.value
                        ? 'bg-emerald-500 text-white border-emerald-500'
                        : 'text-gray-500 border-gray-200 dark:border-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <p className="text-[9px] text-gray-400 mt-1">
                {settings.sensitivity === 'max' ? 'Maximum pickup range — picks up speech from across the room' :
                 settings.sensitivity === 'high' ? 'High range — picks up nearby conversations' :
                 settings.sensitivity === 'medium' ? 'Normal range — arm\'s length distance' :
                 'Close range — speak directly into microphone'}
              </p>
            </div>

            {/* Gain Boost Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 block">Audio Gain Boost</label>
                <p className="text-[10px] text-gray-400">Amplify microphone input</p>
              </div>
              <button
                onClick={() => updateSetting('gainBoost', !settings.gainBoost)}
                className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${
                  settings.gainBoost ? 'bg-emerald-500 justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'
                }`}
              >
                <div className="w-4 h-4 rounded-full bg-white shadow-sm transition-transform" />
              </button>
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

            {/* Noise Suppression */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 block">Noise Suppression</label>
                <p className="text-[10px] text-gray-400">Filter background noise</p>
              </div>
              <button
                onClick={() => updateSetting('noiseSuppression', !settings.noiseSuppression)}
                className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${
                  settings.noiseSuppression ? 'bg-emerald-500 justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'
                }`}
              >
                <div className="w-4 h-4 rounded-full bg-white shadow-sm transition-transform" />
              </button>
            </div>

            {/* Echo Cancellation */}
            <div className="flex items-center justify-between">
              <div>
                <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 block">Echo Cancellation</label>
                <p className="text-[10px] text-gray-400">Prevent feedback loops</p>
              </div>
              <button
                onClick={() => updateSetting('echoCancellation', !settings.echoCancellation)}
                className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${
                  settings.echoCancellation ? 'bg-emerald-500 justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'
                }`}
              >
                <div className="w-4 h-4 rounded-full bg-white shadow-sm transition-transform" />
              </button>
            </div>

            {/* Max Silence Duration */}
            <div>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400 mb-1 block">Auto-stop on silence</label>
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

            <p className="text-[9px] text-gray-400 italic">
              Powered by Web Speech API + MediaStream. Chrome/Edge recommended for best results.
            </p>
          </div>
        )}

        {/* Recording Area */}
        <div className="p-4">
          {isRecording ? (
            <div className="space-y-3">
              {/* Recording indicator + audio level */}
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                <span className="text-sm font-medium text-red-600 dark:text-red-400">Recording</span>
                <span className="text-sm text-gray-500 ml-auto font-mono">{formatDuration(duration)}</span>
              </div>

              {/* Audio level meter */}
              <div className="flex items-center gap-2">
                <Volume2 size={12} className="text-gray-400 flex-shrink-0" />
                <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-100"
                    style={{
                      width: `${audioLevel}%`,
                      backgroundColor: audioLevel > 70 ? '#ef4444' : audioLevel > 40 ? '#f59e0b' : '#10b981',
                    }}
                  />
                </div>
                <span className="text-[10px] text-gray-400 w-7 text-right">{audioLevel}%</span>
              </div>

              {/* Live transcript */}
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 min-h-[80px] max-h-[160px] overflow-y-auto text-sm text-gray-700 dark:text-gray-300">
                {transcript && <span>{transcript} </span>}
                {interimTranscript && <span className="text-gray-400 italic">{interimTranscript}</span>}
                {!transcript && !interimTranscript && (
                  <span className="text-gray-400 italic">Listening... speak now</span>
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
              <button
                onClick={startRecording}
                disabled={micPermission === 'denied'}
                className={`w-16 h-16 rounded-full text-white flex items-center justify-center mx-auto shadow-lg transition-all transform hover:scale-105 ${
                  micPermission === 'denied'
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-gradient-to-br from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 hover:shadow-xl'
                }`}
              >
                <Mic size={24} />
              </button>
              <p className="text-xs text-gray-400 mt-3">
                {micPermission === 'denied'
                  ? 'Microphone access required'
                  : 'Tap to start recording'}
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
