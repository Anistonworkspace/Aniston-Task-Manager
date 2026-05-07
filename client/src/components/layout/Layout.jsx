import React, { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import OnboardingTour from '../common/OnboardingTour';
import AIAssistant from '../common/AIAssistant';
import VoiceNotes from '../common/VoiceNotes';
import FeedbackWidget from '../common/FeedbackWidget';
import ToolsFAB from '../common/ToolsFAB';
import RoleChangePopup from '../common/RoleChangePopup';

export default function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [voiceNotesOpen, setVoiceNotesOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="app-shell flex h-screen w-screen overflow-hidden">
      {/* Skip to main content link for accessibility */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[9999] focus:px-4 focus:py-2 focus:bg-primary focus:text-white focus:rounded-lg focus:text-sm focus:font-semibold">
        Skip to main content
      </a>
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)} />
        <main id="main-content" className="flex-1 overflow-hidden pl-1.5 pr-0 pb-0 pt-0 flex flex-col" role="main" key={location.pathname}>
          <div className="floating-card floating-card--stuck flex-1 min-h-0 overflow-auto page-enter">
            <Outlet />
          </div>
        </main>
      </div>
      <ToolsFAB onOpenVoiceNotes={() => setVoiceNotesOpen(true)} onOpenFeedback={() => setFeedbackOpen(true)} onOpenAI={() => setAiOpen(true)} />
      <VoiceNotes isOpen={voiceNotesOpen} onClose={() => setVoiceNotesOpen(false)} />
      <FeedbackWidget isOpen={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <AIAssistant isOpen={aiOpen} onClose={() => setAiOpen(false)} />
      <OnboardingTour />
      <RoleChangePopup />
    </div>
  );
}
