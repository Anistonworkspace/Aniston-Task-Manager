import React, { useState } from 'react';
import { MessageSquare, X, Star, Send, CheckCircle } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import api from '../../services/api';

const CATEGORIES = [
  { value: 'bug', label: 'Bug Report', color: '#e2445c' },
  { value: 'feature', label: 'Feature Request', color: '#0073ea' },
  { value: 'improvement', label: 'Improvement', color: '#fdab3d' },
  { value: 'praise', label: 'Praise', color: '#00c875' },
  { value: 'other', label: 'Other', color: '#a25ddc' },
];

export default function FeedbackWidget({ isOpen, onClose }) {
  const [category, setCategory] = useState('other');
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const location = useLocation();

  const resetForm = () => {
    setCategory('other');
    setRating(0);
    setHoverRating(0);
    setMessage('');
    setSubmitted(false);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!message.trim() || rating < 1) return;

    setSubmitting(true);
    try {
      await api.post('/feedback', {
        category,
        rating,
        message: message.trim(),
        page: location.pathname,
      });
      setSubmitted(true);
      setTimeout(() => {
        handleClose();
      }, 2000);
    } catch (err) {
      console.error('Failed to submit feedback:', err);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed bottom-[76px] right-4 z-[9998]"
      style={{
        animation: 'feedbackPanelSlideIn 250ms cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
    >
      <style>{`
        @keyframes feedbackPanelSlideIn {
          from { opacity: 0; transform: translateY(16px) scale(0.97); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
      <div className="w-80 bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-blue-500 to-indigo-500 text-white">
          <div className="flex items-center gap-2">
            <MessageSquare size={16} />
            <span className="font-semibold text-sm">Send Feedback</span>
          </div>
          <button onClick={handleClose} className="p-1 hover:bg-white/20 rounded-md transition-colors">
            <X size={14} />
          </button>
        </div>

        {submitted ? (
          <div className="p-8 text-center">
            <CheckCircle size={40} className="text-emerald-500 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Thank you!</p>
            <p className="text-xs text-gray-400 mt-1">Your feedback has been submitted.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-4 space-y-4">
            {/* Category */}
            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 block">Category</label>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map(cat => (
                  <button key={cat.value} type="button"
                    onClick={() => setCategory(cat.value)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all ${
                      category === cat.value
                        ? 'text-white border-transparent shadow-sm'
                        : 'text-gray-500 border-gray-200 dark:border-gray-700 hover:border-gray-300'
                    }`}
                    style={category === cat.value ? { backgroundColor: cat.color } : {}}>
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Rating */}
            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 block">Rating</label>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map(n => (
                  <button key={n} type="button"
                    onClick={() => setRating(n)}
                    onMouseEnter={() => setHoverRating(n)}
                    onMouseLeave={() => setHoverRating(0)}
                    className="p-0.5 transition-transform hover:scale-110">
                    <Star size={22}
                      className={`transition-colors ${
                        n <= (hoverRating || rating)
                          ? 'text-amber-400 fill-amber-400'
                          : 'text-gray-300 dark:text-gray-600'
                      }`} />
                  </button>
                ))}
              </div>
            </div>

            {/* Message */}
            <div>
              <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 block">Message</label>
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Tell us what you think..."
                rows={3}
                className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 placeholder:text-gray-400 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/30 resize-none"
              />
            </div>

            {/* Page info */}
            <p className="text-[10px] text-gray-400">
              Page: {location.pathname}
            </p>

            {/* Submit */}
            <button type="submit" disabled={submitting || !message.trim() || rating < 1}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white rounded-lg text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <Send size={14} />
              {submitting ? 'Submitting...' : 'Submit Feedback'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
