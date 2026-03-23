import React, { useState, useEffect, useRef } from 'react';
import { Crown, Users, CheckCircle2, Clock, AlertTriangle, TrendingUp, Building2, Briefcase, FileText, Search, Filter, Bell, X, Plus, Link2, Copy, Check, ChevronDown, ListChecks } from 'lucide-react';
import { Hammer, Receipt, Package, ClipboardList, Scale, FlaskConical, Factory, Bot, Monitor, Palette, Folder, Star, Target, BookOpen, Phone, Mail, Coffee, Briefcase as BriefcaseIcon, Edit3 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import Avatar from '../components/common/Avatar';
import { useToast } from '../components/common/Toast';
import useSocket from '../hooks/useSocket';
import { format } from 'date-fns';

const HOURS = Array.from({ length: 13 }, (_, i) => i + 8);
function fmtHour(h) { return h === 0 || h === 12 ? '12' : h > 12 ? `${h - 12}` : `${h}`; }
function ampm(h) { return h >= 12 ? 'PM' : 'AM'; }
function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

const ICON_MAP = {
  Hammer, Receipt, Package, ClipboardList, Scale, FlaskConical, Factory, Bot, Monitor, Palette,
  Folder, Star, Target, BookOpen, Phone, Mail, Coffee, BriefcaseIcon,
  Crown, Users, CheckCircle2, Clock, FileText, Building2, Briefcase,
};
function getIcon(name, size = 18) {
  const Icon = ICON_MAP[name];
  return Icon ? <Icon size={size} /> : <Folder size={size} />;
}

export default function DirectorDashboardPage() {
  const { user, isDirector, isAdmin, isAssistantManager, isSuperAdmin } = useAuth();
  const { error: toastError } = useToast();
  const [orgData, setOrgData] = useState(null);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState('myday');
  const [deptFilter, setDeptFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [timeBlockAlert, setTimeBlockAlert] = useState(null);
  const lastBlockIdRef = useRef(null);

  const today = format(new Date(), 'yyyy-MM-dd');
  const canAccess = isSuperAdmin || isAssistantManager;
  const [directors, setDirectors] = useState([]);
  const [selectedDirectorId, setSelectedDirectorId] = useState(null);

  // Real-time sync: reload plan when PA updates it
  useSocket('director-plan:updated', (data) => {
    if (data?.plan) {
      setPlan(prev => ({ ...prev, ...data.plan, directorName: prev?.directorName || data.plan.directorName }));
    } else {
      loadPlan();
    }
  });
  // Real-time sync: reload org data when tasks change
  useSocket('task:updated', () => { loadOrgData(); });
  useSocket('task:created', () => { loadOrgData(); });

  // Load available directors
  useEffect(() => {
    if (canAccess) {
      api.get('/director-plan/directors').then(res => {
        const dirs = res.data?.data || [];
        setDirectors(dirs);
        if (dirs.length > 0 && !selectedDirectorId) {
          // Auto-select self if superadmin, otherwise first director
          const self = dirs.find(d => d.id === user?.id);
          setSelectedDirectorId(self ? self.id : dirs[0].id);
        }
      }).catch((e) => { console.error('Failed to load directors:', e); });
    }
  }, [canAccess]);

  useEffect(() => {
    if (canAccess && selectedDirectorId) {
      Promise.all([loadOrgData(), loadPlan()]).finally(() => setLoading(false));
    }
    const orgInterval = setInterval(() => { if (canAccess) loadOrgData(); }, 5 * 60 * 1000);
    return () => clearInterval(orgInterval);
  }, [selectedDirectorId]);

  // Time-block notification: check every 60s if a new block started
  useEffect(() => {
    if (!plan?.categories?.length) return;
    const checkBlock = () => {
      const now = new Date();
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const current = plan.categories.find(c => {
        const s = toMin(c.startTime);
        const e = toMin(c.endTime);
        return nowMins >= s && nowMins < e;
      });
      if (current && current.id !== lastBlockIdRef.current) {
        lastBlockIdRef.current = current.id;
        setTimeBlockAlert(current);
      }
    };
    checkBlock();
    const timer = setInterval(checkBlock, 60000);
    return () => clearInterval(timer);
  }, [plan]);

  async function loadOrgData() {
    try {
      const res = await api.get('/dashboard/director');
      setOrgData(res.data?.data || res.data);
    } catch (err) { toastError('Failed to load dashboard'); }
  }

  async function loadPlan() {
    try {
      const dirParam = selectedDirectorId ? `?directorId=${selectedDirectorId}` : '';
      const res = await api.get(`/director-plan/${today}${dirParam}`);
      setPlan(res.data?.data || res.data);
    } catch (e) { console.error('Failed to load plan:', e); }
  }

  async function toggleTask(categoryId, taskIndex) {
    if (!plan) return;
    try {
      const cat = plan.categories.find(c => c.id === categoryId);
      if (!cat || !cat.tasks[taskIndex]) return;
      const newDone = !cat.tasks[taskIndex].done;
      await api.put(`/director-plan/${today}/task`, { categoryId, taskIndex, done: newDone });
      // Update local state
      const updated = { ...plan, categories: plan.categories.map(c => c.id === categoryId ? { ...c, tasks: c.tasks.map((t, i) => i === taskIndex ? { ...t, done: newDone } : t) } : c) };
      setPlan(updated);
    } catch { toastError('Failed to update task'); }
  }

  async function toggleSubtask(categoryId, taskIndex, subtaskIndex) {
    if (!plan) return;
    try {
      const cat = plan.categories.find(c => c.id === categoryId);
      if (!cat || !cat.tasks[taskIndex] || !cat.tasks[taskIndex].subtasks?.[subtaskIndex]) return;
      const newDone = !cat.tasks[taskIndex].subtasks[subtaskIndex].done;
      // Update local state immediately
      const updated = {
        ...plan,
        categories: plan.categories.map(c => c.id === categoryId ? {
          ...c,
          tasks: c.tasks.map((t, ti) => ti === taskIndex ? {
            ...t,
            subtasks: (t.subtasks || []).map((s, si) => si === subtaskIndex ? { ...s, done: newDone } : s)
          } : t)
        } : c)
      };
      setPlan(updated);
      // Save full plan to backend
      await api.put(`/director-plan/${today}`, { categories: updated.categories, directorId: selectedDirectorId });
    } catch { toastError('Failed to update subtask'); }
  }

  async function saveNotes(newNotes) {
    try {
      await api.put(`/director-plan/${today}/notes`, { notes: newNotes });
    } catch {}
  }

  if (!canAccess) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Crown size={48} className="text-gray-300 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-gray-700">Access Required</h2>
          <p className="text-sm text-gray-500 mt-2">This dashboard is only available for Super Admin and Assistant Manager.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8 space-y-6 animate-pulse">
        <div className="h-20 bg-gray-100 rounded-2xl" />
        <div className="grid grid-cols-4 gap-4">{[1,2,3,4].map(i => <div key={i} className="h-28 bg-gray-100 rounded-2xl" />)}</div>
        <div className="h-20 bg-gray-100 rounded-2xl" />
        <div className="grid grid-cols-2 gap-4">{[1,2,3,4].map(i => <div key={i} className="h-48 bg-gray-100 rounded-2xl" />)}</div>
      </div>
    );
  }

  const categories = plan?.categories || [];
  const allTasks = categories.flatMap(c => c.tasks || []);
  const totalTasks = allTasks.length;
  const doneTasks = allTasks.filter(t => t.done).length;
  const pendingTasks = totalTasks - doneTasks;
  const pct = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;

  const nowHour = new Date().getHours();
  const nowMinute = new Date().getMinutes();
  const nowTotal = nowHour * 60 + nowMinute;

  const currentCat = categories.find(c => {
    const s = toMin(c.startTime);
    const e = toMin(c.endTime);
    return nowTotal >= s && nowTotal < e;
  });

  const greeting = nowHour < 12 ? 'Good morning' : nowHour < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Org data
  const orgStats = orgData?.orgStats || {};
  const departments = orgData?.departments || [];
  const teamSnapshot = orgData?.teamSnapshot || [];
  const boards = orgData?.boards || [];

  const uniqueDepts = [...new Set(teamSnapshot.map(m => m.department).filter(Boolean))];
  const filteredTeam = deptFilter === 'all' ? teamSnapshot : teamSnapshot.filter(m => m.department === deptFilter);
  const searchedTeam = searchQuery ? filteredTeam.filter(m => m.name.toLowerCase().includes(searchQuery.toLowerCase()) || m.currentTask?.title?.toLowerCase().includes(searchQuery.toLowerCase())) : filteredTeam;

  return (
    <div className="p-4 sm:p-8 max-w-[1400px] mx-auto">

      {/* HEADER */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900 tracking-tight flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
              <Crown size={20} className="text-white" />
            </div>
            {greeting}, {user?.name?.split(' ')[0]}
          </h1>
          <p className="text-sm text-gray-500 mt-1 ml-[52px]">{dateStr}</p>
        </div>
        <div className="flex gap-2 mt-4 sm:mt-0">
          {['myday', 'timeline', 'company'].map(v => (
            <button key={v} onClick={() => setActiveView(v)}
              className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all ${activeView === v ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}>
              {v === 'myday' ? 'My Day' : v === 'timeline' ? 'Timeline' : 'Company Overview'}
            </button>
          ))}
        </div>
      </div>

      {/* Director selector (only for assistant managers with multiple directors) */}
      {isAssistantManager && directors.length > 1 && (
        <div className="mb-6 bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3 shadow-sm">
          <span className="text-xs font-semibold text-gray-500">Viewing plan for:</span>
          <select
            value={selectedDirectorId || ''}
            onChange={e => { setSelectedDirectorId(e.target.value); setLoading(true); }}
            className="text-sm font-semibold text-gray-800 bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-300"
          >
            {directors.map(d => (
              <option key={d.id} value={d.id}>
                {d.name} {d.isSuperAdmin ? '(Super Admin)' : d.hierarchyLevel ? `(${d.hierarchyLevel})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Time-block notification banner */}
      {timeBlockAlert && (
        <div className="mb-6 bg-gradient-to-r from-indigo-600 to-purple-600 rounded-2xl p-4 text-white shadow-lg flex items-center justify-between animate-slide-in">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center text-xl">{getIcon(timeBlockAlert.icon, 20)}</div>
            <div>
              <div className="font-bold text-sm">{timeBlockAlert.label}</div>
              <div className="text-xs text-white/80 font-mono">{timeBlockAlert.startTime} - {timeBlockAlert.endTime}</div>
              {timeBlockAlert.tasks?.length > 0 && (
                <div className="text-xs text-white/70 mt-0.5">{timeBlockAlert.tasks.filter(t => !t.done).length} tasks pending</div>
              )}
            </div>
          </div>
          <button onClick={() => setTimeBlockAlert(null)} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
            <X size={16} />
          </button>
        </div>
      )}

      {/* ═══ MY DAY TAB ═══ */}
      {activeView === 'myday' && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {[
              { label: 'Total Tasks', value: totalTasks, icon: FileText, gradient: 'from-indigo-500 to-indigo-600' },
              { label: 'Completed', value: doneTasks, icon: CheckCircle2, gradient: 'from-emerald-500 to-emerald-600' },
              { label: 'Pending', value: pendingTasks, icon: Clock, gradient: 'from-amber-500 to-amber-600' },
              { label: 'Progress', value: `${pct}%`, icon: TrendingUp, gradient: 'from-purple-500 to-purple-600' },
            ].map((s, i) => (
              <div key={i} className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm hover:shadow-md transition-all">
                <div className="flex items-center justify-between mb-3">
                  <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${s.gradient} flex items-center justify-center shadow-sm`}>
                    <s.icon size={18} className="text-white" />
                  </div>
                  {i === 3 && <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${pct >= 70 ? 'bg-emerald-50 text-emerald-600' : pct >= 40 ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-600'}`}>
                    {pct >= 70 ? 'On Track' : pct >= 40 ? 'In Progress' : 'Early Stage'}
                  </span>}
                </div>
                <div className="text-3xl font-extrabold text-gray-900 tracking-tight">{s.value}</div>
                <div className="text-xs text-gray-500 mt-1 font-medium">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Timeline Strip */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 mb-8">
            <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
              <Clock size={16} className="text-indigo-500" /> Today's Schedule
            </h3>
            <div className="flex gap-1 overflow-x-auto pb-2">
              {categories.map(c => {
                const isCurrent = currentCat?.id === c.id;
                const catTasks = c.tasks || [];
                const catDone = catTasks.filter(t => t.done).length;
                const dotCol = catTasks.length === 0 ? '#E5E7EB' : (catDone === catTasks.length ? '#10B981' : c.color);
                return (
                  <div key={c.id} className={`flex-1 min-w-[70px] text-center py-3 px-2 rounded-xl transition-all cursor-pointer
                    ${isCurrent ? 'bg-emerald-50 border-2 border-emerald-200' : 'border border-gray-50 hover:bg-gray-50'}`}
                    onClick={() => document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
                    <div className={`text-[10px] font-mono font-semibold ${isCurrent ? 'text-emerald-600' : 'text-gray-400'}`}>{c.startTime}</div>
                    <div className="text-base my-1">{getIcon(c.icon, 16)}</div>
                    <div className={`w-2 h-2 rounded-full mx-auto ${isCurrent ? 'bg-emerald-500 animate-pulse' : ''}`} style={{ background: dotCol }} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* Category Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            {categories.map(c => {
              const isCurrent = currentCat?.id === c.id;
              const catTasks = c.tasks || [];
              const catDone = catTasks.filter(t => t.done).length;
              const catPct = catTasks.length ? Math.round((catDone / catTasks.length) * 100) : 0;
              return (
                <div key={c.id} id={`cat-${c.id}`}
                  className={`bg-white rounded-2xl p-5 border shadow-sm hover:shadow-md transition-all relative overflow-hidden
                    ${isCurrent ? 'border-emerald-200 ring-2 ring-emerald-50' : 'border-gray-100'}`}>
                  <div className="absolute top-0 left-0 right-0 h-1" style={{ background: c.color }} />
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: c.color + '15', color: c.color }}>
                        {getIcon(c.icon, 20)}
                      </div>
                      <div>
                        <input
                          type="text"
                          value={c.label}
                          onChange={(e) => {
                            const updated = { ...plan, categories: plan.categories.map(cat => cat.id === c.id ? { ...cat, label: e.target.value } : cat) };
                            setPlan(updated);
                          }}
                          onBlur={() => {
                            api.put(`/director-plan/${today}`, { categories: plan.categories }).catch(() => {});
                          }}
                          className="text-sm font-bold text-gray-900 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-indigo-400 outline-none w-full transition-colors"
                        />
                        <div className="flex items-center gap-1 mt-0.5">
                          <input
                            type="time"
                            value={c.startTime}
                            onChange={(e) => {
                              const updated = { ...plan, categories: plan.categories.map(cat => cat.id === c.id ? { ...cat, startTime: e.target.value } : cat) };
                              setPlan(updated);
                            }}
                            onBlur={() => {
                              api.put(`/director-plan/${today}`, { categories: plan.categories }).catch(() => {});
                            }}
                            className="text-[11px] font-mono font-semibold bg-transparent border-b border-transparent hover:border-gray-300 focus:border-indigo-400 outline-none w-16 transition-colors"
                            style={{ color: c.color }}
                          />
                          <span className="text-[11px] text-gray-400">-</span>
                          <input
                            type="time"
                            value={c.endTime}
                            onChange={(e) => {
                              const updated = { ...plan, categories: plan.categories.map(cat => cat.id === c.id ? { ...cat, endTime: e.target.value } : cat) };
                              setPlan(updated);
                            }}
                            onBlur={() => {
                              api.put(`/director-plan/${today}`, { categories: plan.categories }).catch(() => {});
                            }}
                            className="text-[11px] font-mono font-semibold bg-transparent border-b border-transparent hover:border-gray-300 focus:border-indigo-400 outline-none w-16 transition-colors"
                            style={{ color: c.color }}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      {isCurrent && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold mb-1 inline-block">NOW</span>}
                      <div className="text-2xl font-extrabold" style={{ color: catPct === 100 && catTasks.length ? '#10B981' : c.color }}>{catPct}%</div>
                      <div className="text-[11px] text-gray-400">{catDone}/{catTasks.length}</div>
                    </div>
                  </div>
                  <div className="h-1 bg-gray-100 rounded-full overflow-hidden mb-3">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${catPct}%`, background: `linear-gradient(90deg, ${c.color}, ${c.color}99)` }} />
                  </div>
                  {catTasks.length > 0 ? (
                    <div className="space-y-2 max-h-[400px] overflow-y-auto">
                      {catTasks.map((t, ti) => {
                        const subTotal = (t.subtasks || []).length;
                        const subDone = (t.subtasks || []).filter(s => s.done).length;
                        return (
                          <div key={t.id || ti} className="rounded-lg border border-gray-100 hover:border-gray-200 transition-colors">
                            {/* Task header */}
                            <div className="flex items-center gap-2.5 py-2 px-3">
                              <button onClick={() => toggleTask(c.id, ti)}
                                className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all text-[11px] ${t.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-300 hover:border-gray-400'}`}>
                                {t.done ? '✓' : ''}
                              </button>
                              <span className={`text-sm flex-1 font-medium ${t.done ? 'line-through text-gray-400' : 'text-gray-800'}`}>{t.text}</span>
                              {t.startTime && t.endTime && (
                                <span className="text-[10px] font-mono text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded flex-shrink-0">{t.startTime}-{t.endTime}</span>
                              )}
                              {subTotal > 0 && (
                                <span className="text-[10px] font-medium text-gray-400 flex-shrink-0">{subDone}/{subTotal}</span>
                              )}
                            </div>
                            {/* Description */}
                            {t.description && (
                              <div className="px-3 pb-2 ml-8">
                                <p className="text-[11px] text-gray-500 leading-relaxed">{t.description}</p>
                              </div>
                            )}
                            {/* Link */}
                            {t.link && (
                              <div className="px-3 pb-2 ml-8 flex items-center gap-1.5">
                                <Link2 size={10} className="text-indigo-400 flex-shrink-0" />
                                <a href={t.link} target="_blank" rel="noopener noreferrer" className="text-[11px] text-indigo-500 hover:underline truncate">{t.link}</a>
                                <button onClick={() => { navigator.clipboard.writeText(t.link); }} className="p-0.5 rounded text-gray-400 hover:text-indigo-500" title="Copy link">
                                  <Copy size={10} />
                                </button>
                              </div>
                            )}
                            {/* File Attachments */}
                            {(t.attachments || []).length > 0 && (
                              <div className="px-3 pb-2 ml-8 space-y-1">
                                {(t.attachments || []).map((att, ai) => (
                                  <a key={ai} href={`${window.location.protocol}//${window.location.hostname}:5000${att.url}`}
                                    target="_blank" rel="noopener noreferrer"
                                    className="flex items-center gap-2 text-[11px] text-indigo-500 hover:text-indigo-700 hover:underline py-0.5">
                                    <FileText size={11} className="flex-shrink-0" />
                                    {att.name}
                                  </a>
                                ))}
                              </div>
                            )}
                            {/* Subtasks */}
                            {subTotal > 0 && (
                              <div className="px-3 pb-2 ml-8 space-y-1">
                                {(t.subtasks || []).map((sub, si) => (
                                  <div key={sub.id || si} className="flex items-start gap-2 py-1 px-2 bg-gray-50 rounded">
                                    <button onClick={() => toggleSubtask(c.id, ti, si)}
                                      className={`w-3.5 h-3.5 rounded border mt-0.5 flex items-center justify-center flex-shrink-0 text-[8px] cursor-pointer transition-all ${sub.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-300 hover:border-gray-400'}`}>
                                      {sub.done ? '✓' : ''}
                                    </button>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2">
                                        <span className={`text-[11px] ${sub.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>{sub.title}</span>
                                        {sub.startTime && sub.endTime && (
                                          <span className="text-[9px] font-mono text-gray-400">{sub.startTime}-{sub.endTime}</span>
                                        )}
                                      </div>
                                      {sub.description && <p className="text-[10px] text-gray-400 mt-0.5">{sub.description}</p>}
                                      {sub.link && (
                                        <div className="flex items-center gap-1 mt-0.5">
                                          <a href={sub.link} target="_blank" rel="noopener noreferrer" className="text-[10px] text-indigo-500 hover:underline truncate">{sub.link}</a>
                                          <button onClick={() => { navigator.clipboard.writeText(sub.link); }} className="p-0.5 text-gray-400 hover:text-indigo-500"><Copy size={9} /></button>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400 text-center py-4">No tasks scheduled</p>
                  )}
                </div>
              );
            })}

            {/* Add Category Button */}
            <button
              onClick={async () => {
                const newCat = { id: Date.now().toString(), label: 'New Category', icon: 'Folder', color: '#6366F1', startTime: '09:00', endTime: '10:00', tasks: [] };
                const updatedCategories = [...(plan?.categories || []), newCat];
                const updatedPlan = { ...plan, categories: updatedCategories };
                setPlan(updatedPlan);
                try {
                  await api.put(`/director-plan/${today}`, { categories: updatedCategories });
                } catch { toastError('Failed to add category'); }
              }}
              className="flex flex-col items-center justify-center gap-2 bg-white rounded-2xl p-5 border-2 border-dashed border-gray-200 hover:border-indigo-300 hover:bg-indigo-50/30 transition-all cursor-pointer min-h-[120px]"
            >
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center">
                <Plus size={20} className="text-indigo-500" />
              </div>
              <span className="text-sm font-semibold text-gray-500">Add Category</span>
            </button>
          </div>

          {/* Notes */}
          {plan && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 mb-8">
              <h3 className="text-sm font-bold text-gray-800 mb-3">Daily Notes</h3>
              <textarea
                className="w-full min-h-[80px] p-3 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-50 resize-y"
                value={plan.notes || ''}
                onChange={(e) => setPlan({ ...plan, notes: e.target.value })}
                onBlur={(e) => saveNotes(e.target.value)}
                placeholder="Add notes, follow-ups, observations..."
              />
            </div>
          )}

          {categories.length === 0 && (
            <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
              <Crown size={40} className="text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500 font-medium">No daily plan set for today.</p>
              <p className="text-xs text-gray-400 mt-1">Your assistant manager will plan your day.</p>
            </div>
          )}
        </>
      )}

      {/* ═══ TIMELINE TAB ═══ */}
      {activeView === 'timeline' && (
        <div className="max-w-2xl">
          <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2">
            <Clock size={16} className="text-indigo-500" /> Full Day Timeline
          </h3>
          {categories.length === 0 ? (
            <div className="bg-white rounded-2xl border p-8 text-center">
              <Clock size={40} className="text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No plan set for today.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {categories.map((c, i) => {
                const isCurrent = currentCat?.id === c.id;
                const catTasks = c.tasks || [];
                const catDone = catTasks.filter(t => t.done).length;
                const catPct = catTasks.length ? Math.round((catDone / catTasks.length) * 100) : 0;
                return (
                  <div key={c.id} className="flex gap-4">
                    <div className="w-24 text-right pt-4 flex-shrink-0">
                      <div className={`text-xs font-mono font-semibold ${isCurrent ? 'text-emerald-600' : 'text-gray-400'}`}>{c.startTime}</div>
                      <div className="text-[10px] text-gray-300">{c.endTime}</div>
                    </div>
                    <div className="flex flex-col items-center w-6">
                      <div className={`w-3 h-3 rounded-full mt-4 flex-shrink-0 ${isCurrent ? 'bg-emerald-500 ring-4 ring-emerald-100' : ''}`} style={{ background: isCurrent ? undefined : c.color }} />
                      {i < categories.length - 1 && <div className="w-0.5 flex-1 bg-gray-200" />}
                    </div>
                    <div className={`flex-1 p-4 rounded-2xl border mb-1 shadow-sm ${isCurrent ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-gray-100'}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-lg" style={{ color: c.color }}>{getIcon(c.icon, 18)}</span>
                          <span className="text-sm font-bold text-gray-900">{c.label}</span>
                          {isCurrent && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold">NOW</span>}
                        </div>
                        <span className="text-base font-extrabold" style={{ color: catPct === 100 && catTasks.length ? '#10B981' : 'inherit' }}>{catPct}%</span>
                      </div>
                      <div className="text-[11px] text-gray-400 mt-1">{c.startTime} - {c.endTime} · {catDone}/{catTasks.length} tasks</div>
                      {catTasks.length > 0 && (
                        <div className="mt-2 space-y-0.5">
                          {catTasks.map((t, ti) => (
                            <div key={ti} className={`text-xs py-0.5 ${t.done ? 'text-gray-400' : 'text-gray-700'}`}>
                              {t.done ? '✅' : '⬜'} {t.text}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══ COMPANY OVERVIEW TAB ═══ */}
      {activeView === 'company' && (
        <>
          {/* Org Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
              <div className="text-2xl font-extrabold text-indigo-600">{orgStats.totalTasks || 0}</div>
              <div className="text-xs text-gray-500">Org Tasks</div>
            </div>
            <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
              <div className="text-2xl font-extrabold text-emerald-600">{orgStats.completedTasks || 0}</div>
              <div className="text-xs text-gray-500">Completed</div>
            </div>
            <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
              <div className="text-2xl font-extrabold text-red-600">{orgStats.overdueTasks || 0}</div>
              <div className="text-xs text-gray-500">Overdue</div>
            </div>
            <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
              <div className="text-2xl font-extrabold text-purple-600">{orgStats.overallPct || 0}%</div>
              <div className="text-xs text-gray-500">Overall</div>
            </div>
          </div>

          {/* Department Progress */}
          <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
            <Building2 size={16} className="text-indigo-500" /> Department Progress
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {departments.map(dept => (
              <div key={dept.id} className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-1" style={{ background: dept.color }} />
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm font-bold text-gray-900">{dept.name}</div>
                    <div className="text-[11px] text-gray-500">{dept.memberCount} members</div>
                  </div>
                  <div className="text-2xl font-extrabold" style={{ color: dept.pct === 100 ? '#10B981' : dept.color }}>{dept.pct}%</div>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${dept.pct}%`, background: dept.color }} />
                </div>
                <div className="flex gap-3 mt-2 text-[10px] font-semibold">
                  <span className="text-emerald-600">{dept.completedCount} done</span>
                  <span className="text-blue-600">{dept.workingCount} working</span>
                  {dept.stuckCount > 0 && <span className="text-red-500">{dept.stuckCount} stuck</span>}
                </div>
              </div>
            ))}
          </div>

          {/* Team Activity */}
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
              <Users size={16} className="text-indigo-500" /> Team Activity
            </h3>
            <div className="flex gap-1.5 flex-wrap flex-1">
              <button onClick={() => setDeptFilter('all')}
                className={`px-3 py-1 rounded-lg text-[11px] font-semibold ${deptFilter === 'all' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 border border-gray-200'}`}>
                All
              </button>
              {uniqueDepts.map(d => (
                <button key={d} onClick={() => setDeptFilter(d)}
                  className={`px-3 py-1 rounded-lg text-[11px] font-semibold ${deptFilter === d ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 border border-gray-200'}`}>
                  {d}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search team..." className="pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg outline-none focus:border-indigo-300 w-40" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
            {searchedTeam.map(member => (
              <div key={member.id} className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm hover:shadow-md transition-all">
                <div className="flex items-center gap-3 mb-3">
                  <Avatar name={member.name} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-gray-900 truncate">{member.name}</div>
                    <div className="text-[11px] text-gray-500">{member.designation || member.department || member.role}</div>
                  </div>
                  <div className="text-lg font-extrabold" style={{ color: member.pct === 100 ? '#10B981' : '#4F46E5' }}>{member.pct}%</div>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-2">
                  <div className="h-full rounded-full bg-indigo-500" style={{ width: `${member.pct}%` }} />
                </div>
                <div className="flex gap-3 text-[10px] font-semibold mb-2">
                  <span className="text-gray-500">{member.tasksTotal} total</span>
                  <span className="text-emerald-600">{member.tasksDone} done</span>
                  {member.tasksStuck > 0 && <span className="text-red-500">{member.tasksStuck} stuck</span>}
                </div>
                {member.currentTask && (
                  <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs">
                    <span className="text-gray-400">Working on: </span>
                    <span className="text-gray-700 font-semibold">{member.currentTask.title}</span>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Board Progress */}
          {boards.length > 0 && (
            <>
              <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
                <Briefcase size={16} className="text-indigo-500" /> Boards
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {boards.map(b => (
                  <div key={b.id} className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm">
                    <div className="flex items-center gap-2 mb-2">
                      <div className="w-3 h-3 rounded" style={{ background: b.color || '#6B7280' }} />
                      <span className="text-xs font-bold text-gray-800 truncate">{b.name}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-extrabold" style={{ color: b.pct === 100 ? '#10B981' : '#1A1D26' }}>{b.pct}%</span>
                      <span className="text-[10px] text-gray-400">{b.completedCount}/{b.taskCount}</span>
                    </div>
                    <div className="h-1 bg-gray-100 rounded-full mt-2 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${b.pct}%`, background: b.color || '#6B7280' }} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
