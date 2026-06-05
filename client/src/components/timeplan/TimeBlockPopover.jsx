import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  X, Clock, CalendarDays, Link2, Bell, Pencil, Trash2, User as UserIcon,
  MoreVertical, Repeat, ArrowRight, ExternalLink,
} from 'lucide-react';
import { format, parseISO, addDays, getDay } from 'date-fns';
import {
  typeStyle, statusStyle, priorityStyle, blockTitle, durationMinutes, formatDuration, TEAMS_HEX, STATUS_OPTIONS,
} from './plannerTheme';

const REMINDER_LABEL = { 5: '5 min before', 10: '10 min before', 15: '15 min before', 30: '30 min before', 60: '1 hour before' };

function repeatLabel(rule) {
  if (!rule || rule === 'none') return null;
  if (rule === 'daily') return 'Repeats daily (Mon–Sat)';
  if (rule === 'weekdays') return 'Repeats every weekday';
  if (rule === 'weekly') return 'Repeats weekly';
  if (rule.startsWith('custom:')) return 'Custom repeat';
  return 'Repeats';
}

// Next non-Sunday day. `skipSat` true => Saturday jumps to Monday (next working day).
function nextDate(dateStr, { skipSat } = {}) {
  let d = addDays(parseISO(dateStr), 1);
  if (getDay(d) === 0) d = addDays(d, 1);           // never Sunday
  if (skipSat && getDay(parseISO(dateStr)) === 6) d = addDays(parseISO(dateStr), 2); // Sat -> Mon
  return format(d, 'yyyy-MM-dd');
}

function Chip({ color, children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ backgroundColor: `${color}1A`, color }}>
      {children}
    </span>
  );
}

/**
 * Google-Calendar-style detail popover. Anchored beside the block on desktop,
 * bottom sheet on mobile. Closes on Esc / outside click. Edit / delete /
 * more-actions (move to tomorrow, move to next working day, delete series) are
 * shown only when the viewer can manage and the item is an editable block.
 */
