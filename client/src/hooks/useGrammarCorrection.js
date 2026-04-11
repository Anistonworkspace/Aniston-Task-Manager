import { useState, useRef, useCallback } from 'react';
import api from '../services/api';

export default function useGrammarCorrection() {
  const [suggestion, setSuggestion] = useState(null);
  const [isChecking, setIsChecking] = useState(false);
  const timerRef = useRef(null);
  const lastTextRef = useRef('');
  const suggestionRef = useRef(null);

  // Keep ref in sync so applySuggestion always reads the latest value
  suggestionRef.current = suggestion;

  const clearPendingCheck = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const checkGrammar = useCallback((text) => {
    clearPendingCheck();

    if (!text || text.trim().length < 10) {
      setSuggestion(null);
      return;
    }

    timerRef.current = setTimeout(async () => {
      if (text === lastTextRef.current) return;
      lastTextRef.current = text;

      try {
        setIsChecking(true);
        const res = await api.post('/ai/grammar', { text }, { _silent: true });
        const data = res.data?.data || res.data;
        if (data.hasChanges && data.corrected) {
          setSuggestion(data.corrected);
        } else {
          setSuggestion(null);
        }
      } catch (err) {
        console.warn('[Grammar] Check failed:', err.message || err);
        setSuggestion(null);
      } finally {
        setIsChecking(false);
      }
    }, 2000); // 2 second debounce
  }, [clearPendingCheck]);

  const applySuggestion = useCallback(() => {
    // Read from ref to guarantee latest value regardless of closure timing
    const text = suggestionRef.current;
    clearPendingCheck();
    // Update lastTextRef so the corrected text isn't re-checked
    if (text) lastTextRef.current = text;
    setSuggestion(null);
    return text || '';
  }, [clearPendingCheck]);

  const dismissSuggestion = useCallback(() => {
    setSuggestion(null);
  }, []);

  const reset = useCallback(() => {
    clearPendingCheck();
    setSuggestion(null);
    lastTextRef.current = '';
  }, [clearPendingCheck]);

  return { checkGrammar, suggestion, isChecking, applySuggestion, dismissSuggestion, reset };
}
