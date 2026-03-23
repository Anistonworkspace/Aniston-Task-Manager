import React, { useState, useEffect, useCallback } from 'react';
import { ChevronRight, ChevronLeft, X, Sparkles } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { TOUR_STEPS } from '../../utils/sopContent';

function getStorageKey(userId) {
  return `onboarding_done_${userId}`;
}

export function resetOnboarding(userId) {
  localStorage.removeItem(getStorageKey(userId));
}

// Get bounding rect of a target element
function getRect(selector) {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  return el.getBoundingClientRect();
}

// Calculate tooltip position next to target element
function calcPosition(rect) {
  if (!rect) return { top: 80, left: 300, placement: 'right' };

  const W = 280;
  const H = 180;
  const gap = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer right (good for sidebar items)
  if (rect.right + gap + W + 16 < vw) {
    return {
      top: Math.max(8, Math.min(rect.top + rect.height / 2 - 40, vh - H - 8)),
      left: rect.right + gap,
      placement: 'right',
    };
  }
  // Try bottom (good for header items)
  if (rect.bottom + gap + H + 16 < vh) {
    return {
      top: rect.bottom + gap,
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - W / 2, vw - W - 8)),
      placement: 'bottom',
    };
  }
  // Try left
  if (rect.left - gap - W > 0) {
    return {
      top: Math.max(8, Math.min(rect.top + rect.height / 2 - 40, vh - H - 8)),
      left: rect.left - gap - W,
      placement: 'left',
    };
  }
  // Fallback: top
  return {
    top: Math.max(8, rect.top - gap - H),
    left: Math.max(8, Math.min(rect.left + rect.width / 2 - W / 2, vw - W - 8)),
    placement: 'top',
  };
}

// CSS arrow pointing toward the target element
function Arrow({ placement, rect, pos }) {
  const s = 7;
  const common = { position: 'absolute', width: 0, height: 0, borderStyle: 'solid' };

  if (placement === 'right') {
    return <div style={{ ...common, left: -s, top: rect ? Math.min(Math.max(12, rect.top + rect.height / 2 - pos.top - s), 120) : 20, borderWidth: `${s}px ${s}px ${s}px 0`, borderColor: 'transparent white transparent transparent' }} />;
  }
  if (placement === 'bottom') {
    return <div style={{ ...common, top: -s, left: rect ? Math.min(Math.max(16, rect.left + rect.width / 2 - pos.left - s), 240) : 100, borderWidth: `0 ${s}px ${s}px ${s}px`, borderColor: 'transparent transparent white transparent' }} />;
  }
  if (placement === 'left') {
    return <div style={{ ...common, right: -s, top: rect ? Math.min(Math.max(12, rect.top + rect.height / 2 - pos.top - s), 120) : 20, borderWidth: `${s}px 0 ${s}px ${s}px`, borderColor: 'transparent transparent transparent white' }} />;
  }
  // top
  return <div style={{ ...common, bottom: -s, left: rect ? Math.min(Math.max(16, rect.left + rect.width / 2 - pos.left - s), 240) : 100, borderWidth: `${s}px ${s}px 0 ${s}px`, borderColor: 'white transparent transparent transparent' }} />;
}

