import React, { useState, useEffect, useMemo } from 'react';
import { Crown, Users, CheckCircle2, Clock, AlertTriangle, TrendingUp, Building2, Briefcase, FileText, Download, BarChart3, Circle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import Avatar from '../components/common/Avatar';
import { STATUS_CONFIG } from '../utils/constants';

const HOURS = Array.from({ length: 13 }, (_, i) => i + 8); // 8AM to 8PM

function formatHour(h) {
  if (h === 0 || h === 12) return '12';
  return h > 12 ? `${h - 12}` : `${h}`;
}
function ampm(h) { return h >= 12 ? 'PM' : 'AM'; }

export default function DirectorDashboardPage() {
  const { user, isDirector, isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState('overview'); // overview | timeline | team
  const [deptFilter, setDeptFilter] = useState('all');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    try {
      setLoading(true);
      const res = await api.get('/dashboard/director');
      setData(res.data?.data || res.data);
    } catch (err) {
      console.error('Director dashboard error:', err);
    } finally {
      setLoading(false);
    }
  }

  if (!isDirector && !isAdmin) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Crown size={48} className="text-gray-300 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-gray-700">Director Access Required</h2>
          <p className="text-sm text-gray-500 mt-2">This dashboard is available for director-level users.</p>
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

  if (!data) return <div className="p-8 text-center text-gray-500">Failed to load dashboard data.</div>;

  const { orgStats, departments, teamSnapshot, todayBlocks, boards } = data;
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const nowHour = new Date().getHours();
  const nowMin = new Date().getMinutes();

  // Current time block
  const currentBlock = todayBlocks.find(b => {
    const [sh, sm] = b.startTime.split(':').map(Number);
    const [eh, em] = b.endTime.split(':').map(Number);
    const now = nowHour * 60 + nowMin;
    return now >= sh * 60 + sm && now < eh * 60 + em;
  });

  // Filter team by department
  const filteredTeam = deptFilter === 'all' ? teamSnapshot : teamSnapshot.filter(m => m.department === deptFilter);
  const uniqueDepts = [...new Set(teamSnapshot.map(m => m.department).filter(Boolean))];

  return (
    <div className="p-4 sm:p-8 max-w-[1400px] mx-auto">

      {/* ═══ HEADER ═══ */}
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
          {['overview', 'timeline', 'team'].map(v => (
            <button key={v} onClick={() => setActiveView(v)}
              className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all ${activeView === v ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'}`}>
              {v === 'overview' ? 'Overview' : v === 'timeline' ? 'My Timeline' : 'Team View'}
            </button>
          ))}
        </div>
      </div>

      {/* ═══ STAT CARDS ═══ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          { label: 'Total Tasks', value: orgStats.totalTasks, icon: FileText, color: 'indigo', gradient: 'from-indigo-500 to-indigo-600' },
          { label: 'Completed', value: orgStats.completedTasks, icon: CheckCircle2, color: 'emerald', gradient: 'from-emerald-500 to-emerald-600' },
          { label: 'In Progress', value: orgStats.workingTasks, icon: Clock, color: 'amber', gradient: 'from-amber-500 to-amber-600' },
          { label: 'Overall Progress', value: `${orgStats.overallPct}%`, icon: TrendingUp, color: 'purple', gradient: 'from-purple-500 to-purple-600' },
        ].map((s, i) => (
          <div key={i} className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm hover:shadow-md transition-all group">
            <div className="flex items-center justify-between mb-3">
              <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${s.gradient} flex items-center justify-center shadow-sm`}>
                <s.icon size={18} className="text-white" />
              </div>
              {typeof s.value === 'string' && s.value.includes('%') && (
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${orgStats.overallPct >= 70 ? 'bg-emerald-50 text-emerald-600' : orgStats.overallPct >= 40 ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-600'}`}>
                  {orgStats.overallPct >= 70 ? 'On Track' : orgStats.overallPct >= 40 ? 'In Progress' : 'Needs Attention'}
                </span>
              )}
            </div>
            <div className="text-3xl font-extrabold text-gray-900 tracking-tight">{s.value}</div>
            <div className="text-xs text-gray-500 mt-1 font-medium">{s.label}</div>
          </div>
        ))}
      </div>

      {/* ═══ SECONDARY STATS ═══ */}
      <div className="grid grid-cols-3 gap-3 mb-8">
        <div className="bg-red-50 rounded-xl p-4 border border-red-100">
          <div className="text-2xl font-extrabold text-red-600">{orgStats.overdueTasks}</div>
          <div className="text-xs text-red-500 font-medium">Overdue</div>
        </div>
        <div className="bg-yellow-50 rounded-xl p-4 border border-yellow-100">
          <div className="text-2xl font-extrabold text-yellow-600">{orgStats.stuckTasks}</div>
          <div className="text-xs text-yellow-500 font-medium">Stuck</div>
        </div>
        <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
          <div className="text-2xl font-extrabold text-blue-600">{orgStats.completedToday}</div>
          <div className="text-xs text-blue-500 font-medium">Completed Today</div>
        </div>
      </div>

      {/* ═══ TIMELINE STRIP ═══ */}
      {(activeView === 'overview' || activeView === 'timeline') && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 mb-8">
          <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
            <Clock size={16} className="text-indigo-500" /> Today's Schedule
          </h3>
          <div className="flex gap-1 overflow-x-auto pb-2">
            {HOURS.map(h => {
              const isCurrent = h === nowHour;
              const block = todayBlocks.find(b => {
                const [sh] = b.startTime.split(':').map(Number);
                const [eh] = b.endTime.split(':').map(Number);
                return h >= sh && h < eh;
              });
              return (
                <div key={h} className={`flex-1 min-w-[70px] text-center py-3 px-2 rounded-xl transition-all cursor-default
                  ${isCurrent ? 'bg-emerald-50 border-2 border-emerald-200' : block ? 'bg-indigo-50 border border-indigo-100' : 'border border-gray-50 hover:bg-gray-50'}`}
                  title={block?.description || ''}>
                  <div className={`text-[10px] font-mono font-semibold ${isCurrent ? 'text-emerald-600' : 'text-gray-400'}`}>
                    {formatHour(h)} {ampm(h)}
                  </div>
                  {block ? (
                    <div className="text-[10px] text-indigo-600 font-semibold mt-1 truncate">{block.description?.slice(0, 12) || 'Busy'}</div>
                  ) : (
                    <div className="text-[10px] text-gray-300 mt-1">-</div>
                  )}
                  <div className={`w-2 h-2 rounded-full mx-auto mt-1 ${isCurrent ? 'bg-emerald-500 animate-pulse' : block ? 'bg-indigo-400' : 'bg-gray-200'}`} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ OVERVIEW TAB ═══ */}
      {activeView === 'overview' && (
        <>
          {/* Department Cards */}
          <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
            <Building2 size={16} className="text-indigo-500" /> Department Progress
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {departments.map(dept => (
              <div key={dept.id} className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm hover:shadow-md transition-all relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-1 rounded-t-2xl" style={{ background: dept.color }} />
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg" style={{ background: dept.color + '18' }}>
                      <Building2 size={18} style={{ color: dept.color }} />
                    </div>
                    <div>
                      <div className="text-sm font-bold text-gray-900">{dept.name}</div>
                      <div className="text-[11px] text-gray-500">{dept.memberCount} members</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-extrabold" style={{ color: dept.pct === 100 ? '#10B981' : dept.color }}>{dept.pct}%</div>
                    <div className="text-[11px] text-gray-400">{dept.completedCount}/{dept.taskCount}</div>
                  </div>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${dept.pct}%`, background: `linear-gradient(90deg, ${dept.color}, ${dept.color}99)` }} />
                </div>
                <div className="flex gap-3 mt-3 text-[10px] font-semibold">
                  <span className="text-emerald-600">{dept.completedCount} done</span>
                  <span className="text-blue-600">{dept.workingCount} working</span>
                  {dept.stuckCount > 0 && <span className="text-red-500">{dept.stuckCount} stuck</span>}
                </div>
              </div>
            ))}
            {departments.length === 0 && (
              <div className="col-span-full text-center py-8 text-gray-400 text-sm">No departments found. Set up departments in Team settings.</div>
            )}
          </div>

          {/* Board Summary */}
          {boards && boards.length > 0 && (
            <>
              <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
                <Briefcase size={16} className="text-indigo-500" /> Board Progress
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-8">
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

      {/* ═══ TIMELINE TAB — Full vertical timeline ═══ */}
      {activeView === 'timeline' && (
        <div className="max-w-2xl">
          <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2">
            <Clock size={16} className="text-indigo-500" /> Full Day Timeline
          </h3>
          {todayBlocks.length === 0 ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-8 text-center">
              <Clock size={40} className="text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500 font-medium">No time blocks scheduled for today.</p>
              <p className="text-xs text-gray-400 mt-1">Your PA/manager can plan your day via Time Plan → Team View.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {todayBlocks.map((block, i) => {
                const isCurrent = currentBlock?.id === block.id;
                return (
                  <div key={block.id} className="flex gap-4">
                    <div className="w-20 text-right pt-4 flex-shrink-0">
                      <div className={`text-xs font-mono font-semibold ${isCurrent ? 'text-emerald-600' : 'text-gray-400'}`}>
                        {block.startTime}
                      </div>
                      <div className="text-[10px] text-gray-300">{block.endTime}</div>
                    </div>
                    <div className="flex flex-col items-center w-6">
                      <div className={`w-3 h-3 rounded-full mt-4 flex-shrink-0 ${isCurrent ? 'bg-emerald-500 ring-4 ring-emerald-100' : 'bg-indigo-400'}`} />
                      {i < todayBlocks.length - 1 && <div className="w-0.5 flex-1 bg-gray-200" />}
                    </div>
                    <div className={`flex-1 p-4 rounded-2xl border mb-1 ${isCurrent ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-gray-100'} shadow-sm`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-gray-900">{block.description || 'Scheduled Block'}</span>
                          {isCurrent && <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold">NOW</span>}
                        </div>
                      </div>
                      {block.task && (
                        <div className="mt-2 text-xs text-gray-500 flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${STATUS_CONFIG[block.task.status]?.color ? '' : 'bg-gray-400'}`}
                            style={{ background: STATUS_CONFIG[block.task.status]?.bgColor || '#9CA3AF' }} />
                          {block.task.title}
                        </div>
                      )}
                      {block.board && (
                        <div className="mt-1 text-[10px] text-gray-400 flex items-center gap-1">
                          <div className="w-2 h-2 rounded-sm" style={{ background: block.board.color || '#6B7280' }} />
                          {block.board.name}
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

      {/* ═══ TEAM TAB ═══ */}
      {activeView === 'team' && (
        <>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
              <Users size={16} className="text-indigo-500" /> Team Activity
            </h3>
            <div className="flex gap-1.5 flex-wrap">
              <button onClick={() => setDeptFilter('all')}
                className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-all ${deptFilter === 'all' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 border border-gray-200'}`}>
                All ({teamSnapshot.length})
              </button>
              {uniqueDepts.map(d => (
                <button key={d} onClick={() => setDeptFilter(d)}
                  className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-all ${deptFilter === d ? 'bg-indigo-600 text-white' : 'bg-white text-gray-500 border border-gray-200'}`}>
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredTeam.map(member => (
              <div key={member.id} className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm hover:shadow-md transition-all">
                <div className="flex items-center gap-3 mb-3">
                  <Avatar name={member.name} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-gray-900 truncate">{member.name}</div>
                    <div className="text-[11px] text-gray-500">{member.designation || member.department || member.role}</div>
                  </div>
                  <div className="text-right">
                    <div className={`text-lg font-extrabold ${member.pct === 100 ? 'text-emerald-500' : member.pct >= 50 ? 'text-indigo-600' : 'text-gray-900'}`}>{member.pct}%</div>
                  </div>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-3">
                  <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${member.pct}%` }} />
                </div>
                <div className="flex gap-3 text-[10px] font-semibold mb-2">
                  <span className="text-gray-500">{member.tasksTotal} total</span>
                  <span className="text-emerald-600">{member.tasksDone} done</span>
                  <span className="text-blue-600">{member.tasksWorking} working</span>
                  {member.tasksStuck > 0 && <span className="text-red-500">{member.tasksStuck} stuck</span>}
                </div>
                {member.currentTask && (
                  <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs">
                    <span className="text-gray-400 font-medium">Working on: </span>
                    <span className="text-gray-700 font-semibold">{member.currentTask.title}</span>
                    {member.currentTask.boardName && (
                      <span className="text-gray-400 ml-1">({member.currentTask.boardName})</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
