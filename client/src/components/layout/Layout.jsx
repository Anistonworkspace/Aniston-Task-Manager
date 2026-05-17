import React, { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import OnboardingTour from '../common/OnboardingTour';
// SidekickPanel is the canonical AI surface across the app. (Legacy
// AIAssistant.jsx was removed 2026-05-17 after SidekickPanel had run
// stable in production — no production code referenced it.)
import SidekickPanel from '../sidekick/SidekickPanel';
import VoiceNotes from '../common/VoiceNotes';
import FeedbackWidget from '../common/FeedbackWidget';
import ToolsFAB from '../common/ToolsFAB';
import RoleChangePopup from '../common/RoleChangePopup';
import BannerStack, { BannersProvider } from './Banners';

// Initial sidebar state: collapsed on small viewports so the drawer doesn't
// cover the page contents on first load. We read window.matchMedia at module
// init time — useState's lazy initializer keeps this from re-firing on
// re-renders. SSR-safe: typeof window guard returns `false` (= sidebar open)
// during render, which is the historical desktop default.
function initialSidebarCollapsed() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  // Tailwind's `md` breakpoint is 768px — match it so the JS state lines up
  // with the CSS that already hides the sidebar via `max-md:-translate-x-full`.
  return window.matchMedia('(max-width: 767px)').matches;
}

export default function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [voiceNotesOpen, setVoiceNotesOpen] = useState(false);
  // Opt-in flag honored on the next open — lets pages like NotetakerPage
  // request "open the recorder in Meeting Mode" without lifting the whole
  // VoiceNotes state into a context.
  const [voiceNotesInitialMeetingMode, setVoiceNotesInitialMeetingMode] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const location = useLocation();

  // Mobile: auto-collapse the sidebar after every route change so the drawer
  // doesn't keep covering the page after the user taps a nav link. Desktop
  // (md and up) is unaffected — the drawer overlay is hidden by CSS there
  // and the sidebar collapse is purely cosmetic.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    if (window.matchMedia('(max-width: 767px)').matches) {
      setSidebarCollapsed(true);
    }
  }, [location.pathname]);

  // Any page can fire `window.dispatchEvent(new CustomEvent('open-voice-notes', { detail: { meetingMode: true } }))`
  // to open the recorder pre-configured. Keeps NotetakerPage decoupled
  // from Layout state — no prop drilling, no context refactor for one
  // affordance.
  useEffect(() => {
    function onOpenVoiceNotes(e) {
      const wantsMeeting = !!(e?.detail?.meetingMode);
      setVoiceNotesInitialMeetingMode(wantsMeeting);
      setVoiceNotesOpen(true);
    }
    window.addEventListener('open-voice-notes', onOpenVoiceNotes);
    return () => window.removeEventListener('open-voice-notes', onOpenVoiceNotes);
  }, []);

  // App shell: floating-card framing (.app-shell + .floating-card--stuck)
  // gives the app warmth and depth — a tan-tinted base layer with a
  // detached white content card. This is a deliberate divergence from the
  // skill's §4.2 flat shell (the team prefers the polish here). All other
  // Phase A token migrations are unaffected.
  return (
    <BannersProvider>
      <div className="app-shell flex h-screen w-screen overflow-hidden">
        {/* Skip to main content link for accessibility */}
        <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[9999] focus:px-4 focus:py-2 focus:bg-primary focus:text-white focus:rounded-lg focus:text-sm focus:font-semibold">
          Skip to main content
        </a>
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <Header onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)} />
          {/* Layout-level banner stack — sits between the top bar and the
              main content. Dismissals persist in localStorage; pushes come
              from anywhere via useBanners(). Renders nothing when empty. */}
          <BannerStack />
          <main id="main-content" className="flex-1 overflow-hidden pl-1.5 pr-0 pb-0 pt-0 flex flex-col" role="main" key={location.pathname}>
            <div className="floating-card floating-card--stuck flex-1 min-h-0 overflow-auto page-enter">
              <Outlet />
            </div>
          </main>
        </div>
        <ToolsFAB onOpenVoiceNotes={() => setVoiceNotesOpen(true)} onOpenFeedback={() => setFeedbackOpen(true)} onOpenAI={() => setAiOpen(true)} />
        <VoiceNotes
          isOpen={voiceNotesOpen}
          onClose={() => {
            setVoiceNotesOpen(false);
            setVoiceNotesInitialMeetingMode(false);
          }}
          initialMeetingMode={voiceNotesInitialMeetingMode}
        />
        <FeedbackWidget isOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
        <SidekickPanel isOpen={aiOpen} onClose={() => setAiOpen(false)} />
        <OnboardingTour />
        <RoleChangePopup />
      </div>
    </BannersProvider>
  );
}
