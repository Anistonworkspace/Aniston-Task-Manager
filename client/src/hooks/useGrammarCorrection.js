import { useState, useRef, useCallback } from 'react';
import api from '../services/api';

export default function useGrammarCorrection() {
  const [suggestion, setSuggestion] = useState(null);
  const [isChecking, setIsChecking] = useState(false);
  const timerRef = useRef(null);
  const lastTextRef = useRef('');

  const checkGrammar = useCallback((text) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!text || text.trim().length < 10) {
      setSuggestion(null);
      return;
    }

    timerRef.current = setTimeout(async () => {
      if (text === lastTextRef.current) return;
      lastTextRef.current = text;

      try {
        setIsChecking(true);
        const res = await api.post('/ai/grammar', { text });
        const data = res.data?.data || res.data;
        if (data.hasChanges) {
          setSuggestion(data.corrected);
        } else {
          setSuggestion(null);
        }
      } catch (err) {
        // Silently fail - grammar check is non-critical
        setSuggestion(null);
      } finally {
        setIsChecking(false);
      }
    }, 2000); // 2 second debounce
  }, []);

  const applySuggestion = useCallback(() => {
    const text = suggestion;
    setSuggestion(null);
    return text;
  }, [suggestion]);

  const dismissSuggestion = useCallback(() => {
    setSuggestion(null);
  }, []);

  return { checkGrammar, suggestion, isChecking, applySuggestion, dismissSuggestion };
}
