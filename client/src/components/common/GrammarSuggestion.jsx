import React from 'react';
import { Check, X, Sparkles } from 'lucide-react';

export default function GrammarSuggestion({ suggestion, isChecking, onApply, onDismiss }) {
  if (!suggestion && !isChecking) return null;

  if (isChecking) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-50 border border-violet-200 rounded-lg mt-1 text-xs text-violet-600 dark:bg-violet-900/20 dark:border-violet-800 dark:text-violet-400">
        <Sparkles size={12} className="animate-pulse" />
        <span>Checking grammar...</span>
      </div>
    );
  }

  return (
    <div className="bg-violet-50 border border-violet-200 rounded-lg mt-1 p-2.5 dark:bg-violet-900/20 dark:border-violet-800">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Sparkles size={12} className="text-violet-500" />
        <span className="text-[10px] font-semibold text-violet-600 uppercase tracking-wide dark:text-violet-400">Suggested correction</span>
      </div>
      <p className="text-xs text-gray-700 mb-2 whitespace-pre-wrap dark:text-gray-300">{suggestion}</p>
      <div className="flex items-center gap-2">
        <button onClick={onApply} className="flex items-center gap-1 px-2.5 py-1 bg-violet-600 text-white rounded-md text-[11px] font-medium hover:bg-violet-700 transition-colors">
          <Check size={11} /> Apply
        </button>
        <button onClick={onDismiss} className="flex items-center gap-1 px-2.5 py-1 bg-gray-100 text-gray-600 rounded-md text-[11px] font-medium hover:bg-gray-200 transition-colors dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600">
          <X size={11} /> Dismiss
        </button>
      </div>
    </div>
  );
}
