import React, { useEffect, useMemo, useRef } from 'react';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import { format } from 'date-fns';
import { CalendarDays, Link2 } from 'lucide-react';
import {
  statusStyle, blockTitle, blockColor, TEAMS_HEX, DAY_START_HOUR, DAY_END_HOUR,
} from './plannerTheme';

const SLOT_MIN = `${String(DAY_START_HOUR).padStart(2, '0')}:00:00`;
const SLOT_MAX = `${String(DAY_END_HOUR).padStart(2, '0')}:00:00`;

function fmtDate(d) { return format(d, 'yyyy-MM-dd'); }
function fmtTime(d) { return format(d, 'HH:mm'); }
function addOneHour(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const end = Math.min(h + 1, DAY_END_HOUR);
  return `${String(end).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function fcViewName(v) { return v === 'day' ? 'timeGridDay' : v === 'month' ? 'dayGridMonth' : 'timeGridWeek'; }

/**
 * FullCalendar wrapper styled to the Monday Aniston pastel system. Owns ONLY
 * the grid + interactions; the parent owns data, modal, popover, and RBAC.
 * Mon–Sat (Sunday hidden), 09:00–21:00, 30-min slots, live now-line, Month view.
 *
 * Events are synced IMPERATIVELY (addEvent/removeAllEvents) because FullCalendar
 * does not reliably re-render the `events` prop on a silent state update without
 * a remount — this keeps create/edit/move/delete reflecting instantly with no
 * full-page flash.
 *
 * Props: currentDate, view ('week'|'day'|'month'), blocks, teamsEvents,
 *   allDayEvents, editable, onSelectRange(date,start,end),
 *   onOpenBlock(item,kind,rect), onEventChange({id,date,startTime,endTime},revert),
 *   onDayClick(date) — month-view day click.
 */
export default function PlannerCalendar({
  currentDate, view, blocks, teamsEvents = [], allDayEvents = [], editable,
  onSelectRange, onOpenBlock, onEventChange, onDayClick,
}) {
  const ref = useRef(null);

  const events = useMemo(() => {
    const out = [];
    for (const b of blocks) {
      const accent = blockColor(b);
      out.push({
        id: String(b.id),
        start: `${b.date}T${b.startTime}:00`,
        end: `${b.date}T${b.endTime}:00`,
        editable: !!editable,
        backgroundColor: `${accent}1A`,
        borderColor: accent,
        extendedProps: { kind: 'block', item: b, accent },
      });
    }
    for (const e of teamsEvents) {
      if (!e.startTime || !e.endTime) continue;
      out.push({
        id: `teams-${e.id || `${e.date}-${e.startTime}`}`,
        start: `${e.date}T${e.startTime}:00`,
        end: `${e.date}T${e.endTime}:00`,
        editable: false,
        backgroundColor: `${TEAMS_HEX}14`,
        borderColor: TEAMS_HEX,
        classNames: ['planner-ev-teams'],
        extendedProps: { kind: 'teams', item: e, accent: TEAMS_HEX },
      });
    }
    for (const e of allDayEvents) {
      out.push({
        id: `allday-${e.id || e.date}`,
        start: e.date,
        allDay: true,
        editable: false,
        backgroundColor: `${TEAMS_HEX}26`,
        borderColor: TEAMS_HEX,
        extendedProps: { kind: 'teams', item: e, accent: TEAMS_HEX },
      });
    }
    return out;
  }, [blocks, teamsEvents, allDayEvents, editable]);

  // Content signature — only re-sync FC events when something visible changes.
  const eventsSig = useMemo(
    () => JSON.stringify(events.map((e) => [e.id, e.start, e.end, e.allDay, e.backgroundColor, e.borderColor, e.editable, e.extendedProps.item?.title || e.extendedProps.item?.subject || '', e.extendedProps.item?.status])),
    [events],
  );

  // View / date driven imperatively (we render our own toolbar) — these never
  // change `eventsSig`, so they DON'T remount FC (smooth nav).
  useEffect(() => { ref.current?.getApi()?.changeView(fcViewName(view)); }, [view]);
  useEffect(() => { if (currentDate) ref.current?.getApi()?.gotoDate(currentDate); }, [currentDate]);

  // FullCalendar v6 does not reliably reconcile the `events` prop on a silent
  // state update in this app, so we remount the calendar ONLY when the event
  // CONTENT changes (create / edit / move / resize / delete) via a keyed
  // signature. Cheap, flash-free in practice, and 100% reliable — far better
  // than a full-page reload. Navigation (view/date) is imperative above and
  // never triggers this.
  const fcKey = useMemo(() => {
    let h = 0;
    for (let i = 0; i < eventsSig.length; i++) { h = (h * 31 + eventsSig.charCodeAt(i)) | 0; }
    return `fc-${h}`;
  }, [eventsSig]);

  function renderEventContent(arg) {
    const { kind, item, accent } = arg.event.extendedProps;
    const isMonth = arg.view.type === 'dayGridMonth';
    if (arg.event.allDay) {
      return (
        <div className="flex items-center gap-1 truncate px-1 text-[10px] font-medium" style={{ color: TEAMS_HEX }}>
          <CalendarDays size={9} /> {item.subject || 'All-day'}
        </div>
      );
    }
    const isTeams = kind === 'teams';
    const title = isTeams ? (item.subject || 'Microsoft 365 event') : blockTitle(item);
    // Month view → compact colored chip (dot + time + title).
    if (isMonth) {
      return (
        <div className="flex items-center gap-1 overflow-hidden px-1">
          <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: accent }} />
          <span className="truncate text-[10px] text-text-primary">{arg.timeText} {title}</span>
        </div>
      );
    }
    const ss = !isTeams ? statusStyle(item.status) : null;
    // Short blocks (≤30 min) lack vertical room — show time + title on ONE line.
    const durMin = arg.event.end && arg.event.start ? (arg.event.end - arg.event.start) / 60000 : 60;
    if (durMin <= 30) {
      return (
        <div className="flex h-full items-center gap-1 overflow-hidden px-1 text-left">
          {isTeams ? <CalendarDays size={9} className="flex-shrink-0" style={{ color: accent }} /> : (item.taskId ? <Link2 size={9} className="flex-shrink-0 text-text-tertiary" /> : null)}
          <span className="flex-shrink-0 text-[10px] font-semibold" style={{ color: accent }}>{arg.timeText}</span>
          <span className="truncate text-[10px] font-medium text-text-primary">{title}</span>
        </div>
      );
    }
    return (
      <div className="planner-ev-inner flex h-full flex-col overflow-hidden px-1 py-0.5 text-left">
        <span className="flex items-center gap-1 text-[10px] font-semibold" style={{ color: accent }}>
          {isTeams ? <CalendarDays size={9} className="flex-shrink-0" /> : (item.taskId ? <Link2 size={9} className="flex-shrink-0" /> : null)}
          <span className="truncate">{arg.timeText}</span>
        </span>
        <span className="truncate text-[11px] font-medium text-text-primary">{title}</span>
        {!isTeams && ss && durMin > 45 && <span className="truncate text-[9px] font-medium" style={{ color: ss.hex }}>{ss.label}</span>}
      </div>
    );
  }

  return (
    <div className="planner-fc">
      <FullCalendar
        key={fcKey}
        ref={ref}
        plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin]}
        initialView={fcViewName(view)}
        initialDate={currentDate}
        events={events}
        headerToolbar={false}
        firstDay={1}
        hiddenDays={view === 'day' ? [] : [0]}
        slotMinTime={SLOT_MIN}
        slotMaxTime={SLOT_MAX}
        slotDuration="00:30:00"
        snapDuration="00:15:00"
        scrollTime={SLOT_MIN}
        allDaySlot={allDayEvents.length > 0}
        nowIndicator
        dayMaxEvents={view === 'month' ? 3 : false}
        fixedWeekCount={false}
        expandRows
        height="auto"
        slotLabelFormat={{ hour: 'numeric', minute: '2-digit', meridiem: 'short' }}
        eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
        dayHeaderFormat={{ weekday: 'short', day: 'numeric' }}
        moreLinkClick={(arg) => { if (onDayClick) onDayClick(fmtDate(arg.date)); return 'none'; }}
        editable={!!editable}
        eventStartEditable={!!editable}
        eventDurationEditable={!!editable}
        eventResizableFromStart={!!editable}
        selectable={!!editable && view !== 'month'}
        selectMirror
        eventContent={renderEventContent}
        dateClick={(info) => {
          // Month: clicking a day opens its block list. Time views: create.
          if (view === 'month') { onDayClick && onDayClick(fmtDate(info.date)); return; }
          if (!editable) return;
          const start = info.allDay ? '09:00' : fmtTime(info.date);
          onSelectRange(fmtDate(info.date), start, addOneHour(start));
        }}
        select={(info) => {
          if (!editable || view === 'month') return;
          onSelectRange(fmtDate(info.start), fmtTime(info.start), fmtTime(info.end));
          ref.current?.getApi()?.unselect();
        }}
        eventClick={(info) => {
          const { kind, item } = info.event.extendedProps;
          onOpenBlock(item, kind, info.el.getBoundingClientRect());
        }}
        eventDrop={(info) => {
          const { item } = info.event.extendedProps;
          onEventChange(
            { id: item.id, date: fmtDate(info.event.start), startTime: fmtTime(info.event.start), endTime: fmtTime(info.event.end || info.event.start) },
            info.revert,
          );
        }}
        eventResize={(info) => {
          const { item } = info.event.extendedProps;
          onEventChange(
            { id: item.id, date: fmtDate(info.event.start), startTime: fmtTime(info.event.start), endTime: fmtTime(info.event.end) },
            info.revert,
          );
        }}
      />
    </div>
  );
}
