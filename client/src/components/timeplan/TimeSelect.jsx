import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clock } from 'lucide-react';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Professional time picker — a typeable field with a scrollable dropdown of
 * 15-minute increments inside the working window. Replaces the native
 * <input type="time"> clock UI. Controlled: value/onChange are "HH:MM".
 */
export default function TimeSelect({ value, onChange, min = '09:00', max = '21:00', step = 15, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value || '');
  const wrapRef = useRef(null);

  useEffect(() => { setText(value || ''); }, [value]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); commit(text); }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, text]);

  const options = useMemo(() => {
    const out = [];
    for (let m = toMin(min); m <= toMin(max); m += step) out.push(fromMin(m));
    return out;
  }, [min, max, step]);

  function commit(v) {
    if (HHMM.test(v)) onChange(v);
    else setText(value || '');
  }
  function choose(o) { setText(o); onChange(o); setOpen(false); }

  return (
    <div className="relative" ref={wrapRef}>
      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-white px-2.5 py-2 focus-within:border-primary">
        <Clock size={13} className="flex-shrink-0 text-text-tertiary" />
        <input
          value={text}
          aria-label={ariaLabel}
          inputMode="numeric"
          placeholder="HH:MM"
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(text); setOpen(false); }
            if (e.key === 'Escape') setOpen(false);
          }}
          className="w-full bg-transparent text-sm text-text-primary focus:outline-none"
        />
        <button type="button" aria-label="Open time list" onClick={() => setOpen((o) => !o)} className="flex-shrink-0 text-text-tertiary">
          <ChevronDown size={14} />
        </button>
      </div>
      {open && (
        <div className="absolute z-[70] mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-white py-1 shadow-dropdown">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => choose(o)}
              className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-surface ${value === o ? 'bg-primary/5 font-semibold text-primary' : 'text-text-primary'}`}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
