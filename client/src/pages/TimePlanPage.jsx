import React, { useState, useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Plus, Clock, Calendar, Users, Eye, Save, FolderOpen, X, Trash2, Edit3, CalendarDays, Link as LinkIcon } from 'lucide-react';
import { format, addDays, subDays, parseISO, isToday, startOfWeek, endOfWeek, eachDayOfInterval, addWeeks, subWeeks } from 'date-fns';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/common/Avatar';
import TimeBlockForm from '../components/timeplan/TimeBlockForm';
import useSocket from '../hooks/useSocket';
import { useToast } from '../components/common/Toast';

const HOURS = Array.from({ length: 13 }, (_, i) => i + 8); // 8AM - 8PM
const BLOCK_COLORS = ['#4285f4', '#00c875', '#fdab3d', '#e2445c', '#a855f7', '#0ea5e9', '#f97316', '#06b6d4'];
const MIN_BLOCK_HEIGHT = 28; // minimum px height so short tasks stay visible
const COLUMN_GAP = 2; // px gap between side-by-side blocks
const COLUMN_PADDING = 4; // px padding on left/right edges of day column

function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minsToPos(mins) { return ((mins - 480) / 60) * 60; } // 480 = 8AM in mins, 60px/hour

/**
 * Compute overlap layout for a list of time items.
 * Each item must have startTime and endTime ("HH:MM" strings).
 * Returns a Map of item → { col, totalCols } for width/offset calculation.
 */
function computeOverlapLayout(items) {
  if (!items.length) return new Map();

  // Sort by start time, then by longer duration first (so wider blocks come first)
  const sorted = [...items].sort((a, b) => {
    const aStart = timeToMinutes(a.startTime);
    const bStart = timeToMinutes(b.startTime);
    if (aStart !== bStart) return aStart - bStart;
    // Longer duration first
    const aDur = timeToMinutes(a.endTime) - aStart;
    const bDur = timeToMinutes(b.endTime) - bStart;
    return bDur - aDur;
  });

  // Build overlap clusters using a sweep approach
  // Two items overlap if one starts before the other ends
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = timeToMinutes(sorted[0].endTime);

  for (let i = 1; i < sorted.length; i++) {
    const itemStart = timeToMinutes(sorted[i].startTime);
    if (itemStart < clusterEnd) {
      // Overlaps with current cluster
      currentCluster.push(sorted[i]);
      clusterEnd = Math.max(clusterEnd, timeToMinutes(sorted[i].endTime));
    } else {
      // No overlap — start new cluster
      clusters.push(currentCluster);
      currentCluster = [sorted[i]];
      clusterEnd = timeToMinutes(sorted[i].endTime);
    }
  }
  clusters.push(currentCluster);

  // For each cluster, assign column indices using a greedy algorithm
  const layoutMap = new Map();

  for (const cluster of clusters) {
    const columns = []; // each column tracks the end time of its last item

    for (const item of cluster) {
      const itemStart = timeToMinutes(item.startTime);
      // Find the first column where this item fits (no overlap)
      let placed = false;
      for (let c = 0; c < columns.length; c++) {
        if (itemStart >= columns[c]) {
          columns[c] = timeToMinutes(item.endTime);
          layoutMap.set(item, { col: c, totalCols: 0 }); // totalCols set below
          placed = true;
          break;
        }
      }
      if (!placed) {
        layoutMap.set(item, { col: columns.length, totalCols: 0 });
        columns.push(timeToMinutes(item.endTime));
      }
    }

    // Set totalCols for all items in this cluster
    const totalCols = columns.length;
    for (const item of cluster) {
      layoutMap.get(item).totalCols = totalCols;
    }
  }

  return layoutMap;
}