export default function OnboardingTour() {
  const { user } = useAuth();
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [pos, setPos] = useState({ top: 80, left: 300, placement: 'right' });
  const [rect, setRect] = useState(null);

  const role = user?.role || 'member';
  const steps = [...(TOUR_STEPS.common || []), ...(TOUR_STEPS[role] || TOUR_STEPS.member)];

  const updatePos = useCallback(() => {
    if (!visible || !steps[step]) return;
    const r = getRect(steps[step].target);
    setRect(r);
    setPos(calcPosition(r));
  }, [visible, step, steps]);

  // Show tour on first login
  useEffect(() => {
    if (!user?.id) return;
    const done = localStorage.getItem(getStorageKey(user.id));
    if (!done) {
      setTimeout(() => { setVisible(true); setStep(0); }, 1000);
    }
  }, [user?.id]);

  // Restart event
  useEffect(() => {
    function handleRestart() {
      if (user?.id) {
        localStorage.removeItem(getStorageKey(user.id));
        setStep(0);
        setTimeout(() => setVisible(true), 300);
      }
    }
    window.addEventListener('restart-onboarding', handleRestart);
    return () => window.removeEventListener('restart-onboarding', handleRestart);
  }, [user?.id]);

  // Recalculate on step change / resize
  useEffect(() => {
    if (!visible) return;
    // Small delay for DOM to settle
    const t = setTimeout(updatePos, 80);
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => { clearTimeout(t); window.removeEventListener('resize', updatePos); window.removeEventListener('scroll', updatePos, true); };
  }, [visible, step, updatePos]);

  function done() {
    if (user?.id) localStorage.setItem(getStorageKey(user.id), Date.now().toString());
    setVisible(false);
  }

  function next() {
    if (step < steps.length - 1) setStep(step + 1);
    else done();
  }

  function back() {
    if (step > 0) setStep(step - 1);
  }

  if (!visible || !steps.length) return null;

  const current = steps[step];
  const isLast = step === steps.length - 1;
  const isFirst = step === 0;

  return (
    <div
      className="fixed z-[9999]"
      style={{
        top: pos.top,
        left: pos.left,
        width: 280,
        transition: 'top 0.3s cubic-bezier(0.4,0,0.2,1), left 0.3s cubic-bezier(0.4,0,0.2,1)',
        pointerEvents: 'auto',
      }}
    >
      {/* Arrow */}
      <Arrow placement={pos.placement} rect={rect} pos={pos} />

      {/* Tooltip card */}
      <div className="bg-white dark:bg-zinc-800 rounded-xl shadow-xl border border-gray-200 dark:border-zinc-700 overflow-hidden"
        style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)' }}>

        {/* Progress bar */}
        <div className="h-0.5 bg-gray-100 dark:bg-zinc-700">
          <div className="h-full bg-indigo-500 transition-all duration-500" style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
        </div>

        {/* Header row */}
        <div className="flex items-center justify-between px-3.5 pt-2.5">
          <span className="text-[10px] font-semibold text-indigo-500 uppercase tracking-wider">
            {step + 1} / {steps.length}
          </span>
          <button onClick={done} className="p-0.5 rounded hover:bg-gray-100 dark:hover:bg-zinc-700 text-gray-400 hover:text-gray-600 dark:hover:text-zinc-300 transition-colors" title="Close tour">
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="px-3.5 pt-1.5 pb-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg leading-none">{current.icon}</span>
            <h4 className="text-sm font-bold text-gray-900 dark:text-zinc-100 leading-tight">{current.title}</h4>
          </div>
          <p className="text-xs text-gray-500 dark:text-zinc-400 leading-relaxed">{current.description}</p>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between px-3.5 pb-3 pt-0.5">
          {isFirst ? (
            <button onClick={done} className="text-[11px] text-gray-400 hover:text-gray-600 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors">
              Skip tour
            </button>
          ) : (
            <button onClick={back} className="flex items-center gap-0.5 text-[11px] font-medium text-gray-500 hover:text-gray-700 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors">
              <ChevronLeft size={12} /> Back
            </button>
          )}
          <button onClick={next}
            className={`flex items-center gap-1 px-3.5 py-1.5 text-[11px] font-semibold rounded-lg transition-all ${
              isLast
                ? 'bg-gradient-to-r from-indigo-500 to-blue-500 text-white shadow-md shadow-indigo-500/20'
                : 'bg-indigo-500 hover:bg-indigo-600 text-white'
            }`}>
            {isLast ? <><Sparkles size={12} /> Done!</> : <>Next <ChevronRight size={12} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
