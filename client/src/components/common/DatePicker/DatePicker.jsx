import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  addMonths,
  subMonths,
  isSameDay,
  isSameMonth,
  isAfter,
  isBefore,
  parse,
  isValid,
} from 'date-fns';
import { Calendar, Clock, X, ChevronLeft, ChevronRight } from 'lucide-react';
import Popover from '../Popover';

/**
 * DatePicker — calendar popover for picking dates (optionally with time).
 *
 *   <DatePicker value={date} onChange={setDate} />
 *   <DatePicker value={date} onChange={setDate} includeTime weekStart={0} />
 *
 * Props mirror skill §11.3:
 *   - value: Date | null
 *   - onChange: (date: Date | null) => void
 *   - includeTime: optional hour/minute controls
 *   - minDate / maxDate: clamp picks
 *   - weekStart: 0 = Sunday, 1 = Monday (default 1)
 *
 * Keyboard:
 *   Arrow keys move 1 day. PageUp/PageDown change month.
 *   Home/End jump to start/end of week. Enter selects. Escape closes.
 */
export default function DatePicker({
  value,
  onChange,
  placeholder = 'Select date',
  disabled = false,
  minDate,
  maxDate,
  includeTime = false,
  weekStart = 1,
  locale,
  inputClassName = '',
  triggerRender,
}) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(value || new Date());
  const [showTime, setShowTime] = useState(includeTime && !!value);
  const [textValue, setTextValue] = useState(
    value ? format(value, includeTime ? 'MM/dd/yyyy HH:mm' : 'MM/dd/yyyy') : ''
  );
  const [focusedDate, setFocusedDate] = useState(value || new Date());

  useEffect(() => {
    if (value) {
      setViewMonth(value);
      setTextValue(format(value, includeTime ? 'MM/dd/yyyy HH:mm' : 'MM/dd/yyyy'));
      setFocusedDate(value);
    } else {
      setTextValue('');
    }
  }, [value, includeTime]);

  const weeks = useMemo(() => {
    const start = startOfWeek(startOfMonth(viewMonth), { weekStartsOn: weekStart });
    const end = endOfWeek(endOfMonth(viewMonth), { weekStartsOn: weekStart });
    const result = [];
    let cursor = start;
    while (!isAfter(cursor, end)) {
      const row = [];
      for (let i = 0; i < 7; i++) {
        row.push(cursor);
        cursor = addDays(cursor, 1);
      }
      result.push(row);
    }
    return result;
  }, [viewMonth, weekStart]);

  function selectDate(date) {
    if (disabled) return;
    if (minDate && isBefore(date, minDate)) return;
    if (maxDate && isAfter(date, maxDate)) return;
    let next = date;
    if (showTime && value) {
      next = new Date(date);
      next.setHours(value.getHours(), value.getMinutes(), 0, 0);
    } else {
      next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    }
    onChange?.(next);
    if (!showTime) setOpen(false);
  }

  function clear() {
    onChange?.(null);
    setTextValue('');
    setOpen(false);
  }

  function handleTextSubmit() {
    const parsed = parse(textValue, includeTime ? 'MM/dd/yyyy HH:mm' : 'MM/dd/yyyy', new Date());
    if (isValid(parsed)) {
      selectDate(parsed);
    }
  }

  function handleKeyDown(e) {
    const k = e.key;
    if (k === 'ArrowLeft') { e.preventDefault(); setFocusedDate((d) => addDays(d, -1)); }
    else if (k === 'ArrowRight') { e.preventDefault(); setFocusedDate((d) => addDays(d, 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); setFocusedDate((d) => addDays(d, -7)); }
    else if (k === 'ArrowDown') { e.preventDefault(); setFocusedDate((d) => addDays(d, 7)); }
    else if (k === 'PageUp') { e.preventDefault(); setFocusedDate((d) => subMonths(d, 1)); }
    else if (k === 'PageDown') { e.preventDefault(); setFocusedDate((d) => addMonths(d, 1)); }
    else if (k === 'Home') { e.preventDefault(); setFocusedDate((d) => startOfWeek(d, { weekStartsOn: weekStart })); }
    else if (k === 'End') { e.preventDefault(); setFocusedDate((d) => endOfWeek(d, { weekStartsOn: weekStart })); }
    else if (k === 'Enter') { e.preventDefault(); selectDate(focusedDate); }
  }

  useEffect(() => {
    if (!isSameMonth(focusedDate, viewMonth)) setViewMonth(focusedDate);
  }, [focusedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const weekdayLabels = useMemo(() => {
    const sample = startOfWeek(new Date(), { weekStartsOn: weekStart });
    return Array.from({ length: 7 }, (_, i) => format(addDays(sample, i), 'EEEEE'));
  }, [weekStart]);

  return (
    <Popover open={open} onOpenChange={setOpen} placement="bottom-start" offset={6} modal>
      <Popover.Trigger>
        {triggerRender ? triggerRender({ value, placeholder, open }) : (
          <button
            type="button"
            disabled={disabled}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-surface text-sm text-text-primary hover:border-primary-300 transition-colors min-w-[160px] ${inputClassName}`}
          >
            <Calendar size={14} className="text-text-tertiary" />
            <span className={value ? '' : 'text-text-tertiary'}>
              {value ? format(value, includeTime ? 'MMM d, yyyy h:mm a' : 'MMM d, yyyy') : placeholder}
            </span>
          </button>
        )}
      </Popover.Trigger>
      <Popover.Content width={300} ariaLabel="Date picker">
        <div
          className="bg-surface border border-border rounded-md shadow-md p-3 text-text-primary"
          onKeyDown={handleKeyDown}
          tabIndex={-1}
        >
          {/* Quick actions */}
          <div className="flex items-center gap-2 mb-3">
            <button
              type="button"
              className="text-xs font-medium px-2 py-1 rounded hover:bg-surface-100"
              onClick={() => selectDate(new Date())}
            >
              Today
            </button>
            {includeTime && (
              <button
                type="button"
                className={`text-xs font-medium px-2 py-1 rounded inline-flex items-center gap-1 ${
                  showTime ? 'bg-primary-50 text-primary' : 'hover:bg-surface-100 text-text-secondary'
                }`}
                onClick={() => setShowTime((s) => !s)}
              >
                <Clock size={12} /> Time
              </button>
            )}
            {value && (
              <button
                type="button"
                className="ml-auto text-xs font-medium px-2 py-1 rounded hover:bg-surface-100 text-text-secondary inline-flex items-center gap-1"
                onClick={clear}
              >
                <X size={12} /> Clear
              </button>
            )}
          </div>

          {/* Text input */}
          <input
            type="text"
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onBlur={handleTextSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleTextSubmit(); }
            }}
            placeholder={includeTime ? 'MM/DD/YYYY HH:MM' : 'MM/DD/YYYY'}
            className="w-full px-2 py-1.5 mb-3 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
          />

          {/* Month nav */}
          <div className="flex items-center justify-between mb-2 px-1">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setViewMonth((m) => subMonths(m, 1))}
              className="p-1 rounded hover:bg-surface-100 text-text-secondary"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold">
              {format(viewMonth, 'MMMM yyyy')}
            </span>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => setViewMonth((m) => addMonths(m, 1))}
              className="p-1 rounded hover:bg-surface-100 text-text-secondary"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Weekday labels */}
          <div className="grid grid-cols-7 mb-1">
            {weekdayLabels.map((label, idx) => (
              <div key={idx} className="text-center text-[10px] font-semibold text-text-tertiary py-1">
                {label}
              </div>
            ))}
          </div>

          {/* Days grid */}
          <div className="grid grid-cols-7 gap-y-1">
            {weeks.flat().map((d, idx) => {
              const isOutOfMonth = !isSameMonth(d, viewMonth);
              const isSelected = value && isSameDay(d, value);
              const isToday = isSameDay(d, new Date());
              const isDisabledDay = (minDate && isBefore(d, minDate)) || (maxDate && isAfter(d, maxDate));
              const isFocused = isSameDay(d, focusedDate);
              return (
                <button
                  key={idx}
                  type="button"
                  disabled={isDisabledDay}
                  tabIndex={isFocused ? 0 : -1}
                  onClick={() => selectDate(d)}
                  onFocus={() => setFocusedDate(d)}
                  className={`mx-auto w-8 h-8 text-xs rounded-full inline-flex items-center justify-center transition-colors ${
                    isSelected
                      ? 'bg-primary text-white font-semibold'
                      : isToday
                        ? 'border border-primary text-primary font-medium'
                        : 'hover:bg-surface-100'
                  } ${isOutOfMonth ? 'text-text-tertiary opacity-60' : ''} ${
                    isDisabledDay ? 'opacity-30 cursor-not-allowed' : ''
                  } ${isFocused && !isSelected ? 'ring-2 ring-primary-300' : ''}`}
                >
                  {format(d, 'd')}
                </button>
              );
            })}
          </div>

          {/* Time controls */}
          {showTime && value && (
            <div className="flex items-center justify-center gap-2 mt-3 pt-3 border-t border-border-light">
              <input
                type="number"
                min={0}
                max={23}
                value={String(value.getHours()).padStart(2, '0')}
                onChange={(e) => {
                  const next = new Date(value);
                  next.setHours(Math.max(0, Math.min(23, parseInt(e.target.value, 10) || 0)));
                  onChange?.(next);
                }}
                className="w-12 px-1.5 py-1 border border-border rounded text-center text-sm"
                aria-label="Hours"
              />
              <span className="text-text-tertiary">:</span>
              <input
                type="number"
                min={0}
                max={59}
                value={String(value.getMinutes()).padStart(2, '0')}
                onChange={(e) => {
                  const next = new Date(value);
                  next.setMinutes(Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)));
                  onChange?.(next);
                }}
                className="w-12 px-1.5 py-1 border border-border rounded text-center text-sm"
                aria-label="Minutes"
              />
            </div>
          )}
        </div>
      </Popover.Content>
    </Popover>
  );
}
