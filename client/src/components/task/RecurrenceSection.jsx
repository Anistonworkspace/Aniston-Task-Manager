import React, { useState, useEffect } from 'react';
import { RefreshCw, X } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';

export default function RecurrenceSection({ taskId, recurrence: initialRec, onUpdate }) {
  const { canManage } = useAuth();
  const [recurrence, setRecurrence] = useState(initialRec);
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState(initialRec?.type || 'daily');
  const [interval, setInterval] = useState(initialRec?.interval || 1);
  const [endDate, setEndDate] = useState(initialRec?.endDate || '');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setRecurrence(initialRec);
    if (initialRec) {
      setType(initialRec.type || 'daily');
      setInterval(initialRec.interval || 1);
      setEndDate(initialRec.endDate || '');
    }
  }, [initialRec]);

  async function handleSave() {
    setLoading(true);
    try {
      const res = await api.put(`/task-extras/${taskId}/recurrence`, { type, interval, endDate: endDate || null });
      setRecurrence(res.data.task?.recurrence || { type, interval, endDate });
      setShowForm(false);
      if (onUpdate) onUpdate(res.data.task);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleRemove() {
    setLoading(true);
    try {
      await api.put(`/task-extras/${taskId}/recurrence`, { type: null });
      setRecurrence(null);
      if (onUpdate) onUpdate({ recurrence: null });
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  if (!canManage) {
    if (!recurrence) return null;
    return (
      <div className="flex items-center gap-2 mb-3 text-xs text-gray-500">
        <RefreshCw size={12} className="text-primary" />
        <span>Recurring: every {recurrence.interval} {recurrence.type}(s)</span>
        {recurrence.nextRun && <span className="text-gray-400">· Next: {new Date(recurrence.nextRun).toLocaleDateString()}</span>}
      </div>
    );
  }

  return (
    <div className="mb-4">
      {recurrence ? (
        <div className="flex items-center gap-2 p-2.5 bg-purple-50 dark:bg-purple-900/10 rounded-lg border border-purple-200 dark:border-purple-800">
          <RefreshCw size={13} className="text-purple-600" />
          <span className="text-xs text-purple-700 dark:text-purple-300 font-medium">
            Every {recurrence.interval} {recurrence.type}(s)
          </span>
          {recurrence.nextRun && (
            <span className="text-[10px] text-purple-500">· Next: {new Date(recurrence.nextRun).toLocaleDateString()}</span>
          )}
          {recurrence.endDate && (
            <span className="text-[10px] text-purple-400">· Ends: {new Date(recurrence.endDate).toLocaleDateString()}</span>
          )}
          <button onClick={() => setShowForm(true)} className="ml-auto text-[10px] text-purple-600 hover:underline">Edit</button>
          <button onClick={handleRemove} disabled={loading} className="text-purple-400 hover:text-red-500"><X size={12} /></button>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-1.5 text-xs font-medium text-primary hover:bg-primary/5 px-2.5 py-1.5 rounded-md transition-colors">
          <RefreshCw size={13} /> Set Recurrence
        </button>
      )}

      {showForm && (
        <div className="mt-2 p-3 bg-gray-50 dark:bg-zinc-800 rounded-lg border border-gray-200 dark:border-zinc-700">
          <div className="flex items-center gap-3 mb-2">
            <label className="text-xs text-gray-500">Every</label>
            <input type="number" min={1} max={30} value={interval} onChange={e => setInterval(Number(e.target.value))}
              className="w-14 text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 text-center focus:outline-none focus:border-primary" />
            <select value={type} onChange={e => setType(e.target.value)}
              className="text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 focus:outline-none focus:border-primary">
              <option value="daily">Day(s)</option>
              <option value="weekly">Week(s)</option>
              <option value="monthly">Month(s)</option>
            </select>
          </div>
          <div className="flex items-center gap-3 mb-3">
            <label className="text-xs text-gray-500">End date (optional)</label>
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 focus:outline-none focus:border-primary" />
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={loading}
              className="px-3 py-1.5 bg-primary text-white text-xs font-medium rounded-md hover:bg-primary/90 disabled:opacity-50">Save</button>
            <button onClick={() => setShowForm(false)} className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
