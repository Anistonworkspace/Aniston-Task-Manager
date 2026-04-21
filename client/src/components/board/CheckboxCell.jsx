import React from 'react';
import { Check } from 'lucide-react';

export default function CheckboxCell({ value = false, onChange }) {
  const readOnly = typeof onChange !== 'function';
  return (
    <div className="w-full h-full flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => { if (!readOnly) onChange(!value); }}
        disabled={readOnly}
        className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all duration-200 ${
          value
            ? 'bg-primary border-primary text-white scale-105'
            : 'border-gray-300 dark:border-zinc-600 hover:border-primary'
        } ${readOnly ? 'cursor-default opacity-80' : ''}`}
      >
        {value && <Check size={12} strokeWidth={3} />}
      </button>
    </div>
  );
}
