import React, { useState } from 'react';
import { Send, Trash2 } from 'lucide-react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { useAuth } from '../../context/AuthContext';
import Avatar from '../common/Avatar';
import useGrammarCorrection from '../../hooks/useGrammarCorrection';
import GrammarSuggestion from '../common/GrammarSuggestion';

export default function TaskComments({ comments, onAdd, onDelete }) {
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { checkGrammar, suggestion: grammarSuggestion, isChecking: isCheckingGrammar, applySuggestion: applyGrammar, dismissSuggestion: dismissGrammar } = useGrammarCorrection();

  async function handleSubmit() {
    if (!text.trim()) return;
    setSubmitting(true);
    try { await onAdd(text.trim()); setText(''); } catch {} finally { setSubmitting(false); }
  }

  return (
    <div>
      {/* Input */}
      <div className="flex items-start gap-3 mb-5">
        <Avatar name={user?.name} size="sm" className="mt-0.5" />
        <div className="flex-1">
          <div className="flex items-end gap-2 border border-border rounded-lg px-3 py-2 focus-within:border-primary transition-colors">
            <textarea value={text} onChange={(e) => { setText(e.target.value); checkGrammar(e.target.value); }} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
              placeholder="Write a comment..." className="flex-1 text-sm border-none outline-none resize-none min-h-[36px] max-h-[120px]" rows={1} />
            <button onClick={handleSubmit} disabled={!text.trim() || submitting} className="p-1.5 rounded-md bg-primary text-white hover:bg-primary-hover disabled:opacity-40 transition-colors flex-shrink-0">
              <Send size={14} />
            </button>
          </div>
          <GrammarSuggestion
            suggestion={grammarSuggestion}
            isChecking={isCheckingGrammar}
            onApply={() => { const corrected = applyGrammar(); setText(corrected); }}
            onDismiss={dismissGrammar}
          />
        </div>
      </div>

      {/* Comments List */}
      {comments.length === 0 ? (
        <p className="text-sm text-text-secondary text-center py-6">No comments yet</p>
      ) : (
        <div className="flex flex-col gap-4">
          {comments.map(c => {
            const author = c.author?.name || c.user?.name || c.userName || 'Unknown';
            const isOwner = user?.id === (c.author?.id || c.userId || c.user?.id);
            return (
              <div key={c.id} className="flex items-start gap-3 group">
                <Avatar name={author} size="sm" className="mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-semibold">{author}</span>
                    <span className="text-xs text-text-tertiary">{c.createdAt ? formatDistanceToNow(parseISO(c.createdAt), { addSuffix: true }) : ''}</span>
                  </div>
                  <p className="text-sm text-text-primary leading-relaxed">{c.content || c.text}</p>
                </div>
                {isOwner && (
                  <button onClick={() => onDelete(c.id)} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-text-tertiary hover:text-danger transition-all" title="Delete">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
