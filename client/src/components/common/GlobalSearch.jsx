import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, FileText, FolderKanban, ArrowRight, Command, ChevronDown } from 'lucide-react';
import api from '../../services/api';

const STATUS_COLORS = {
  not_started: '#c4c4c4',
  working_on_it: '#fdab3d',
  stuck: '#e2445c',
  done: '#00c875',
  review: '#a25ddc',
};

const STATUS_LABELS = {
  not_started: 'Not Started',
  working_on_it: 'Working',
  stuck: 'Stuck',
  done: 'Done',
  review: 'Review',
};

const PAGE_SIZE = 20;

export default function GlobalSearch({ onClose }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState({ tasks: [], boards: [] });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [currentLimit, setCurrentLimit] = useState(PAGE_SIZE);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const allItems = [
    ...results.boards.map(b => ({ type: 'board', data: b })),
    ...results.tasks.map(t => ({ type: 'task', data: t })),
  ];

  const doSearch = useCallback(async (q, limit = PAGE_SIZE, append = false) => {
    if (!q || q.trim().length < 2) {
      setResults({ tasks: [], boards: [] });
      setLoading(false);
      setHasMore(false);
      return;
    }
    if (append) setLoadingMore(true);
    else setLoading(true);

    try {
      const res = await api.get(`/search?q=${encodeURIComponent(q.trim())}&limit=${limit}`);
      const data = res.data.data || res.data || { tasks: [], boards: [] };
      setResults(data);
      setSelectedIndex(0);
      // If we got exactly `limit` tasks, there might be more
      setHasMore((data.tasks?.length || 0) >= limit);
      setCurrentLimit(limit);
    } catch {
      setResults({ tasks: [], boards: [] });
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, doSearch]);

  function handleLoadMore() {
    const newLimit = currentLimit + PAGE_SIZE;
    doSearch(query, newLimit, true);
  }

  function handleSelect(item) {
    if (item.type === 'board') {
      navigate(`/boards/${item.data.id}`);
    } else {
      navigate(`/boards/${item.data.boardId}`);
    }
    onClose();
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, allItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && allItems[selectedIndex]) {
      handleSelect(allItems[selectedIndex]);
    }
  }

  const hasResults = allItems.length > 0;
  const hasQuery = query.trim().length >= 2;
  const totalCount = (results.tasks?.length || 0) + (results.boards?.length || 0);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-[15vh] z-50 animate-fade-in" onClick={onClose}>
      <div className="bg-white dark:bg-[#1a1830] rounded-xl shadow-2xl w-full max-w-[580px] mx-4 max-h-[60vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search size={18} className="text-text-tertiary flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 text-sm border-none outline-none bg-transparent placeholder:text-text-tertiary text-text-primary"
            placeholder="Search tasks, boards..."
          />
          {query && (
            <button onClick={() => setQuery('')} className="p-0.5 text-text-tertiary hover:text-text-secondary">
              <X size={15} />
            </button>
          )}
          <kbd className="hidden sm:flex items-center gap-0.5 text-[10px] text-text-tertiary bg-surface px-1.5 py-0.5 rounded border border-border font-mono">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary/20 border-t-primary" />
            </div>
          )}

          {!loading && !hasQuery && (
            <div className="text-center py-10">
              <Search size={32} className="mx-auto text-text-tertiary/40 mb-2" />
              <p className="text-sm text-text-tertiary">Type at least 2 characters to search</p>
              <p className="text-xs text-text-tertiary/60 mt-1 flex items-center justify-center gap-1">
                Tip: Press <kbd className="bg-surface px-1 py-0.5 rounded text-[10px] border border-border font-mono">Ctrl</kbd> + <kbd className="bg-surface px-1 py-0.5 rounded text-[10px] border border-border font-mono">K</kbd> anytime
              </p>
            </div>
          )}

          {!loading && hasQuery && !hasResults && (
            <div className="text-center py-10">
              <FileText size={32} className="mx-auto text-text-tertiary/40 mb-2" />
              <p className="text-sm text-text-secondary">No results for "{query}"</p>
              <p className="text-xs text-text-tertiary mt-1">Try different keywords</p>
            </div>
          )}

          {!loading && hasResults && (
            <>
              {/* Boards */}
              {results.boards.length > 0 && (
                <div className="px-2 pt-2">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-text-tertiary px-2 py-1">Boards</p>
                  {results.boards.map((board, i) => {
                    const idx = i;
                    return (
                      <button
                        key={board.id}
                        onClick={() => handleSelect({ type: 'board', data: board })}
                        className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left transition-colors ${
                          selectedIndex === idx ? 'bg-primary/8 text-primary' : 'hover:bg-surface/80'
                        }`}
                      >
                        <div className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0" style={{ backgroundColor: board.color || '#0073ea' }}>
                          <FolderKanban size={14} className="text-white" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-text-primary truncate">{board.name}</p>
                          {board.description && (
                            <p className="text-xs text-text-tertiary truncate">{board.description}</p>
                          )}
                        </div>
                        <ArrowRight size={14} className="text-text-tertiary flex-shrink-0" />
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Tasks */}
              {results.tasks.length > 0 && (
                <div className="px-2 pt-2 pb-2">
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-text-tertiary px-2 py-1">
                    Tasks
                    <span className="ml-1.5 text-text-tertiary/60">({results.tasks.length}{hasMore ? '+' : ''})</span>
                  </p>
                  {results.tasks.map((task, i) => {
                    const idx = results.boards.length + i;
                    const statusColor = STATUS_COLORS[task.status] || '#c4c4c4';
                    const statusLabel = STATUS_LABELS[task.status] || task.status;
                    return (
                      <button
                        key={task.id}
                        onClick={() => handleSelect({ type: 'task', data: task })}
                        className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left transition-colors ${
                          selectedIndex === idx ? 'bg-primary/8 text-primary' : 'hover:bg-surface/80'
                        }`}
                      >
                        <div className="w-1.5 h-7 rounded-full flex-shrink-0" style={{ backgroundColor: statusColor }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-text-primary truncate">{task.title}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {task.board && (
                              <span className="text-[10px] text-text-tertiary bg-surface px-1.5 py-0.5 rounded truncate max-w-[120px]">
                                {task.board.name}
                              </span>
                            )}
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm text-white" style={{ backgroundColor: statusColor }}>
                              {statusLabel}
                            </span>
                          </div>
                        </div>
                        {task.assignee && (
                          <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0" title={task.assignee.name}>
                            <span className="text-[10px] font-bold text-primary">
                              {task.assignee.name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                            </span>
                          </div>
                        )}
                      </button>
                    );
                  })}

                  {/* Load More button */}
                  {hasMore && (
                    <button
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      className="flex items-center justify-center gap-1.5 w-full px-3 py-2.5 mt-1 text-xs font-medium text-primary hover:bg-primary/5 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {loadingMore ? (
                        <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-primary/20 border-t-primary" />
                      ) : (
                        <ChevronDown size={14} />
                      )}
                      {loadingMore ? 'Loading...' : 'Load more results'}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {hasResults && (
          <div className="px-4 py-2 border-t border-border bg-surface/30 flex items-center gap-4 text-[10px] text-text-tertiary">
            <span className="font-medium">{totalCount} result{totalCount !== 1 ? 's' : ''}{hasMore ? '+' : ''}</span>
            <span className="flex-1" />
            <span className="flex items-center gap-1"><kbd className="bg-white dark:bg-[#211f3a] px-1 py-0.5 rounded border border-border">↑↓</kbd> Navigate</span>
            <span className="flex items-center gap-1"><kbd className="bg-white dark:bg-[#211f3a] px-1 py-0.5 rounded border border-border">↵</kbd> Open</span>
            <span className="flex items-center gap-1"><kbd className="bg-white dark:bg-[#211f3a] px-1 py-0.5 rounded border border-border">Esc</kbd> Close</span>
          </div>
        )}
      </div>
    </div>
  );
}