export default function TimePlanPage() {
  const { canManage, user } = useAuth();
  const { error: toastError } = useToast();
  const [weekStart, setWeekStart] = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [allBlocks, setAllBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editBlock, setEditBlock] = useState(null);
  const [formDate, setFormDate] = useState(new Date().toISOString().slice(0, 10));
  const [forUserId, setForUserId] = useState(null);
  const [viewMode, setViewMode] = useState('my');
  const [teamData, setTeamData] = useState([]);
  const [viewingEmployee, setViewingEmployee] = useState(null);
  const [employeeBlocks, setEmployeeBlocks] = useState([]);
  const [templates, setTemplates] = useState(() => JSON.parse(localStorage.getItem('timePlanTemplates') || '[]'));
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [allDayEvents, setAllDayEvents] = useState([]);
  const [teamsSynced, setTeamsSynced] = useState(null);
  const [employeeCalendarEvents, setEmployeeCalendarEvents] = useState([]);
  const [employeeAllDayEvents, setEmployeeAllDayEvents] = useState([]);

  const weekDays = useMemo(() => eachDayOfInterval({
    start: weekStart,
    end: endOfWeek(weekStart, { weekStartsOn: 1 }),
  }).slice(0, 5), [weekStart]); // Mon-Fri

  useEffect(() => {
    if (viewMode === 'my') loadWeekBlocks();
    else loadTeamBlocks();
  }, [weekStart, viewMode]);

  useSocket('task:updated', () => { if (viewMode === 'my') loadWeekBlocks(); });

  async function loadWeekBlocks() {
    try {
      setLoading(true);
      const from = format(weekDays[0], 'yyyy-MM-dd');
      const to = format(weekDays[weekDays.length - 1], 'yyyy-MM-dd');

      const [blocksRes, calRes] = await Promise.all([
        api.get(`/timeplans/my?from=${from}&to=${to}`),
        api.get(`/timeplans/calendar-events?from=${from}&to=${to}`).catch(() => ({ data: { data: { events: [], allDayEvents: [], synced: null } } })),
      ]);

      setAllBlocks(blocksRes.data.data || blocksRes.data.blocks || []);

      const calData = calRes.data?.data || {};
      setCalendarEvents(calData.events || []);
      setAllDayEvents(calData.allDayEvents || []);
      setTeamsSynced(calData.synced ?? null);
    } catch (err) {
      console.error('Failed to load blocks:', err);
      toastError('Failed to load time blocks');
      setAllBlocks([]);
    } finally { setLoading(false); }
  }

  async function loadTeamBlocks() {
    try {
      setLoading(true);
      const date = format(weekDays[0], 'yyyy-MM-dd');
      const res = await api.get(`/timeplans/team?date=${date}`);
      setTeamData(res.data.data || []);
    } catch (err) {
      console.error('Failed to load team blocks:', err);
      toastError('Failed to load team schedule');
    } finally { setLoading(false); }
  }

  async function loadEmployeeBlocks(userId, userName) {
    try {
      const from = format(weekDays[0], 'yyyy-MM-dd');
      const to = format(weekDays[weekDays.length - 1], 'yyyy-MM-dd');

      const [blocksRes, calRes] = await Promise.all([
        api.get(`/timeplans/employee/${userId}?from=${from}&to=${to}`),
        api.get(`/timeplans/calendar-events/${userId}?from=${from}&to=${to}`).catch(() => ({ data: { data: { events: [], allDayEvents: [], synced: null } } })),
      ]);

      const data = blocksRes.data.data || {};
      setEmployeeBlocks(data.blocks || []);
      setViewingEmployee(data.employee || { id: userId, name: userName });

      const calData = calRes.data?.data || {};
      setEmployeeCalendarEvents(calData.events || []);
      setEmployeeAllDayEvents(calData.allDayEvents || []);
    } catch (err) { toastError('Failed to load employee schedule'); }
  }

  async function handleDelete(id) {
    try {
      await api.delete(`/timeplans/${id}`);
      loadWeekBlocks();
    } catch (err) { toastError('Failed to delete time block'); }
  }

  function handleAddBlock(date) {
    setFormDate(date);
    setEditBlock(null);
    setShowForm(true);
  }

  function handleEditBlock(block) {
    setFormDate(block.date);
    setEditBlock(block);
    setShowForm(true);
  }

  // Template functions
  function saveAsTemplate() {
    const name = prompt('Template name:');
    if (!name) return;
    const templateBlocks = allBlocks.map(b => ({
      dayOfWeek: new Date(b.date).getDay(), // 0=Sun, 1=Mon, etc.
      startTime: b.startTime,
      endTime: b.endTime,
      description: b.description,
    }));
    const newTemplates = [...templates, { id: Date.now(), name, blocks: templateBlocks }];
    setTemplates(newTemplates);
    localStorage.setItem('timePlanTemplates', JSON.stringify(newTemplates));
  }

  async function applyTemplate(template) {
    if (!confirm(`Apply "${template.name}" to this week? This will add blocks for each day.`)) return;
    try {
      for (const tb of template.blocks) {
        const dayDate = weekDays.find(d => d.getDay() === tb.dayOfWeek);
        if (!dayDate) continue;
        await api.post('/timeplans', {
          date: format(dayDate, 'yyyy-MM-dd'),
          startTime: tb.startTime,
          endTime: tb.endTime,
          description: tb.description,
        });
      }
      loadWeekBlocks();
    } catch (err) {
      console.error('Failed to apply template:', err);
      toastError('Failed to apply template');
    }
  }

  function deleteTemplate(id) {
    const newTemplates = templates.filter(t => t.id !== id);
    setTemplates(newTemplates);
    localStorage.setItem('timePlanTemplates', JSON.stringify(newTemplates));
  }

  // Stats
  const totalMins = allBlocks.reduce((sum, b) => sum + timeToMinutes(b.endTime) - timeToMinutes(b.startTime), 0);
  const teamsMeetingMins = calendarEvents.reduce((sum, e) => {
    if (e.startTime && e.endTime) return sum + timeToMinutes(e.endTime) - timeToMinutes(e.startTime);
    return sum;
  }, 0);

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <Clock size={20} className="text-primary" /> Time Planner
          </h1>
          <p className="text-sm text-text-secondary mt-0.5">Plan your weekly work schedule</p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <div className="flex items-center bg-surface rounded-lg p-0.5 mr-2">
              <button onClick={() => setViewMode('my')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'my' ? 'bg-white text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}>
                <Calendar size={13} /> My Plan
              </button>
              <button onClick={() => setViewMode('team')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${viewMode === 'team' ? 'bg-white text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`}>
                <Users size={13} /> Team
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Week Navigation + Actions */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button onClick={() => setWeekStart(subWeeks(weekStart, 1))} className="p-1.5 rounded-md hover:bg-surface text-text-secondary"><ChevronLeft size={18} /></button>
          <div className="text-center min-w-[200px]">
            <span className="text-sm font-bold text-text-primary">
              {format(weekDays[0], 'MMM d')} – {format(weekDays[4], 'MMM d, yyyy')}
            </span>
          </div>
          <button onClick={() => setWeekStart(addWeeks(weekStart, 1))} className="p-1.5 rounded-md hover:bg-surface text-text-secondary"><ChevronRight size={18} /></button>
          <button onClick={() => setWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }))}
            className="ml-2 px-2.5 py-1 text-xs font-medium text-primary bg-primary/10 rounded-md hover:bg-primary/20">This Week</button>
        </div>

        {viewMode === 'my' && (
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-secondary bg-surface px-2.5 py-1 rounded-lg">
              <Clock size={11} className="inline mr-1" />{Math.floor(totalMins / 60)}h {totalMins % 60 > 0 ? `${totalMins % 60}m` : ''} planned
            </span>
            {teamsMeetingMins > 0 && (
              <span className="text-xs font-medium text-[#7b83eb] bg-[#7b83eb]/10 px-2.5 py-1 rounded-lg">
                <CalendarDays size={11} className="inline mr-1" />{Math.floor(teamsMeetingMins / 60)}h {teamsMeetingMins % 60 > 0 ? `${teamsMeetingMins % 60}m` : ''} in Teams
              </span>
            )}

            {/* Templates */}
            {templates.length > 0 && (
              <div className="relative group">
                <button className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface rounded-lg border border-border">
                  <FolderOpen size={13} /> Templates
                </button>
                <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-dropdown border border-border py-1 min-w-[200px] hidden group-hover:block z-30">
                  {templates.map(t => (
                    <div key={t.id} className="flex items-center gap-2 px-3 py-2 hover:bg-surface">
                      <button onClick={() => applyTemplate(t)} className="flex-1 text-left text-xs font-medium text-text-primary">{t.name}</button>
                      <span className="text-[10px] text-text-tertiary">{t.blocks.length} blocks</span>
                      <button onClick={() => deleteTemplate(t.id)} className="text-text-tertiary hover:text-danger"><Trash2 size={11} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button onClick={saveAsTemplate} className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface rounded-lg border border-border">
              <Save size={13} /> Save Template
            </button>
          </div>
        )}
      </div>

      {/* Teams Sync Banner */}
      {!loading && viewMode === 'my' && teamsSynced === false && (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-[#7b83eb]/5 border border-[#7b83eb]/20 rounded-lg">
          <CalendarDays size={16} className="text-[#7b83eb] flex-shrink-0" />
          <p className="text-xs text-text-secondary flex-1">
            Your account is not synced with Microsoft 365. Ask your admin to sync users from the Integrations page to see your Teams calendar here.
          </p>
          <a href="/integrations" className="text-xs font-medium text-[#7b83eb] hover:underline whitespace-nowrap">
            Go to Integrations
          </a>
        </div>
      )}

      {/* Legend */}
      {!loading && viewMode === 'my' && teamsSynced === true && (
        <div className="mb-3 flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-[#4285f4]/15 border-l-[3px] border-[#4285f4]" />
            <span className="text-[10px] text-text-tertiary font-medium">Your time blocks</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-[#7b83eb]/15 border-l-[3px] border-dashed border-[#7b83eb]" />
            <span className="text-[10px] text-text-tertiary font-medium">Teams calendar</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-1.5 rounded-sm bg-[#7b83eb]/20" />
            <span className="text-[10px] text-text-tertiary font-medium">All-day event</span>
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" /></div>
      ) : viewMode === 'my' ? (
        /* WEEKLY TIMELINE VIEW */
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          {/* Day headers */}
          <div className="grid grid-cols-[60px_repeat(5,1fr)] border-b border-border bg-surface/30">
            <div className="px-2 py-3 text-[10px] font-medium text-text-tertiary"></div>
            {weekDays.map(day => {
              const dateStr = format(day, 'yyyy-MM-dd');
              const dayAllDay = allDayEvents.filter(e => e.date === dateStr);
              return (
                <div key={day.toISOString()} className={`px-3 py-3 text-center border-l border-border ${isToday(day) ? 'bg-primary/5' : ''}`}>
                  <p className="text-[10px] uppercase tracking-wider font-semibold text-text-tertiary">{format(day, 'EEE')}</p>
                  <p className={`text-lg font-bold ${isToday(day) ? 'text-primary' : 'text-text-primary'}`}>{format(day, 'd')}</p>
                  <button onClick={() => handleAddBlock(dateStr)}
                    className="mt-1 text-[10px] text-primary hover:underline font-medium">+ Add</button>
                  {/* All-day Teams events banner */}
                  {dayAllDay.map((evt, i) => (
                    <div key={`allday-${evt.id || i}`} className="mt-1 px-1.5 py-0.5 bg-[#7b83eb]/15 rounded text-[9px] font-medium text-[#7b83eb] truncate" title={evt.subject}>
                      {evt.subject}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {/* Time grid */}
          <div className="grid grid-cols-[60px_repeat(5,1fr)] relative" style={{ height: HOURS.length * 60 }}>
            {/* Hour labels */}
            <div className="relative border-r border-border">
              {HOURS.map(h => (
                <div key={h} className="absolute left-0 right-0 flex items-start" style={{ top: (h - 8) * 60 }}>
                  <span className="text-[10px] text-text-tertiary w-full text-right pr-2 -mt-1.5 select-none">
                    {h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`}
                  </span>
                </div>
              ))}
            </div>

            {/* Day columns */}
            {weekDays.map((day, dayIdx) => {
              const dateStr = format(day, 'yyyy-MM-dd');
              const dayBlocks = allBlocks.filter(b => b.date === dateStr);
              return (
                <div key={dateStr} className={`relative border-l border-border ${isToday(day) ? 'bg-primary/[0.02]' : ''}`}>
                  {/* Hour grid lines */}
                  {HOURS.map(h => (
                    <div key={h} className="absolute left-0 right-0 border-t border-border/30" style={{ top: (h - 8) * 60 }} />
                  ))}
                  {/* Half-hour lines */}
                  {HOURS.map(h => (
                    <div key={`h-${h}`} className="absolute left-0 right-0 border-t border-border/10" style={{ top: (h - 8) * 60 + 30 }} />
                  ))}

                  {/* Current time line */}
                  {isToday(day) && (() => {
                    const now = new Date();
                    const mins = now.getHours() * 60 + now.getMinutes();
                    if (mins < 480 || mins > 1260) return null;
                    return (
                      <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: minsToPos(mins) }}>
                        <div className="flex items-center">
                          <div className="w-2 h-2 rounded-full bg-danger -ml-1" />
                          <div className="flex-1 border-t-2 border-danger" />
                        </div>
                      </div>
                    );
                  })()}

                  {/* Time blocks + Teams calendar events with overlap layout */}
                  {(() => {
                    const dayTeamsEvents = calendarEvents.filter(e => e.date === dateStr);
                    // Combine blocks and teams events for unified overlap detection
                    const allItems = [
                      ...dayBlocks.map(b => ({ ...b, _type: 'block' })),
                      ...dayTeamsEvents.map(e => ({ ...e, _type: 'teams' })),
                    ];
                    const layoutMap = computeOverlapLayout(allItems);

                    return allItems.map((item, idx) => {
                      const layout = layoutMap.get(item) || { col: 0, totalCols: 1 };
                      const startMins = timeToMinutes(item.startTime);
                      const endMins = timeToMinutes(item.endTime);
                      const top = minsToPos(startMins);
                      const height = Math.max(((endMins - startMins) / 60) * 60, MIN_BLOCK_HEIGHT);

                      // Calculate horizontal position within the day column
                      const usableWidth = 100 - COLUMN_PADDING * 2;
                      const leftPercent = COLUMN_PADDING + layout.col * usableWidth / layout.totalCols;
                      const widthPercent = usableWidth / layout.totalCols - (layout.totalCols > 1 ? COLUMN_GAP / 2 : 0);

                      if (item._type === 'teams') {
                        return (
                          <div key={`teams-${item.id || idx}`}
                            className="absolute rounded-md px-1.5 py-1 z-[5] overflow-hidden pointer-events-auto"
                            style={{
                              top, height,
                              left: `calc(${leftPercent}% + ${layout.col > 0 ? COLUMN_GAP / 2 : 0}px)`,
                              width: `calc(${widthPercent}%)`,
                              backgroundColor: '#7b83eb12', borderLeft: '3px dashed #7b83eb', opacity: 0.85,
                            }}
                            title={`Teams: ${item.subject}\n${item.startTime}–${item.endTime}${item.location ? '\n📍 ' + item.location : ''}`}>
                            <div className="flex items-center gap-1">
                              <CalendarDays size={9} className="text-[#7b83eb] flex-shrink-0" />
                              <p className="text-[10px] font-semibold text-[#7b83eb] truncate">{item.startTime}–{item.endTime}</p>
                            </div>
                            {height > 30 && (
                              <p className="text-[10px] text-text-primary font-medium truncate">{item.subject}</p>
                            )}
                            {height > 48 && item.location && (
                              <p className="text-[9px] text-text-tertiary truncate">📍 {item.location}</p>
                            )}
                          </div>
                        );
                      }

                      // Regular time block
                      const color = BLOCK_COLORS[(dayIdx + idx) % BLOCK_COLORS.length];
                      return (
                        <div key={item.id}
                          className="absolute rounded-md px-1.5 py-1 cursor-pointer group hover:shadow-md transition-shadow overflow-hidden z-10"
                          style={{
                            top, height,
                            left: `calc(${leftPercent}% + ${layout.col > 0 ? COLUMN_GAP / 2 : 0}px)`,
                            width: `calc(${widthPercent}%)`,
                            backgroundColor: `${color}15`, borderLeft: `3px solid ${color}`,
                          }}
                          onClick={() => handleEditBlock(item)}>
                          <div className="flex items-start justify-between">
                            <div className="flex-1 min-w-0">
                              <p className="text-[10px] font-semibold truncate" style={{ color }}>{item.startTime}–{item.endTime}</p>
                              {(item.task?.title || item.description) && height > 30 && (
                                <p className="text-[10px] text-text-primary font-medium truncate">{item.task?.title || item.description}</p>
                              )}
                            </div>
                            {widthPercent > 20 && (
                              <button onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                                className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-danger p-0.5 flex-shrink-0"><Trash2 size={10} /></button>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}

                  {/* Click to add (empty area) */}
                  <div className="absolute inset-0 z-0 cursor-pointer" onClick={() => handleAddBlock(dateStr)} />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* TEAM VIEW */
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-surface/30">
            <h3 className="text-sm font-semibold text-text-primary">Team Schedule — Week of {format(weekDays[0], 'MMM d')}</h3>
          </div>
          {teamData.length === 0 ? (
            <div className="text-center py-16">
              <Users size={40} className="mx-auto text-text-tertiary mb-3" />
              <p className="text-sm text-text-secondary">No team time plans for this week</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {teamData.map(entry => {
                const teamMins = entry.blocks.reduce((sum, b) => sum + timeToMinutes(b.endTime) - timeToMinutes(b.startTime), 0);
                return (
                  <div key={entry.user.id} className="px-5 py-4 hover:bg-surface/20 transition-colors">
                    <div className="flex items-center gap-3">
                      <Avatar name={entry.user.name} size="md" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-text-primary">{entry.user.name}</p>
                        <p className="text-[10px] text-text-tertiary">{entry.user.designation || entry.user.department || 'Team member'}</p>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="text-xs font-medium text-text-primary">{entry.blocks.length} blocks</p>
                          <p className="text-[10px] text-text-tertiary">{Math.floor(teamMins / 60)}h {teamMins % 60 > 0 ? `${teamMins % 60}m` : ''}</p>
                        </div>
                        {/* Mini bar chart */}
                        <div className="flex items-end gap-0.5 h-6">
                          {weekDays.map((day, i) => {
                            const dateStr = format(day, 'yyyy-MM-dd');
                            const dayCount = entry.blocks.filter(b => b.date === dateStr).length;
                            const barH = dayCount > 0 ? Math.max(dayCount * 8, 4) : 2;
                            return (
                              <div key={i} className="w-3 rounded-t-sm transition-all" title={`${format(day, 'EEE')}: ${dayCount} blocks`}
                                style={{ height: barH, backgroundColor: dayCount > 0 ? '#0073ea' : '#e6e9ef' }} />
                            );
                          })}
                        </div>
                        <button onClick={() => loadEmployeeBlocks(entry.user.id, entry.user.name)}
                          className="flex items-center gap-1 text-xs text-primary hover:text-primary-600 font-medium px-2 py-1 rounded hover:bg-primary/5">
                          <Eye size={12} /> View
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Employee Detail Modal */}
      {viewingEmployee && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => { setViewingEmployee(null); setEmployeeBlocks([]); setEmployeeCalendarEvents([]); setEmployeeAllDayEvents([]); }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl mx-4 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
              <div className="flex items-center gap-2.5">
                <Avatar name={viewingEmployee.name} size="md" />
                <div>
                  <h3 className="text-sm font-bold text-text-primary">{viewingEmployee.name}'s Weekly Schedule</h3>
                  <p className="text-xs text-text-tertiary">{format(weekDays[0], 'MMM d')} – {format(weekDays[4], 'MMM d, yyyy')}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => { setFormDate(format(new Date(), 'yyyy-MM-dd')); setEditBlock(null); setForUserId(viewingEmployee.id); setShowForm(true); }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-primary text-white hover:bg-primary/90 flex items-center gap-1">
                  <Plus size={12} /> Add Block for {viewingEmployee.name?.split(' ')[0]}
                </button>
                <button onClick={() => { setViewingEmployee(null); setEmployeeBlocks([]); setEmployeeCalendarEvents([]); setEmployeeAllDayEvents([]); }} className="p-1.5 rounded-md hover:bg-surface text-text-secondary"><X size={16} /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {employeeBlocks.length === 0 && employeeCalendarEvents.length === 0 ? (
                <div className="text-center py-12"><Clock size={32} className="mx-auto text-text-tertiary mb-2" /><p className="text-sm text-text-secondary">No time blocks or meetings this week</p></div>
              ) : (
                <div className="grid grid-cols-5 gap-3">
                  {weekDays.map(day => {
                    const dateStr = format(day, 'yyyy-MM-dd');
                    const dayBlocks = employeeBlocks.filter(b => b.date === dateStr).sort((a, b) => a.startTime.localeCompare(b.startTime));
                    const dayTeamsEvents = employeeCalendarEvents.filter(e => e.date === dateStr).sort((a, b) => a.startTime.localeCompare(b.startTime));
                    const dayAllDay = employeeAllDayEvents.filter(e => e.date === dateStr);
                    return (
                      <div key={dateStr}>
                        <p className={`text-xs font-semibold mb-2 text-center ${isToday(day) ? 'text-primary' : 'text-text-secondary'}`}>
                          {format(day, 'EEE d')}
                        </p>
                        {/* All-day events */}
                        {dayAllDay.map((evt, i) => (
                          <div key={`emp-allday-${evt.id || i}`} className="mb-1.5 px-2 py-1 bg-[#7b83eb]/10 rounded text-[9px] font-medium text-[#7b83eb] truncate" title={evt.subject}>
                            {evt.subject}
                          </div>
                        ))}
                        <div className="space-y-1.5">
                          {dayBlocks.length === 0 && dayTeamsEvents.length === 0 ? (
                            <p className="text-[10px] text-text-tertiary text-center py-4">No blocks</p>
                          ) : (
                            <>
                              {dayBlocks.map((b, i) => (
                                <div key={b.id} className="rounded-md px-2 py-1.5 border-l-[3px]" style={{ backgroundColor: `${BLOCK_COLORS[i % BLOCK_COLORS.length]}10`, borderLeftColor: BLOCK_COLORS[i % BLOCK_COLORS.length] }}>
                                  <p className="text-[10px] font-semibold" style={{ color: BLOCK_COLORS[i % BLOCK_COLORS.length] }}>{b.startTime}–{b.endTime}</p>
                                  <p className="text-[10px] text-text-primary font-medium truncate">{b.task?.title || b.description || '—'}</p>
                                </div>
                              ))}
                              {dayTeamsEvents.map((evt, i) => (
                                <div key={`emp-teams-${evt.id || i}`} className="rounded-md px-2 py-1.5 border-l-[3px] border-dashed" style={{ backgroundColor: '#7b83eb10', borderLeftColor: '#7b83eb' }}>
                                  <div className="flex items-center gap-1">
                                    <CalendarDays size={9} className="text-[#7b83eb] flex-shrink-0" />
                                    <p className="text-[10px] font-semibold text-[#7b83eb]">{evt.startTime}–{evt.endTime}</p>
                                  </div>
                                  <p className="text-[10px] text-text-primary font-medium truncate">{evt.subject}</p>
                                </div>
                              ))}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Time Block Form Modal */}
      {showForm && (
        <TimeBlockForm
          block={editBlock}
          date={formDate}
          forUserId={forUserId}
          onSave={() => { setShowForm(false); setEditBlock(null); setForUserId(null); loadWeekBlocks(); if (viewingEmployee) loadEmployeeBlocks(viewingEmployee); }}
          onClose={() => { setShowForm(false); setEditBlock(null); setForUserId(null); }}
        />
      )}
    </div>
  );
}
