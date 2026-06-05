import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Users, CalendarDays } from 'lucide-react';
import {
  format, startOfWeek, endOfWeek, eachDayOfInterval, addWeeks, subWeeks, addDays, subDays, parseISO,
  startOfMonth, endOfMonth, addMonths, subMonths,
} from 'date-fns';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/common/Avatar';
import TimeBlockModal from '../components/timeplan/TimeBlockModal';
import TimePlannerHeader from '../components/timeplan/TimePlannerHeader';
import DayStrip from '../components/timeplan/DayStrip';
import PlannerCalendar from '../components/timeplan/PlannerCalendar';
import TimeBlockPopover from '../components/timeplan/TimeBlockPopover';
import WorkQueuePanel from '../components/timeplan/WorkQueuePanel';
import TeamPlannerSelector from '../components/timeplan/TeamPlannerSelector';
import PlannerSummaryCards from '../components/timeplan/PlannerSummaryCards';
import PlannerDelegatesModal from '../components/timeplan/PlannerDelegatesModal';
import DayBlocksDialog from '../components/timeplan/DayBlocksDialog';
import useRealtimeEvent from '../realtime/useRealtimeEvent';
import { useToast } from '../components/common/Toast';
import AnistonLoader from '../components/common/AnistonLoader';
import { timeToMinutes, formatDuration, plannedMinutes, TEAMS_HEX } from '../components/timeplan/plannerTheme';

const LS = { queue: 'planner.queueOpen', viewMode: 'planner.viewMode', personId: 'planner.teamPersonId' };