export default function TimeBlockPopover({
  item, kind, anchorRect, canManage, ownerName, onEdit, onDelete, onMove, onOpenTask, onStatusChange, onClose,
}) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  const isTeams = kind === 'teams';

  useEffect(() => {
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    if (ref.current) ref.current.focus();
    return () => { document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); };
  }, [onClose]);

  useLayoutEffect(() => {
    if (isMobile || !anchorRect || !ref.current) return;
    const card = ref.current.getBoundingClientRect();
    const margin = 8;
    let left = anchorRect.right + margin;
    if (left + card.width > window.innerWidth - margin) left = anchorRect.left - card.width - margin;
    if (left < margin) left = margin;
    let top = anchorRect.top;
    if (top + card.height > window.innerHeight - margin) top = window.innerHeight - card.height - margin;
    if (top < margin) top = margin;
    setPos({ left, top });
  }, [anchorRect, isMobile]);

  const title = isTeams ? (item.subject || 'Microsoft 365 event') : blockTitle(item);
  const ts = !isTeams ? typeStyle(item.type) : null;
  const ss = !isTeams ? statusStyle(item.status) : null;
  const ps = !isTeams ? priorityStyle(item.priority) : null;
  const dateLabel = item.date ? format(parseISO(item.date), 'EEEE, MMM d, yyyy') : '';
  const dur = durationMinutes(item.startTime, item.endTime);
  const rep = !isTeams ? repeatLabel(item.recurrenceRule) : null;
  const hasSeries = !isTeams && !!item.recurrenceGroupId;
  const descHtml = !isTeams && item.description && item.description.trim();

  const cardCls = isMobile ? 'fixed inset-x-0 bottom-0 z-[70] w-full rounded-t-2xl animate-slide-up' : 'fixed z-[70] w-[320px] rounded-2xl animate-scale-in';
  const cardStyle = isMobile ? {} : (pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 });

  const showActions = !isTeams && canManage;

  return (
    <>
      <button type="button" aria-label="Close details" className="fixed inset-0 z-[60] cursor-default bg-black/10" onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={`${title} details`} tabIndex={-1}
        className={`${cardCls} border border-border bg-white shadow-modal focus:outline-none`} style={cardStyle} onClick={(e) => e.stopPropagation()}>

        {/* Action bar */}
        <div className="flex items-center justify-end gap-1 px-2 pt-2">
          {showActions && (
            <>
              <button type="button" onClick={() => onEdit(item)} className="rounded-md p-1.5 text-text-secondary hover:bg-surface" aria-label="Edit"><Pencil size={15} /></button>
              <button type="button" onClick={() => onDelete(item, 'occurrence')} className="rounded-md p-1.5 text-text-secondary hover:bg-surface hover:text-danger" aria-label="Delete"><Trash2 size={15} /></button>
              <div className="relative">
                <button type="button" onClick={() => setMenuOpen((o) => !o)} className="rounded-md p-1.5 text-text-secondary hover:bg-surface" aria-label="More actions"><MoreVertical size={15} /></button>
                {menuOpen && (
                  <div className="absolute right-0 top-full z-10 mt-1 w-52 rounded-lg border border-border bg-white py-1 shadow-dropdown">
                    <button type="button" onClick={() => { setMenuOpen(false); onMove(item, nextDate(item.date)); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-primary hover:bg-surface"><ArrowRight size={13} /> Move to next day</button>
                    {hasSeries && (
                      <button type="button" onClick={() => { setMenuOpen(false); onDelete(item, 'series'); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-danger hover:bg-surface"><Trash2 size={13} /> Delete entire series</button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-text-secondary hover:bg-surface" aria-label="Close"><X size={15} /></button>
        </div>

        <div className="px-4 pb-3">
          <div className="mb-2 flex items-start gap-2">
            <span className="mt-1 h-3 w-3 flex-shrink-0 rounded-sm" style={{ backgroundColor: isTeams ? TEAMS_HEX : ts.hex }} aria-hidden />
            <h3 className="flex-1 text-sm font-bold leading-snug text-text-primary">{title}</h3>
          </div>

          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {isTeams ? <Chip color={TEAMS_HEX}><CalendarDays size={11} /> Microsoft 365</Chip> : (
                <>
                  <Chip color={ts.hex}><ts.Icon size={11} /> {ts.label}</Chip>
                  {canManage && onStatusChange ? (
                    <select
                      value={item.status || 'planned'}
                      onChange={(e) => onStatusChange(item, e.target.value)}
                      aria-label="Change status"
                      className="rounded-full border-0 py-0.5 pl-2 pr-6 text-[11px] font-semibold focus:outline-none focus:ring-1"
                      style={{ backgroundColor: `${ss.hex}1A`, color: ss.hex }}
                    >
                      {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <Chip color={ss.hex}>{ss.label}</Chip>
                  )}
                  <Chip color={ps.hex}>{ps.label}</Chip>
                </>
              )}
            </div>

            <div className="flex items-start gap-2 text-xs text-text-secondary">
              <CalendarDays size={13} className="mt-0.5 flex-shrink-0 text-text-tertiary" /><span>{dateLabel}</span>
            </div>
            <div className="flex items-start gap-2 text-xs text-text-secondary">
              <Clock size={13} className="mt-0.5 flex-shrink-0 text-text-tertiary" />
              <span>{item.startTime}–{item.endTime} <span className="text-text-tertiary">· {formatDuration(dur)}</span></span>
            </div>

            {rep && (
              <div className="flex items-start gap-2 text-xs text-text-secondary">
                <Repeat size={13} className="mt-0.5 flex-shrink-0 text-text-tertiary" /><span>{rep}</span>
              </div>
            )}

            {!isTeams && (item.taskId || item.task) && (
              <button type="button" onClick={() => onOpenTask && onOpenTask(item)} disabled={!item.taskId || !onOpenTask}
                className="flex w-full items-start gap-2 text-left text-xs text-text-secondary enabled:hover:text-primary disabled:cursor-default">
                <Link2 size={13} className="mt-0.5 flex-shrink-0 text-text-tertiary" />
                <span className="flex-1 truncate">{item.task?.title || 'Linked task'}{item.task?.status ? ` · ${item.task.status}` : ''}</span>
                {item.taskId && onOpenTask && <ExternalLink size={12} className="mt-0.5 flex-shrink-0" />}
              </button>
            )}

            {descHtml && (
              <div className="planner-rich max-h-40 overflow-y-auto rounded-lg bg-surface/40 px-2.5 py-2 text-xs text-text-primary" dangerouslySetInnerHTML={{ __html: item.description }} />
            )}

            {!isTeams && item.reminderMinutesBefore != null && (
              <div className="flex items-start gap-2 text-xs text-text-secondary">
                <Bell size={13} className="mt-0.5 flex-shrink-0 text-text-tertiary" /><span>{REMINDER_LABEL[item.reminderMinutesBefore] || `${item.reminderMinutesBefore} min before`}</span>
              </div>
            )}

            {ownerName && (
              <div className="flex items-start gap-2 text-xs text-text-secondary">
                <UserIcon size={13} className="mt-0.5 flex-shrink-0 text-text-tertiary" /><span>{ownerName}</span>
              </div>
            )}

            {isTeams && item.location && <div className="text-xs text-text-secondary">📍 {item.location}</div>}
          </div>
        </div>
      </div>
    </>
  );
}
