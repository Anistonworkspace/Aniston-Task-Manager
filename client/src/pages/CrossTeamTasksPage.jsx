import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { Link2, ArrowRight, AlertTriangle, CheckCircle2, Check, HelpCircle } from 'lucide-react';

const STATUS_COLORS = {
  not_started: { bg: '#c4c4c4', label: 'Not Started' },
  working_on_it: { bg: '#fdab3d', label: 'Working' },
  stuck: { bg: '#e2445c', label: 'Stuck' },
  done: { bg: '#00c875', label: 'Done' },
  review: { bg: '#a25ddc', label: 'Review' },
};

export default function CrossTeamTasksPage() {
  const [deps, setDeps] = useState([]);
  const [helpRequests, setHelpRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { user } = useAuth();

  async function loadDeps() {
    try {
      const [depRes, helpRes] = await Promise.all([
        api.get('/tasks/cross-team-deps'),
        api.get('/help-requests/my-pending').catch(() => ({ data: { data: { helpRequests: [] } } })),
      ]);
      setDeps((depRes.data?.data || depRes.data).dependencies || []);
      setHelpRequests((helpRes.data?.data || helpRes.data).helpRequests || []);
    } catch (err) { console.error(err); } finally { setLoading(false); }
  }

  async function handleResolveHelp(helpId) {
    try {
      await api.put(`/help-requests/${helpId}/status`, { status: 'resolved' });
      loadDeps();
    } catch (err) { console.error(err); }
  }

  useEffect(() => { loadDeps(); }, []);

  async function handleMarkDone(taskId) {
    try {
      await api.put(`/tasks/${taskId}`, { status: 'done' });
      await loadDeps(); // Reload to reflect changes
    } catch (err) {
      console.error('Failed to mark task done:', err);
    }
  }

  const blocked = deps.filter(d => d.task?.status !== 'done' && d.dependsOnTask?.status !== 'done');
  const resolved = deps.filter(d => d.task?.status === 'done' || d.dependsOnTask?.status === 'done');

  if (loading) return (
    <div className="p-6 bg-white min-h-full">
      <div className="max-w-4xl mx-auto space-y-3">
        {[1,2,3].map(i => <div key={i} className="animate-pulse h-16 bg-gray-50 rounded-lg" />)}
      </div>
    </div>
  );

  return (
    <div className="p-6 bg-white min-h-full">
      <div className="max-w-4xl mx-auto">
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-1">
            <Link2 size={18} className="text-purple-500" /> My Dependencies
          </h1>
          <p className="text-[12px] text-gray-400 mb-5">Tasks linked to your work through dependencies</p>
        </motion.div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center"><Link2 size={14} className="text-purple-500" /></div>
            <div><p className="text-xl font-bold text-gray-800">{deps.length}</p><p className="text-[9px] text-gray-400 uppercase">Total</p></div>
          </div>
          <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center"><AlertTriangle size={14} className="text-orange-500" /></div>
            <div><p className="text-xl font-bold text-gray-800">{blocked.length}</p><p className="text-[9px] text-gray-400 uppercase">Active</p></div>
          </div>
          <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center"><CheckCircle2 size={14} className="text-green-500" /></div>
            <div><p className="text-xl font-bold text-gray-800">{resolved.length}</p><p className="text-[9px] text-gray-400 uppercase">Resolved</p></div>
          </div>
        </div>

        {deps.length === 0 && (
          <div className="text-center py-16 bg-gray-50 rounded-xl">
            <Link2 size={32} className="text-gray-200 mx-auto mb-3" />
            <p className="text-sm text-gray-500 mb-1">No dependencies yet</p>
            <p className="text-[12px] text-gray-400">Dependency tasks assigned to you or by you will appear here</p>
          </div>
        )}

        {/* Active Dependencies */}
        {blocked.length > 0 && (
          <div className="mb-6">
            <h2 className="text-[12px] font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <AlertTriangle size={12} className="text-orange-500" /> Active Dependencies ({blocked.length})
            </h2>
            <div className="space-y-2">
              {blocked.map(d => <DepCard key={d.id} dep={d} navigate={navigate} userId={user?.id} onMarkDone={handleMarkDone} />)}
            </div>
          </div>
        )}

        {/* Resolved */}
        {resolved.length > 0 && (
          <div>
            <h2 className="text-[12px] font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <CheckCircle2 size={12} className="text-green-500" /> Resolved ({resolved.length})
            </h2>
            <div className="space-y-2 opacity-60">
              {resolved.map(d => <DepCard key={d.id} dep={d} navigate={navigate} userId={user?.id} />)}
            </div>
          </div>
        )}

        {/* Help Requests */}
        {helpRequests.length > 0 && (
          <div className="mt-6">
            <h2 className="text-[12px] font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <HelpCircle size={12} className="text-yellow-500" /> Help Requests ({helpRequests.length})
            </h2>
            <div className="space-y-2">
              {helpRequests.map(hr => (
                <div key={hr.id} className="bg-white rounded-lg border border-gray-100 shadow-sm p-3 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-yellow-50 flex items-center justify-center">
                    <HelpCircle size={14} className="text-yellow-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-semibold text-gray-800 truncate">{hr.task?.title || 'Task'}</p>
                    <p className="text-[10px] text-gray-400 truncate">{hr.description}</p>
                    <p className="text-[9px] text-gray-300 mt-0.5">
                      From: {hr.requester?.name || '?'} · {hr.urgency && <span className="uppercase font-bold">{hr.urgency}</span>}
                    </p>
                  </div>
                  <button onClick={() => handleResolveHelp(hr.id)}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-medium bg-green-500 text-white rounded-md hover:bg-green-600 transition-colors">
                    <Check size={10} /> Resolve
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DepCard({ dep, navigate, userId, onMarkDone }) {
  const [completing, setCompleting] = useState(false);
  const task = dep.task;
  const blocker = dep.dependsOnTask;
  if (!task || !blocker) return null;

  const taskStatus = STATUS_COLORS[task.status] || STATUS_COLORS.not_started;
  const blockerStatus = STATUS_COLORS[blocker.status] || STATUS_COLORS.not_started;
  const depDescription = blocker.description || task.description;

  // Show "Mark Complete" if the current user is assigned to the blocker task and it's not done
  const canComplete = onMarkDone && blocker.assignedTo === userId && blocker.status !== 'done';

  async function handleComplete() {
    setCompleting(true);
    await onMarkDone(blocker.id);
    setCompleting(false);
  }

  return (
    <motion.div initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}
      className="bg-white rounded-lg border border-gray-100 shadow-sm p-3 hover:shadow transition-shadow">
      {/* Created by */}
      {dep.createdBy && (
        <p className="text-[10px] text-gray-400 mb-2">
          Created by <span className="font-medium text-gray-500">{dep.createdBy.name}</span>
          <span className="mx-1">·</span>
          <span className="capitalize">{dep.dependencyType?.replace('_', ' ') || 'blocks'}</span>
        </p>
      )}

      <div className="flex items-center gap-3">
        {/* Task (the one that needs help) */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => navigate(`/boards/${task.boardId}`)}>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: task.board?.color || '#0073ea' }} />
            <span className="text-[10px] text-gray-400">{task.board?.name}</span>
          </div>
          <p className="text-[12px] font-medium text-gray-800 truncate">{task.title}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[9px] px-1.5 py-0.5 rounded-full text-white font-medium" style={{ backgroundColor: taskStatus.bg }}>{taskStatus.label}</span>
            {task.assignee && <span className="text-[9px] text-gray-400">{task.assignee.name}</span>}
          </div>
        </div>

        {/* Arrow */}
        <div className="flex flex-col items-center flex-shrink-0 px-2">
          <span className="text-[8px] text-gray-400 uppercase mb-0.5">needs</span>
          <ArrowRight size={14} className="text-orange-400" />
        </div>

        {/* Blocker (the dependency task assigned to another person) */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => navigate(`/boards/${blocker.boardId}`)}>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: blocker.board?.color || '#0073ea' }} />
            <span className="text-[10px] text-gray-400">{blocker.board?.name}</span>
          </div>
          <p className="text-[12px] font-medium text-gray-800 truncate">{blocker.title}</p>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[9px] px-1.5 py-0.5 rounded-full text-white font-medium" style={{ backgroundColor: blockerStatus.bg }}>{blockerStatus.label}</span>
            {blocker.assignee && <span className="text-[9px] text-gray-400">{blocker.assignee.name}</span>}
          </div>
        </div>
      </div>

      {/* Description */}
      {depDescription && (
        <div className="mt-2.5 pt-2 border-t border-gray-50">
          <p className="text-[11px] text-gray-500 leading-relaxed">{depDescription}</p>
        </div>
      )}

      {/* Mark Complete button — only for the assigned employee on the blocker task */}
      {canComplete && (
        <div className="mt-2.5 pt-2 border-t border-gray-50 flex justify-end">
          <button onClick={handleComplete} disabled={completing}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500 text-white text-[11px] font-medium rounded-lg hover:bg-green-600 disabled:opacity-50 transition-colors">
            {completing ? (
              <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Check size={12} />
            )}
            Mark Complete
          </button>
        </div>
      )}
    </motion.div>
  );
}