export default function TimePlanPage() {
  const { canManage, isAssistantManager, isTier1 } = useAuth();
  const canSeeTeam = canManage || isAssistantManager;
  const { error: toastError } = useToast();
  const navigate = useNavigate();

  const [weekStart, setWeekStart] = useState(startOfWeek(new Date(), { weekStartsOn: 1 }));
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [view, setView] = useState('week'); // 'week' | 'day' | 'month'
  const [viewMode, setViewMode] = useState(() => (canSeeTeam && localStorage.getItem(LS.viewMode) === 'team' ? 'team' : 'my'));
  const [loading, setLoading] = useState(true);

  // My plan
  const [allBlocks, setAllBlocks] = useState([]);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [allDayEvents, setAllDayEvents] = useState([]);
  const [teamsSynced, setTeamsSynced] = useState(null);
  const [teamsStatus, setTeamsStatus] = useState(null);

  // Team plan
  const [people, setPeople] = useState([]);
  const [teamPerson, setTeamPerson] = useState(null);
  const [teamBlocks, setTeamBlocks] = useState([]);
  const [teamTeamsEvents, setTeamTeamsEvents] = useState([]);
  const [teamAllDay, setTeamAllDay] = useState([]);
  const [personLoading, setPersonLoading] = useState(false);
  const [showDelegates, setShowDelegates] = useState(false);

  // Shared UI
  const [showForm, setShowForm] = useState(false);
  const [editBlock, setEditBlock] = useState(null);
  const [formDate, setFormDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [forUserId, setForUserId] = useState(null);
  const [popover, setPopover] = useState(null); // { item, kind, rect, ownerName, canManage }
  const [showQueue, setShowQueue] = useState(() => localStorage.getItem(LS.queue) === '1'); // default closed
  const [queueVersion, setQueueVersion] = useState(0);
  const [dayDialogDate, setDayDialogDate] = useState(null); // month-view day list

  const weekDays = useMemo(() => eachDayOfInterval({
    start: weekStart,
    end: endOfWeek(weekStart, { weekStartsOn: 1 }),
  }).slice(0, 6), [weekStart]); // Mon–Sat
  const dayDate = useMemo(() => parseISO(selectedDate), [selectedDate]);
  // Fetch range: the whole month in Month view, otherwise the Mon–Sat week.
  const range = useMemo(() => {
    if (view === 'month') {
      const d = parseISO(selectedDate);
      return { from: format(startOfMonth(d), 'yyyy-MM-dd'), to: format(endOfMonth(d), 'yyyy-MM-dd') };
    }
    return { from: format(weekDays[0], 'yyyy-MM-dd'), to: format(weekDays[weekDays.length - 1], 'yyyy-MM-dd') };
  }, [view, selectedDate, weekDays]);

  function toggleQueue() {
    setShowQueue((q) => { localStorage.setItem(LS.queue, q ? '0' : '1'); return !q; });
  }
  function changeViewMode(m) { localStorage.setItem(LS.viewMode, m); setViewMode(m); }

  // Refetch whenever the visible range or plan mode changes (keyed on range so
  // day-switches within a loaded week don't trigger a fetch).
  useEffect(() => {
    if (viewMode === 'my') { loadWeekBlocks(); }
    else { loadPeople(); if (teamPerson) loadPersonPlanner(teamPerson, true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, viewMode]);

  useRealtimeEvent('task:updated', () => { if (viewMode === 'my') loadWeekBlocks(); });

  // ── My plan loaders ──────────────────────────────────────────────────────
  // `silent` skips the full-panel spinner so mutations re-render only the
  // changed events (FullCalendar diffs), not a whole-page flash.
  async function loadWeekBlocks(silent = false) {
    try {
      if (!silent) setLoading(true);
      const [blocksRes, calRes] = await Promise.all([
        api.get(`/timeplans/my?from=${range.from}&to=${range.to}`),
        api.get(`/timeplans/calendar-events?from=${range.from}&to=${range.to}`).catch(() => ({ data: { data: { events: [], allDayEvents: [], synced: false, status: 'fetch_failed' } } })),
      ]);
      setAllBlocks(blocksRes.data.data || blocksRes.data.blocks || []);
      const calData = calRes.data?.data || {};
      setCalendarEvents(calData.events || []);
      setAllDayEvents(calData.allDayEvents || []);
      setTeamsSynced(calData.synced ?? null);
      setTeamsStatus(calData.status ?? null);
    } catch (err) {
      toastError('Failed to load time blocks');
      setAllBlocks([]);
    } finally { if (!silent) setLoading(false); setQueueVersion((v) => v + 1); }
  }

  // ── Team plan loaders ─────────────────────────────────────────────────────
  async function loadPeople() {
    try {
      setLoading(true);
      const res = await api.get('/timeplans/people');
      const list = res.data.data || [];
      setPeople(list);
      if (!teamPerson && list.length) {
        // Restore the last-selected person across refreshes, else self/first.
        const storedId = localStorage.getItem(LS.personId);
        const pick = (storedId && list.find((p) => String(p.id) === storedId)) || list.find((p) => p.isSelf) || list[0];
        setTeamPerson(pick);
        loadPersonPlanner(pick, true);
      }
    } catch (err) {
      toastError('Failed to load people');
    } finally { setLoading(false); }
  }

  async function loadPersonPlanner(person, silent = false) {
    try {
      if (!silent) setPersonLoading(true);
      setTeamPerson(person);
      localStorage.setItem(LS.personId, String(person.id));
      const [blocksRes, calRes] = await Promise.all([
        api.get(`/timeplans/employee/${person.id}?from=${range.from}&to=${range.to}`),
        api.get(`/timeplans/calendar-events/${person.id}?from=${range.from}&to=${range.to}`).catch(() => ({ data: { data: { events: [], allDayEvents: [] } } })),
      ]);
      const data = blocksRes.data.data || {};
      setTeamBlocks(data.blocks || []);
      const cal = calRes.data?.data || {};
      setTeamTeamsEvents(cal.events || []);
      setTeamAllDay(cal.allDayEvents || []);
    } catch (err) {
      toastError(err?.response?.status === 403 ? 'You do not have access to this user\'s planner.' : 'Failed to load planner');
      setTeamBlocks([]); setTeamTeamsEvents([]); setTeamAllDay([]);
    } finally { if (!silent) setPersonLoading(false); }
  }

  // Silent refetch after a mutation — no spinner, DOM diffs only.
  function reloadActive() {
    if (viewMode === 'my') loadWeekBlocks(true);
    else if (teamPerson) loadPersonPlanner(teamPerson, true);
  }

  // ── Block actions ─────────────────────────────────────────────────────────
  async function handleDelete(id, scope = 'occurrence') {
    try {
      await api.delete(`/timeplans/${id}${scope === 'series' ? '?scope=series' : ''}`);
      setPopover(null);
      reloadActive();
    } catch (err) {
      toastError(err?.response?.data?.message || 'Failed to delete time block');
    }
  }

  // Drag-move / resize from the calendar. Optimistic (FC already moved it);
  // on backend failure we revert the visual and surface the reason.
  async function handleEventChange({ id, date, startTime, endTime }, revert) {
    try {
      await api.put(`/timeplans/${id}`, { date, startTime, endTime });
      reloadActive();
    } catch (err) {
      revert();
      toastError(err?.response?.data?.message || 'Couldn’t update the block.');
    }
  }

  // Move-to-tomorrow / next-working-day from the popover.
  async function handleMove(item, newDate) {
    try {
      await api.put(`/timeplans/${item.id}`, { date: newDate });
      setPopover(null);
      reloadActive();
    } catch (err) {
      toastError(err?.response?.data?.message || 'Couldn’t move the block.');
    }
  }

  function openTask(item) {
    const boardId = item.task?.boardId || item.boardId;
    if (boardId) { setPopover(null); navigate(`/boards/${boardId}`); }
  }

  // Inline status change from the detail popover (no edit modal needed).
  async function handleStatusChange(item, status) {
    setPopover((p) => (p ? { ...p, item: { ...p.item, status } } : p)); // optimistic chip color
    try {
      await api.put(`/timeplans/${item.id}`, { status });
      reloadActive();
    } catch (err) {
      toastError(err?.response?.data?.message || 'Couldn’t update status.');
      reloadActive();
    }
  }

  function openAddBlock(date, startTime, endTime) {
    setFormDate(date || selectedDate);
    setEditBlock(startTime ? { startTime, endTime: endTime || bumpHour(startTime) } : null);
    setForUserId(null);
    setShowForm(true);
  }

  function addBlockForPerson(date, startTime, endTime) {
    if (!teamPerson?.canManage) return;
    setFormDate(date || selectedDate);
    setEditBlock(startTime ? { startTime, endTime: endTime || bumpHour(startTime) } : null);
    setForUserId(teamPerson.id);
    setShowForm(true);
  }

  function openEditBlock(block) {
    setPopover(null);
    setFormDate(block.date);
    setEditBlock(block);
    setForUserId(null); // PUT by id; backend authorizes ownership/delegation
    setShowForm(true);
  }

  function onOpenMyBlock(item, kind, rect) {
    setPopover({ item, kind, rect, ownerName: null, canManage: true });
  }
  function onOpenTeamBlock(item, kind, rect) {
    setPopover({ item, kind, rect, ownerName: teamPerson?.name || null, canManage: !!teamPerson?.canManage && kind === 'block' });
  }

  function planFromTask(task) {
    setFormDate(selectedDate);
    setEditBlock({ task, taskId: task.id, title: task.title, type: 'task_work' });
    setForUserId(null);
    setShowForm(true);
  }

  const plannedTaskIds = useMemo(
    () => new Set(allBlocks.filter((b) => b.taskId).map((b) => b.taskId)),
    [allBlocks],
  );

  // ── Navigation (week / day / month aware) ────────────────────────────────
  function goPrev() {
    if (view === 'day') { const d = subDays(dayDate, 1); setSelectedDate(format(d, 'yyyy-MM-dd')); setWeekStart(startOfWeek(d, { weekStartsOn: 1 })); }
    else if (view === 'month') { const d = subMonths(dayDate, 1); setSelectedDate(format(d, 'yyyy-MM-dd')); setWeekStart(startOfWeek(d, { weekStartsOn: 1 })); }
    else setWeekStart(subWeeks(weekStart, 1));
  }
  function goNext() {
    if (view === 'day') { const d = addDays(dayDate, 1); setSelectedDate(format(d, 'yyyy-MM-dd')); setWeekStart(startOfWeek(d, { weekStartsOn: 1 })); }
    else if (view === 'month') { const d = addMonths(dayDate, 1); setSelectedDate(format(d, 'yyyy-MM-dd')); setWeekStart(startOfWeek(d, { weekStartsOn: 1 })); }
    else setWeekStart(addWeeks(weekStart, 1));
  }
  function goToday() {
    const now = new Date();
    setWeekStart(startOfWeek(now, { weekStartsOn: 1 }));
    setSelectedDate(format(now, 'yyyy-MM-dd'));
  }
  const selectDate = (dateStr) => setSelectedDate(dateStr);

  // ── Derived ──────────────────────────────────────────────────────────────
  // Planned-hours badge respects the active view: just the selected day in Day
  // view, the whole loaded range otherwise.
  const plannedBlocks = view === 'day' ? allBlocks.filter((b) => b.date === selectedDate) : allBlocks;
  const totalMins = plannedMinutes(plannedBlocks); // union of overlaps (no double-count)
  const plannedTeamsEvents = view === 'day' ? calendarEvents.filter((e) => e.date === selectedDate) : calendarEvents;
  const teamsMins = plannedTeamsEvents.reduce((s, e) => (e.startTime && e.endTime ? s + timeToMinutes(e.endTime) - timeToMinutes(e.startTime) : s), 0);
  const calDate = view === 'week' ? format(weekStart, 'yyyy-MM-dd') : selectedDate;
  const rangeLabel = view === 'day'
    ? format(dayDate, 'EEE, MMM d, yyyy')
    : view === 'month'
      ? format(dayDate, 'MMMM yyyy')
      : `${format(weekDays[0], 'MMM d')} – ${format(weekDays[weekDays.length - 1], 'MMM d, yyyy')}`;

  return (
    <div className="mx-auto max-w-[1400px] p-4 sm:p-6">
      <TimePlannerHeader
        rangeLabel={rangeLabel}
        onPrev={goPrev} onNext={goNext} onToday={goToday}
        view={view} onViewChange={setView}
        viewMode={viewMode} onViewModeChange={changeViewMode}
        canManage={canSeeTeam}
        plannedLabel={formatDuration(totalMins)}
        teamsLabel={teamsMins > 0 ? formatDuration(teamsMins) : null}
        onAddBlock={openAddBlock}
        queueOpen={showQueue} onToggleQueue={toggleQueue}
      />

      {/* Calendar status banners (My Plan only) */}
      {!loading && viewMode === 'my' && teamsStatus === 'not_connected' && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-[#7b83eb]/20 bg-[#7b83eb]/5 px-4 py-3">
          <CalendarDays size={16} className="flex-shrink-0 text-[#7b83eb]" />
          <p className="flex-1 text-xs text-text-secondary">Your account is not synced with Microsoft 365. Ask your admin to sync users from Integrations to see your Teams calendar here.</p>
          <a href="/integrations" className="whitespace-nowrap text-xs font-medium text-[#7b83eb] hover:underline">Go to Integrations</a>
        </div>
      )}
      {!loading && viewMode === 'my' && teamsStatus === 'fetch_failed' && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <CalendarDays size={16} className="flex-shrink-0 text-amber-500" />
          <p className="flex-1 text-xs text-text-secondary">Couldn’t load your Microsoft 365 calendar right now. This is usually temporary — your time blocks are unaffected.</p>
          <button onClick={loadWeekBlocks} className="whitespace-nowrap text-xs font-medium text-amber-600 hover:underline">Retry</button>
        </div>
      )}

      {loading ? (
        <AnistonLoader variant="section" size="md" label="Loading time plan" />
      ) : viewMode === 'my' ? (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1 rounded-2xl border border-border bg-white p-3 shadow-card sm:p-4">
            {view !== 'month' && <DayStrip days={weekDays} selectedDate={selectedDate} onSelect={selectDate} blocks={allBlocks} />}
            {teamsSynced === true && (
              <div className="mt-3 flex flex-wrap items-center gap-4 px-1">
                <Legend swatch={<span className="h-3 w-3 rounded-sm border-l-[3px] border-[#8b5cf6] bg-[#8b5cf6]/15" />} label="Planner blocks" />
                <Legend swatch={<span className="h-3 w-3 rounded-sm border-l-[3px] border-dashed bg-[#7b83eb]/15" style={{ borderColor: TEAMS_HEX }} />} label="Teams calendar" />
                <Legend swatch={<span className="h-1.5 w-3 rounded-sm" style={{ backgroundColor: `${TEAMS_HEX}33` }} />} label="All-day event" />
              </div>
            )}
            <div className="mt-3 rounded-xl border border-border/70 p-1 sm:p-2">
              <PlannerCalendar
                currentDate={calDate} view={view}
                blocks={allBlocks} teamsEvents={calendarEvents} allDayEvents={allDayEvents}
                editable
                onSelectRange={openAddBlock}
                onOpenBlock={onOpenMyBlock}
                onEventChange={handleEventChange}
                onDayClick={setDayDialogDate}
              />
            </div>
          </div>
          {showQueue && (
            <WorkQueuePanel
              selectedDate={selectedDate} plannedTaskIds={plannedTaskIds} reloadKey={queueVersion}
              onPlanTask={planFromTask} onClose={toggleQueue}
            />
          )}
        </div>
      ) : (
        /* ── Team plan: selector + selected person's planner ── */
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <TeamPlannerSelector
            people={people}
            selectedId={teamPerson?.id}
            onSelect={loadPersonPlanner}
            onManageDelegates={isTier1 ? () => setShowDelegates(true) : undefined}
          />
          <div className="min-w-0 flex-1 space-y-3">
            {!teamPerson ? (
              <div className="rounded-2xl border border-border bg-white py-16 text-center shadow-card">
                <Users size={40} className="mx-auto mb-3 text-text-tertiary" />
                <p className="text-sm text-text-secondary">Select a person to view their planner.</p>
              </div>
            ) : (
              <>
                <PlannerSummaryCards blocks={teamBlocks} weekDays={weekDays} />
                <div className="rounded-2xl border border-border bg-white p-3 shadow-card sm:p-4">
                  <div className="flex items-center justify-between gap-2 px-1">
                    <div className="flex items-center gap-2">
                      <Avatar name={teamPerson.name} src={teamPerson.avatar} size="sm" />
                      <div>
                        <p className="font-title text-sm font-bold text-text-primary">{teamPerson.name}</p>
                        <p className="text-[11px] text-text-tertiary">
                          {teamPerson.designation || teamPerson.department || (teamPerson.tier ? `Tier ${teamPerson.tier}` : 'Team member')}
                          {!teamPerson.canManage && ' · View only'}
                        </p>
                      </div>
                    </div>
                    {teamPerson.canManage && (
                      <button onClick={() => addBlockForPerson(selectedDate)} className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-600">
                        <Plus size={14} /> Add Block
                      </button>
                    )}
                  </div>
                  {view !== 'month' && <div className="mt-3"><DayStrip days={weekDays} selectedDate={selectedDate} onSelect={selectDate} blocks={teamBlocks} /></div>}
                  <div className="mt-3 rounded-xl border border-border/70 p-1 sm:p-2">
                    {personLoading ? (
                      <AnistonLoader variant="section" size="sm" label={`Loading ${teamPerson.name?.split(' ')[0]}'s planner`} />
                    ) : (
                      <PlannerCalendar
                        currentDate={calDate} view={view}
                        blocks={teamBlocks} teamsEvents={teamTeamsEvents} allDayEvents={teamAllDay}
                        editable={!!teamPerson.canManage}
                        onSelectRange={addBlockForPerson}
                        onOpenBlock={onOpenTeamBlock}
                        onEventChange={handleEventChange}
                        onDayClick={setDayDialogDate}
                      />
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Detail popover */}
      {popover && (
        <TimeBlockPopover
          item={popover.item} kind={popover.kind} anchorRect={popover.rect}
          ownerName={popover.ownerName} canManage={popover.canManage}
          onEdit={openEditBlock}
          onDelete={(b, scope) => {
            const msg = scope === 'series' ? 'Delete the entire repeating series?' : 'Delete this time block?';
            if (confirm(msg)) handleDelete(b.id, scope);
          }}
          onMove={handleMove}
          onOpenTask={openTask}
          onStatusChange={handleStatusChange}
          onClose={() => setPopover(null)}
        />
      )}

      {/* Month-view day block list */}
      {dayDialogDate && (() => {
        const isMy = viewMode === 'my';
        const srcBlocks = isMy ? allBlocks : teamBlocks;
        const srcTeams = isMy ? calendarEvents : teamTeamsEvents;
        const canManageDay = isMy || !!teamPerson?.canManage;
        return (
          <DayBlocksDialog
            date={dayDialogDate}
            blocks={srcBlocks.filter((b) => b.date === dayDialogDate)}
            teamsEvents={srcTeams.filter((e) => e.date === dayDialogDate)}
            canManage={canManageDay}
            onEdit={(b) => { setDayDialogDate(null); openEditBlock(b); }}
            onDelete={(b) => { if (confirm('Delete this time block?')) handleDelete(b.id); }}
            onAdd={(d) => { setDayDialogDate(null); (isMy ? openAddBlock : addBlockForPerson)(d, '09:00', '10:00'); }}
            onOpenTask={openTask}
            onClose={() => setDayDialogDate(null)}
          />
        );
      })()}

      {/* Planner assistants (Tier 1) */}
      {showDelegates && (
        <PlannerDelegatesModal
          people={people}
          onClose={() => setShowDelegates(false)}
          onChanged={() => { loadPeople(); if (teamPerson) loadPersonPlanner(teamPerson); }}
        />
      )}

      {/* Create / edit modal */}
      {showForm && (
        <TimeBlockModal
          block={editBlock} date={formDate} forUserId={forUserId}
          ownerName={forUserId && teamPerson ? teamPerson.name : null}
          onSave={() => { setShowForm(false); setEditBlock(null); setForUserId(null); reloadActive(); }}
          onClose={() => { setShowForm(false); setEditBlock(null); setForUserId(null); }}
        />
      )}
    </div>
  );
}

function bumpHour(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const end = Math.min(h + 1, 21);
  return `${String(end).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function Legend({ swatch, label }) {
  return (
    <span className="flex items-center gap-1.5">
      {swatch}
      <span className="text-[10px] font-medium text-text-tertiary">{label}</span>
    </span>
  );
}
