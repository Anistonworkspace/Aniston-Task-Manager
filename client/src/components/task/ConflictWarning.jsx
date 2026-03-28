import React, { useState } from 'react';
import { AlertTriangle, RefreshCw, ChevronDown, ChevronUp, Clock } from 'lucide-react';
import api from '../../services/api';

/**
 * ConflictWarning - Displays scheduling conflicts and provides auto-reschedule option.
 *
 * @param {Array} conflicts - Array of conflicting task objects from the API
 * @param {string} taskId - The current task being scheduled (to exclude from reschedule)
 * @param {string} dueDate - The proposed due date
 * @param {number} estimatedHours - Estimated hours for the task
 * @param {Function} onRescheduled - Callback after a conflict is resolved
 * @param {Function} onDismiss - Callback to dismiss the warning
 */
export default function ConflictWarning({ conflicts, taskId, dueDate, estimatedHours, onRescheduled, onDismiss }) {
  const [expanded, setExpanded] = useState(false);
  const [rescheduling, setRescheduling] = useState(null);

  if (!conflicts || conflicts.length === 0) return null;

  async function handleAutoReschedule(conflictTaskId) {
    setRescheduling(conflictTaskId);
    try {
      // Reschedule the conflicting task to after the current task's end time
      const endTime = new Date(new Date(dueDate).getTime() + (estimatedHours || 1) * 60 * 60 * 1000);
      const res = await api.post('/tasks/auto-reschedule', {
        taskId: conflictTaskId,
        afterTime: endTime.toISOString(),
      });
      if (res.data && onRescheduled) {
        onRescheduled(res.data);
      }
    } catch (err) {
      console.error('Failed to auto-reschedule:', err);
    } finally {
      setRescheduling(null);
    }
  }

  return (
    <div className="mb-3 rounded-lg border border-yellow-300 bg-yellow-50 dark:bg-yellow-900/20 dark:border-yellow-700 overflow-hidden transition-all duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
          <span className="text-xs font-semibold text-yellow-800 dark:text-yellow-300">
            {conflicts.length} scheduling conflict{conflicts.length > 1 ? 's' : ''} detected
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-yellow-700 dark:text-yellow-400 hover:text-yellow-900 dark:hover:text-yellow-200 flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-yellow-100 dark:hover:bg-yellow-800/30 transition-colors"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? 'Hide' : 'Details'}
          </button>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="text-xs text-yellow-600 dark:text-yellow-500 hover:text-yellow-800 dark:hover:text-yellow-300 px-1.5 py-0.5 rounded hover:bg-yellow-100 dark:hover:bg-yellow-800/30 transition-colors"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>

      {/* Expanded conflict list */}
      {expanded && (
        <div className="border-t border-yellow-200 dark:border-yellow-700 px-3 py-2 space-y-2">
          {conflicts.map((conflict) => (
            <div
              key={conflict.taskId}
              className="flex items-center justify-between py-1.5 px-2 rounded-md bg-yellow-100/50 dark:bg-yellow-800/20"
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-yellow-900 dark:text-yellow-200 truncate">
                  {conflict.title}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-yellow-700 dark:text-yellow-400 flex items-center gap-0.5">
                    <Clock size={9} />
                    {conflict.estimatedHours}h est.
                  </span>
                  {conflict.dueDate && (
                    <span className="text-[10px] text-yellow-700 dark:text-yellow-400">
                      Due: {new Date(conflict.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  )}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    conflict.priority === 'critical' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                    conflict.priority === 'high' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' :
                    conflict.priority === 'medium' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                    'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                  }`}>
                    {conflict.priority}
                  </span>
                </div>
              </div>
              <button
                onClick={() => handleAutoReschedule(conflict.taskId)}
                disabled={rescheduling === conflict.taskId}
                className="flex items-center gap-1 px-2 py-1 ml-2 text-[10px] font-medium text-yellow-800 dark:text-yellow-200 bg-yellow-200 dark:bg-yellow-700 hover:bg-yellow-300 dark:hover:bg-yellow-600 rounded-md transition-colors disabled:opacity-50 flex-shrink-0"
                title="Auto-adjust this task to resolve conflict"
              >
                <RefreshCw size={10} className={rescheduling === conflict.taskId ? 'animate-spin' : ''} />
                {rescheduling === conflict.taskId ? 'Moving...' : 'Auto-adjust'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
