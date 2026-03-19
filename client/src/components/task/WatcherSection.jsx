import React, { useState, useEffect } from 'react';
import { Eye, EyeOff, Users } from 'lucide-react';
import api from '../../services/api';

export default function WatcherSection({ taskId }) {
  const [watching, setWatching] = useState(false);
  const [watchers, setWatchers] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (taskId) {
      fetchWatchers();
      checkWatching();
    }
  }, [taskId]);

  async function fetchWatchers() {
    try {
      const res = await api.get(`/task-extras/${taskId}/watchers`);
      setWatchers(res.data.watchers || []);
    } catch {}
  }

  async function checkWatching() {
    try {
      const res = await api.get(`/task-extras/${taskId}/watching`);
      setWatching(res.data.watching);
    } catch {}
  }

  async function toggleWatch() {
    setLoading(true);
    try {
      const res = await api.post(`/task-extras/${taskId}/watch`);
      setWatching(res.data.watching);
      fetchWatchers();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3 mb-4">
      <button onClick={toggleWatch} disabled={loading}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all border ${
          watching
            ? 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20'
            : 'bg-white dark:bg-zinc-700 text-gray-500 border-border hover:border-primary/30 hover:text-primary'
        }`}>
        {watching ? <Eye size={13} /> : <EyeOff size={13} />}
        {watching ? 'Watching' : 'Watch'}
      </button>
      {watchers.length > 0 && (
        <div className="flex items-center gap-1">
          <Users size={12} className="text-gray-400" />
          <div className="flex -space-x-1.5">
            {watchers.slice(0, 5).map(w => (
              <div key={w.id} className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center text-[8px] font-bold text-primary border border-white dark:border-zinc-800"
                title={w.user?.name}>
                {w.user?.avatar ? <img src={w.user.avatar} className="w-5 h-5 rounded-full" /> : w.user?.name?.charAt(0)}
              </div>
            ))}
          </div>
          <span className="text-[10px] text-gray-400 ml-1">{watchers.length} watching</span>
        </div>
      )}
    </div>
  );
}
