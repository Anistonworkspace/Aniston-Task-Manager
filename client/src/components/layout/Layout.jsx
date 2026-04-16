import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import OnboardingTour from '../common/OnboardingTour';
import AIAssistant from '../common/AIAssistant';
import VoiceNotes from '../common/VoiceNotes';
import FeedbackWidget from '../common/FeedbackWidget';
import ToolsFAB from '../common/ToolsFAB';
import { useAuth } from '../../context/AuthContext';
import { Eye, Shield, Users, User, ChevronUp } from 'lucide-react';

function RoleSwitcher() {
  const { isSuperAdmin, viewAsRole, switchViewAs, effectiveRole } = useAuth();
  const [open, setOpen] = useState(false);

  // Draggable position state
  const [pos, setPos] = useState(() => {
    try {
      const saved = localStorage.getItem('roleSwitcherPos');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { x: window.innerWidth - 200, y: window.innerHeight - 60 };
  });
  const dragRef = useRef(null);
  const isDragging = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const dragStartMouse = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);

  // Mouse drag handlers
  const onPointerDown = useCallback((e) => {
    // Only drag on primary button
    if (e.button !== 0) return;
    isDragging.current = true;
    hasMoved.current = false;
    dragStartPos.current = { x: pos.x, y: pos.y };
    dragStartMouse.current = { x: e.clientX, y: e.clientY };
    e.target.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, [pos]);

  const onPointerMove = useCallback((e) => {
    if (!isDragging.current) return;
    const dx = e.clientX - dragStartMouse.current.x;
    const dy = e.clientY - dragStartMouse.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved.current = true;
    const newX = Math.max(0, Math.min(window.innerWidth - 60, dragStartPos.current.x + dx));
    const newY = Math.max(0, Math.min(window.innerHeight - 40, dragStartPos.current.y + dy));
    setPos({ x: newX, y: newY });
  }, []);

  const onPointerUp = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    // Save position
    setPos(prev => {
      try { localStorage.setItem('roleSwitcherPos', JSON.stringify(prev)); } catch {}
      return prev;
    });
  }, []);

  // Attach global move/up listeners
  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  // Keep within viewport on resize
  useEffect(() => {
    const onResize = () => {
      setPos(prev => ({
        x: Math.min(prev.x, window.innerWidth - 60),
        y: Math.min(prev.y, window.innerHeight - 40),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!isSuperAdmin) return null;

  const roles = [
    { key: null, label: 'Admin (Default)', icon: Shield, color: '#e2445c' },
    { key: 'manager', label: 'View as Manager', icon: Users, color: '#0073ea' },
    { key: 'member', label: 'View as Employee', icon: User, color: '#00c875' },
  ];

  const currentLabel = viewAsRole
    ? `Viewing as ${viewAsRole === 'manager' ? 'Manager' : 'Employee'}`
    : 'Super Admin';

  return (
    <div
      ref={dragRef}
      className="fixed z-[9999] select-none"
      style={{ left: pos.x, top: pos.y }}
    >
      {/* Menu */}
      {open && (
        <div className="absolute bottom-12 right-0 bg-white dark:bg-[#1E1F23] rounded-xl shadow-2xl border border-border w-52 py-1.5 mb-1 animate-in fade-in slide-in-from-bottom-2">
          <p className="px-3 py-1 text-[9px] uppercase tracking-wider text-text-tertiary font-semibold">Switch View</p>
          {roles.map(r => (
            <button key={r.key || 'default'} onClick={() => { switchViewAs(r.key); setOpen(false); }}
              className={`flex items-center gap-2 w-full px-3 py-2 text-[12px] transition-colors
                ${(viewAsRole === r.key || (!viewAsRole && r.key === null)) ? 'bg-primary/10 text-primary font-medium' : 'text-text-secondary hover:bg-surface-100'}`}>
              <r.icon size={13} style={{ color: r.color }} />
              {r.label}
            </button>
          ))}
        </div>
      )}

      {/* Draggable toggle button */}
      <button
        onPointerDown={onPointerDown}
        onClick={() => { if (!hasMoved.current) setOpen(!open); }}
        className={`flex items-center gap-2 px-3 py-2 rounded-full shadow-lg border text-[11px] font-medium cursor-grab active:cursor-grabbing
          ${viewAsRole ? 'bg-orange-500 text-white border-orange-400' : 'bg-gray-900 text-white border-gray-700'}`}
        style={{ touchAction: 'none' }}
      >
        <Eye size={13} />
        {currentLabel}
        <ChevronUp size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
    </div>
  );
}

export default function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [voiceNotesOpen, setVoiceNotesOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white dark:bg-[#0F1112]">
      {/* Skip to main content link for accessibility */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[9999] focus:px-4 focus:py-2 focus:bg-primary focus:text-white focus:rounded-lg focus:text-sm focus:font-semibold">
        Skip to main content
      </a>
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)} />
        <main id="main-content" className="flex-1 overflow-auto" role="main" key={location.pathname}>
          <div className="page-enter h-full">
            <Outlet />
          </div>
        </main>
      </div>
      <ToolsFAB onOpenVoiceNotes={() => setVoiceNotesOpen(true)} onOpenFeedback={() => setFeedbackOpen(true)} onOpenAI={() => setAiOpen(true)} />
      <VoiceNotes isOpen={voiceNotesOpen} onClose={() => setVoiceNotesOpen(false)} />
      <FeedbackWidget isOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <AIAssistant isOpen={aiOpen} onClose={() => setAiOpen(false)} />
      <RoleSwitcher />
      <OnboardingTour />
    </div>
  );
}
