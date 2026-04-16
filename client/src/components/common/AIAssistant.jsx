import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { Bot, X, Send, Minimize2, Maximize2, Sparkles, AlertCircle, RotateCcw } from 'lucide-react';
import api from '../../services/api';

/**
 * Map route paths to detailed human-readable context strings.
 */
function getPageContext(pathname) {
  const pageMap = {
    '/': 'Home page - shows greeting, stat cards (Total Tasks, Completed, Overdue, Due Today, Team Tasks, In Progress, Stuck/Blocked, Completion Rate), My Tasks table, Recent boards list',
    '/my-work': 'My Work page - personal task view with Table & Calendar tabs, tasks grouped by due date',
    '/boards': 'Boards page - board library with grid/list view, search, create board',
    '/dashboard': 'Dashboard page - analytics with stat cards, charts, team overview, board summaries',
    '/admin-dashboard': 'My Dashboard - smart views, status/priority charts, tasks table',
    '/time-plan': 'Time Plan page - daily/weekly time planner with hourly blocks, team view for managers',
    '/meetings': 'Meetings page - meeting scheduling, accept/decline, stats, date-grouped list',
    '/reviews': 'Reviews page - weekly review with task summary, PDF/CSV export',
    '/profile': 'Profile page - avatar upload, edit name/department/designation, change password',
    '/users': 'User Management - create/edit/deactivate users, departments, designations, roles',
    '/org-chart': 'Org Chart - visual hierarchy tree, manager assignment',
    '/admin-settings': 'Admin Settings - users, workspaces, permissions, access requests, templates',
    '/integrations': 'Integrations - Microsoft Teams, AI configuration',
    '/notes': 'Notes page - voice notes and text notes, search, edit, delete',
    '/feedback': 'Feedback page (admin) - view all user feedback, stats, update status',
    '/director-plan': 'Director Plan - daily task schedule with category cards, drag-drop tasks, deadlines, assignees',
    '/archive': 'Archive - archived tasks, boards, workspaces',
    '/cross-team': 'Dependencies - cross-board task dependencies',
    '/tasks': 'Tasks & Workflows - approvals, extensions, help requests',
    '/timeline': 'Timeline page - Gantt chart view with zoom controls',
  };

  // Match exact first
  if (pageMap[pathname]) return pageMap[pathname];

  // Match prefix patterns
  if (pathname.startsWith('/boards/') && pathname.includes('/dashboard')) {
    return 'Board Dashboard - analytics for a specific board with stat cards, pie/bar charts, team overview';
  }
  if (pathname.startsWith('/boards/')) {
    return 'Board page - task management board with groups, columns, drag-drop tasks, filters, kanban/calendar/gantt views';
  }

  return `Page: ${pathname}`;
}

const APP_STRUCTURE_CONTEXT = `
The application sidebar has these sections:
- Home: Overview with stats and recent boards
- My Work: Personal task view
- My Dashboard: Advanced task views with filters
- Dashboard (Time Plan): Team workload overview
- Org Chart: Organization hierarchy
- Time Plan: Daily/weekly time planner
- Meetings: Schedule and manage meetings
- Reviews: Weekly task reviews with export
- Tasks: Approvals, extensions, delegations
- Dependencies: Cross-board task links
- Notes: Voice notes and text notes
- Help & SOP: Application guide
- Dashboard: Board analytics (managers+)
- Team: User management (managers+)
- Admin Settings: System configuration (admin)
- Integrations: Teams, AI setup (admin)
- Feedback: View user feedback (admin)
- Archive: Archived items (managers+)
- Boards/Workspaces: Listed in sidebar with search

Key features: task boards with multiple views (table/kanban/calendar/gantt), drag-drop, multi-owner tasks, subtasks, time planning, meetings, voice notes, AI assistant.`;

/**
 * Extract page state metadata from the current URL and optional props.
 * This tells the backend which page and context to fetch real data for.
 */
function buildPageState(pathname, search, extraState = {}) {
  const state = { route: pathname, ...extraState };

  // Extract board ID from /boards/:id or /boards/:id/dashboard
  const boardMatch = pathname.match(/^\/boards\/([a-f0-9-]+)/i);
  if (boardMatch) state.boardId = boardMatch[1];

  // Extract query params that are useful for context
  const params = new URLSearchParams(search);
  if (params.get('tab')) state.tab = params.get('tab');
  if (params.get('view')) state.view = params.get('view');
  if (params.get('date')) state.selectedDate = params.get('date');

  return state;
}

