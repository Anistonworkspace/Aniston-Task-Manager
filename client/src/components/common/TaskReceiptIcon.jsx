import React, { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { format } from 'date-fns';

/**
 * WhatsApp-style task receipt icon + hover popover.
 *
 * Shown only when `receipt` is present (the server only populates `_receipt`
 * for the assigner/creator, so this component never renders for assignees).
 *
 * States:
 *   single      → one grey tick
 *   double_grey → two grey ticks (delivered, not all seen)
 *   double_blue → two blue ticks (all assignees have seen)
 *
 * The hover popover is portaled to <body> so it is never clipped by table
 * overflow containers.
 */
export default function TaskReceiptIcon({ receipt }) {
  const anchorRef = useRef(null);
  const popoverRef = useRef(null);
  const hideTimerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  function openPopover() {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setOpen(true);
  }

  function scheduleClose() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    // Short grace period so the pointer can cross from the tick into the popover.
    hideTimerRef.current = setTimeout(() => setOpen(false), 120);
  }

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    function updatePos() {
      const rect = anchorRef.current.getBoundingClientRect();
      const popW = popoverRef.current?.offsetWidth || 260;
      const popH = popoverRef.current?.offsetHeight || 120;
      let left = rect.left + rect.width / 2 - popW / 2;
      if (left + popW > window.innerWidth - 12) left = window.innerWidth - popW - 12;
      if (left < 8) left = 8;
      let top = rect.bottom + 6;
      if (top + popH > window.innerHeight - 12) top = Math.max(8, rect.top - popH - 6);
      setPos({ top, left });
    }
    updatePos();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open]);

  useEffect(() => () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  if (!receipt || !receipt.state) return null;

  const state = receipt.state; // 'single' | 'double_grey' | 'double_blue'
  const color = state === 'double_blue' ? '#0284c7' : '#8a95a5';

  // Tick glyph variants. Sizes are tuned to sit flush with 14px title text.
  function TickSvg() {
    if (state === 'single') {
      return (
        <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
          <path d="M1 6.2 L4.7 10 L13 1.5" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    }
    // Double tick — two overlapping check strokes, second offset right.
    return (
      <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true">
        <path d="M1 6.2 L4.7 10 L10.6 1.8" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6.8 6.2 L10.5 10 L17 1.5" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  const labelForState =
    state === 'single' ? 'Assigned — not yet delivered' :
    state === 'double_blue' ? 'Seen by all assignees' :
    'Delivered';

  return (
    <>
      <span
        ref={anchorRef}
        onMouseEnter={openPopover}
        onMouseLeave={scheduleClose}
        onFocus={openPopover}
        onBlur={scheduleClose}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        tabIndex={0}
        role="img"
        aria-label={`Task receipt: ${labelForState}`}
        title={labelForState}
        className="inline-flex items-center justify-center flex-shrink-0 cursor-help select-none"
        style={{ width: 20, height: 16, lineHeight: 0 }}
        data-testid="task-receipt-icon"
      >
        <TickSvg />
      </span>
      {open && createPortal(
        <div
          ref={popoverRef}
          onMouseEnter={openPopover}
          onMouseLeave={scheduleClose}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
          className="bg-white rounded-lg shadow-xl border border-[#e6e9ef] text-[12px] text-[#323338] min-w-[220px] max-w-[320px] overflow-hidden"
          data-testid="task-receipt-popover"
        >
          <div className="px-3 py-2 border-b border-[#e6e9ef] bg-[#f5f6f8] flex items-center gap-2">
            <span style={{ lineHeight: 0 }}><TickSvg /></span>
            <span className="font-semibold text-[12px]">{labelForState}</span>
            <span className="ml-auto text-[11px] text-[#676879]">
              {receipt.seenCount}/{receipt.total} seen
            </span>
          </div>
          <ul className="py-1 max-h-[240px] overflow-auto">
            {(receipt.details || []).map(d => {
              let line;
              if (d.seenAt) line = `Seen at ${format(new Date(d.seenAt), 'MMM d, h:mm a')}`;
              else if (d.deliveredAt) line = `Delivered at ${format(new Date(d.deliveredAt), 'MMM d, h:mm a')}`;
              else line = 'Not opened yet';
              const sub = d.seenAt ? 'text-[#0284c7]' : d.deliveredAt ? 'text-[#676879]' : 'text-[#c4c4c4]';
              return (
                <li key={d.userId} className="px-3 py-1.5 flex items-baseline gap-2">
                  <span className="font-medium truncate max-w-[140px]">{d.name}</span>
                  <span className={`text-[11px] ${sub} truncate`}>— {line}</span>
                </li>
              );
            })}
          </ul>
        </div>,
        document.body
      )}
    </>
  );
}
