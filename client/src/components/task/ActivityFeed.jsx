import React, { useState, useEffect } from 'react';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { CheckCircle2, PlusCircle, Edit3, Trash2, ArrowRight, FileText, ListChecks } from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';

const ACTION_ICONS = {
  task_created: { icon: PlusCircle, color: '#0073ea' },
  task_updated: { icon: Edit3, color: '#fdab3d' },
  task_deleted: { icon: Trash2, color: '#e2445c' },
  status_changed: { icon: ArrowRight, color: '#00c875' },
  subtask_added: { icon: ListChecks, color: '#0073ea' },
  subtask_status_changed: { icon: CheckCircle2, color: '#00c875' },
  worklog_added: { icon: FileText, color: '#579bfc' },
};

export default function ActivityFeed({ taskId, boardId }) {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    loadActivities();
  }, [taskId, boardId]);

  async function loadActivities() {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (taskId) params.set('taskId', taskId);
      if (boardId) params.set('boardId', boardId);
      params.set('limit', showAll ? '100' : '20');
      const res = await api.get(`/activities?${params}`);
      const data = res.data.data || res.data;
      setActivities(data.activities || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Failed to load activities:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading && activities.length === 0) {
    return <div className="text-center py-6 text-text-tertiary text-sm">Loading activity...</div>;
  }

  if (activities.length === 0) {
    return <div className="text-center py-8 text-text-secondary text-sm">No activity yet</div>;
  }

  return (
    <div className="space-y-3">
      {activities.map(act => {
        const cfg = ACTION_ICONS[act.action] || ACTION_ICONS.task_updated;
        const Icon = cfg.icon;
        const actorName = act.actor?.name || 'Someone';

        return (
          <div key={act.id} className="flex items-start gap-2.5">
            <div className="flex-shrink-0 mt-0.5">
              <Avatar name={actorName} size="sm" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Icon size={13} style={{ color: cfg.color }} className="flex-shrink-0" />
                <p className="text-sm text-text-primary">
                  {act.description}
                </p>
              </div>
              <span className="text-xs text-text-tertiary">
                {act.createdAt ? formatDistanceToNow(parseISO(act.createdAt), { addSuffix: true }) : ''}
              </span>
            </div>
          </div>
        );
      })}

      {total > activities.length && !showAll && (
        <button
          onClick={() => { setShowAll(true); loadActivities(); }}
          className="text-xs text-primary hover:text-primary-dark transition-colors w-full text-center py-2"
        >
          Show all activity ({total} total)
        </button>
      )}
    </div>
  );
}