export default function AIAssistant({ isOpen: externalOpen, onClose, pageContext: externalPageContext }) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = externalOpen !== undefined ? externalOpen : internalOpen;
  const setIsOpen = externalOpen !== undefined ? (v) => { if (!v && onClose) onClose(); } : setInternalOpen;
  const [isMinimized, setIsMinimized] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [aiConfigured, setAiConfigured] = useState(null); // null = unknown, true/false
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const location = useLocation();

  // Check if AI is configured
  useEffect(() => {
    async function checkConfig() {
      try {
        const res = await api.get('/ai/config');
        const data = res.data?.data || res.data;
        setAiConfigured(!!data?.hasKey);
      } catch {
        setAiConfigured(false);
      }
    }
    checkConfig();
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && !isMinimized) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, isMinimized]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMessage = { role: 'user', content: trimmed };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError('');

    try {
      // Send full conversation history (last 20 messages, excluding error messages)
      const conversationHistory = [...messages, userMessage]
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-20);

      // Static page description for feature help
      const pageContext = getPageContext(location.pathname);
      const context = `${pageContext}\n\nCurrent route: ${location.pathname}\n${APP_STRUCTURE_CONTEXT}`;

      // Rich page state for real data context
      const pageState = buildPageState(location.pathname, location.search, externalPageContext || {});

      const res = await api.post('/ai/chat', {
        messages: conversationHistory,
        context,
        pageState,
      });

      const reply = res.data?.data?.message || res.data?.message || 'No response received.';
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      const errMsg = err.response?.data?.message || 'Failed to get AI response.';
      setError(errMsg);
      // Add error as a system message
      setMessages(prev => [...prev, { role: 'error', content: errMsg }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, location.pathname]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleClearChat = () => {
    setMessages([]);
    setError('');
  };

  const toggleOpen = () => {
    if (isOpen) {
      setIsOpen(false);
      setIsMinimized(false);
    } else {
      setIsOpen(true);
      setIsMinimized(false);
    }
  };

  // Render simple markdown-like formatting
  function renderContent(text) {
    if (!text) return null;
    // Split by code blocks
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map((part, i) => {
      if (part.startsWith('```') && part.endsWith('```')) {
        const code = part.slice(3, -3).replace(/^\w+\n/, ''); // remove language hint
        return (
          <pre key={i} className="bg-gray-900 text-gray-100 text-[11px] rounded-md p-2 my-1 overflow-x-auto whitespace-pre-wrap font-mono">
            {code.trim()}
          </pre>
        );
      }
      // Process inline formatting
      return (
        <span key={i}>
          {part.split('\n').map((line, li) => (
            <React.Fragment key={li}>
              {li > 0 && <br />}
              {renderInline(line)}
            </React.Fragment>
          ))}
        </span>
      );
    });
  }

  function renderInline(text) {
    const isBullet = /^[-*]\s/.test(text);
    const cleanText = isBullet ? text.replace(/^[-*]\s/, '\u2022 ') : text;

    // Split by inline code first (`...`), then handle bold (**...**)
    const codeSegments = cleanText.split(/(`[^`]*`)/g);
    const parts = [];
    let key = 0;

    for (const segment of codeSegments) {
      if (segment.startsWith('`') && segment.endsWith('`') && segment.length > 1) {
        parts.push(
          <code key={key++} className="bg-gray-200 dark:bg-gray-700 px-1 rounded text-[11px] font-mono">
            {segment.slice(1, -1)}
          </code>
        );
      } else {
        // Handle **bold** within this plain-text segment
        const boldSegments = segment.split(/(\*\*.*?\*\*)/g);
        for (const boldSeg of boldSegments) {
          if (boldSeg.startsWith('**') && boldSeg.endsWith('**') && boldSeg.length > 4) {
            parts.push(<strong key={key++} className="font-semibold">{boldSeg.slice(2, -2)}</strong>);
          } else {
            if (boldSeg) parts.push(<span key={key++}>{boldSeg}</span>);
          }
        }
      }
    }

    if (isBullet) {
      return <span className="inline-block ml-2">{parts}</span>;
    }
    return <>{parts}</>;
  }

  return (
    <>
      <style>{`
        @keyframes aiPanelSlideIn {
          from { opacity: 0; transform: translateY(20px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes aiPanelSlideOut {
          from { opacity: 1; transform: translateY(0) scale(1); }
          to { opacity: 0; transform: translateY(20px) scale(0.96); }
        }
      `}</style>

      {/* Chat Panel */}
      {isOpen && (
        <div
          className={`fixed z-[9998] transition-all duration-300 ease-out ${
            isMinimized
              ? 'bottom-[76px] right-4 w-64 h-12'
              : 'bottom-[76px] right-4 w-[380px] h-[520px]'
          }`}
          style={{
            maxHeight: 'calc(100vh - 120px)',
            animation: 'aiPanelSlideIn 250ms cubic-bezier(0.16, 1, 0.3, 1) both',
          }}
        >
          <div className={`bg-white dark:bg-[#1E1F23] rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden h-full transition-all duration-300`}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-600 to-indigo-600 text-white flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center">
                  <Sparkles size={14} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold leading-none">AI Assistant</h3>
                  {!isMinimized && (
                    <p className="text-[10px] text-white/70 mt-0.5">
                      {aiConfigured === false ? 'Not configured' : 'Ask me anything'}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {!isMinimized && messages.length > 0 && (
                  <button onClick={handleClearChat} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors" title="Clear chat">
                    <RotateCcw size={13} />
                  </button>
                )}
                <button onClick={() => setIsMinimized(!isMinimized)} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors">
                  {isMinimized ? <Maximize2 size={13} /> : <Minimize2 size={13} />}
                </button>
                <button onClick={toggleOpen} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors">
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Body */}
            {!isMinimized && (
              <>
                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 scroll-smooth">
                  {messages.length === 0 && !loading && (
                    <div className="flex flex-col items-center justify-center h-full text-center py-8">
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-100 to-indigo-100 dark:from-violet-900/30 dark:to-indigo-900/30 flex items-center justify-center mb-3">
                        <Bot size={24} className="text-violet-500" />
                      </div>
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-300">How can I help you?</p>
                      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 max-w-[240px]">
                        Ask about tasks, boards, meetings, or any feature in Aniston Project Hub.
                      </p>
                      {/* Quick suggestions */}
                      <div className="flex flex-wrap gap-1.5 mt-4 justify-center">
                        {[
                          'How do I create a task?',
                          'What can managers do?',
                          'How to use time planner?',
                        ].map(q => (
                          <button
                            key={q}
                            onClick={() => { setInput(q); setTimeout(() => inputRef.current?.focus(), 50); }}
                            className="text-[10px] px-2.5 py-1.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-violet-50 hover:text-violet-600 dark:hover:bg-violet-900/20 dark:hover:text-violet-400 transition-colors border border-gray-200 dark:border-gray-700"
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      {msg.role === 'error' ? (
                        <div className="flex items-start gap-2 max-w-[90%] px-3 py-2 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                          <AlertCircle size={14} className="text-red-500 mt-0.5 flex-shrink-0" />
                          <p className="text-xs text-red-600 dark:text-red-400">{msg.content}</p>
                        </div>
                      ) : msg.role === 'user' ? (
                        <div className="max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-br-md bg-violet-600 text-white text-[12.5px] leading-relaxed">
                          {msg.content}
                        </div>
                      ) : (
                        <div className="max-w-[90%] px-3.5 py-2.5 rounded-2xl rounded-bl-md bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 text-[12.5px] leading-relaxed">
                          {renderContent(msg.content)}
                        </div>
                      )}
                    </div>
                  ))}

                  {loading && (
                    <div className="flex justify-start">
                      <div className="px-4 py-3 rounded-2xl rounded-bl-md bg-gray-100 dark:bg-gray-800">
                        <div className="flex items-center gap-1.5">
                          <div className="w-2 h-2 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                          <div className="w-2 h-2 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                          <div className="w-2 h-2 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    </div>
                  )}

                  <div ref={messagesEndRef} />
                </div>

                {/* Input */}
                <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-700 px-3 py-3">
                  {aiConfigured === false ? (
                    <div className="flex items-center gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl">
                      <AlertCircle size={14} className="text-amber-500 flex-shrink-0" />
                      <p className="text-[11px] text-amber-700 dark:text-amber-400">
                        AI is not configured. Ask an admin to set up AI in Integrations.
                      </p>
                    </div>
                  ) : (
                    <div className="flex items-end gap-2">
                      <textarea
                        ref={inputRef}
                        value={input}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Ask anything..."
                        rows={1}
                        className="flex-1 resize-none text-[13px] px-3.5 py-2.5 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all placeholder-gray-400 dark:placeholder-gray-500 text-gray-800 dark:text-gray-200 max-h-[80px] overflow-y-auto"
                        style={{ minHeight: '40px' }}
                        onInput={(e) => {
                          e.target.style.height = '40px';
                          e.target.style.height = Math.min(e.target.scrollHeight, 80) + 'px';
                        }}
                      />
                      <button
                        onClick={handleSend}
                        disabled={!input.trim() || loading}
                        className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                          input.trim() && !loading
                            ? 'bg-violet-600 hover:bg-violet-700 text-white shadow-md'
                            : 'bg-gray-200 dark:bg-gray-700 text-gray-400 cursor-not-allowed'
                        }`}
                      >
                        <Send size={15} />
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Floating button removed - now controlled via ToolsFAB */}
    </>
  );
}
