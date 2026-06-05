import React, { useMemo } from 'react';
import { Clock, BatteryCharging, AlertTriangle, Layers } from 'lucide-react';
import { format } from 'date-fns';
import {
  formatDuration, computeOverlapLayout, plannedMinutes,
  DAY_START_HOUR, DAY_END_HOUR,
} from './plannerTheme';

function Card({ icon, label, value, hint, tone = 'default' }) {
  const toneCls = {
    default: 'text-text-primary',
    good: 'text-success',
    warn: 'text-amber-500',
    bad: 'text-danger',
  }[tone];
  return (
    <div className="rounded-xl border border-border bg-white px-3 py-2.5 shadow-card">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
        {icon}{label}
      </div>
      <p className={`mt-1 font-title text-lg font-bold ${toneCls}`}>{value}</p>
      {hint && <p className="text-[10px] text-text-tertiary">{hint}</p>}
    </div>
  );
}

/**
 * Capacity / health summary for a planner week: planned hours, free capacity
 * (against the working-hours window), missed blocks, and scheduling conflicts
 * (overlapping blocks within a day).
 */
export default function PlannerSummaryCards({ blocks, weekDays }) {
  const stats = useMemo(() => {
    const plannedMins = plannedMinutes(blocks); // union of overlaps
    const capacityMins = (DAY_END_HOUR - DAY_START_HOUR) * (weekDays?.length || 5) * 60;
    const freeMins = Math.max(0, capacityMins - plannedMins);
    const missed = blocks.filter((b) => b.status === 'missed').length;

    let conflicts = 0;
    for (const day of weekDays || []) {
      const dateStr = format(day, 'yyyy-MM-dd');
      const dayBlocks = blocks.filter((b) => b.date === dateStr);
      const layout = computeOverlapLayout(dayBlocks);
      dayBlocks.forEach((b) => { if ((layout.get(b)?.totalCols || 1) > 1) conflicts += 1; });
    }

    const utilization = capacityMins ? Math.round((plannedMins / capacityMins) * 100) : 0;
    return { plannedMins, freeMins, missed, conflicts, utilization };
  }, [blocks, weekDays]);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Card icon={<Clock size={11} />} label="Planned" value={formatDuration(stats.plannedMins)} hint={`${stats.utilization}% of capacity`} />
      <Card icon={<BatteryCharging size={11} />} label="Free capacity" value={formatDuration(stats.freeMins)} hint="within working hours" tone="good" />
      <Card icon={<AlertTriangle size={11} />} label="Missed" value={stats.missed} tone={stats.missed ? 'bad' : 'default'} />
      <Card icon={<Layers size={11} />} label="Conflicts" value={stats.conflicts} hint={stats.conflicts ? 'overlapping blocks' : 'no overlaps'} tone={stats.conflicts ? 'warn' : 'default'} />
    </div>
  );
}
