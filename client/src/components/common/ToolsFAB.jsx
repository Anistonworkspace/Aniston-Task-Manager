import React, { useState } from 'react';
import { Plus, Mic, MessageSquare, Bot } from 'lucide-react';

export default function ToolsFAB({ onOpenVoiceNotes, onOpenFeedback, onOpenAI }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="fixed bottom-5 right-4 z-[9998] flex flex-col-reverse items-end gap-3 pointer-events-none">
      {/* Main FAB button */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`pointer-events-auto w-12 h-12 rounded-full shadow-lg flex items-center justify-center transition-all duration-300 ${
          expanded
            ? 'bg-gray-800 rotate-45'
            : 'bg-gradient-to-br from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700'
        } text-white`}
        title="Quick Tools"
      >
        <Plus size={22} className="transition-transform duration-300" />
      </button>

      {/* AI Assistant mini-FAB */}
      <div className={`transition-all duration-300 ${expanded ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 translate-y-4 scale-50 pointer-events-none'}`}
        style={{ transitionDelay: expanded ? '50ms' : '0ms' }}>
        <button
          onClick={() => { onOpenAI(); setExpanded(false); }}
          className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white shadow-md flex items-center justify-center transition-all hover:scale-110"
          title="AI Assistant"
        >
          <Bot size={18} />
        </button>
      </div>

      {/* Voice Notes mini-FAB */}
      <div className={`transition-all duration-300 ${expanded ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 translate-y-4 scale-50 pointer-events-none'}`}
        style={{ transitionDelay: expanded ? '100ms' : '0ms' }}>
        <button
          onClick={() => { onOpenVoiceNotes(); setExpanded(false); }}
          className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white shadow-md flex items-center justify-center transition-all hover:scale-110"
          title="Voice Notes"
        >
          <Mic size={18} />
        </button>
      </div>

      {/* Feedback mini-FAB */}
      <div className={`transition-all duration-300 ${expanded ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 translate-y-4 scale-50 pointer-events-none'}`}
        style={{ transitionDelay: expanded ? '150ms' : '0ms' }}>
        <button
          onClick={() => { onOpenFeedback(); setExpanded(false); }}
          className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white shadow-md flex items-center justify-center transition-all hover:scale-110"
          title="Send Feedback"
        >
          <MessageSquare size={18} />
        </button>
      </div>
    </div>
  );
}
