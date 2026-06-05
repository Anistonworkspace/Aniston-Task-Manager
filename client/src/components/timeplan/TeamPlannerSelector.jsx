import React, { useMemo, useState } from 'react';
import { Search, Lock, ShieldCheck, UserCog } from 'lucide-react';
import Avatar from '../common/Avatar';

/**
 * Left-rail person selector for Team Plan. Searches by name, filters by
 * department and tier (when the data exists), and marks view-only people with
 * a lock. The roster is already permission-scoped by the server
 * (GET /api/timeplans/people), so everyone shown is at least viewable.
 */
export default function TeamPlannerSelector({ people, selectedId, onSelect, onManageDelegates }) {
  const [query, setQuery] = useState('');
  const [dept, setDept] = useState('');
  const [tier, setTier] = useState('');

  const departments = useMemo(
    () => Array.from(new Set(people.map((p) => p.department).filter(Boolean))).sort(),
    [people],
  );
  const tiers = useMemo(
    () => Array.from(new Set(people.map((p) => p.tier).filter((t) => t != null))).sort(),
    [people],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = people.filter((p) => {
      if (q && !p.name.toLowerCase().includes(q) && !(p.email || '').toLowerCase().includes(q)) return false;
      if (dept && p.department !== dept) return false;
      if (tier && String(p.tier) !== String(tier)) return false;
      return true;
    });
    // Keep the currently-selected person pinned at the top.
    if (selectedId) list.sort((a, b) => (a.id === selectedId ? -1 : b.id === selectedId ? 1 : 0));
    return list;
  }, [people, query, dept, tier, selectedId]);

  return (
    <div className="flex max-h-[calc(100vh-9rem)] w-full flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-card lg:w-[14.5rem] lg:flex-shrink-0">
      <div className="border-b border-border px-3 py-3">
        <div className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5">
          <Search size={14} className="text-text-tertiary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people…"
            className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
            aria-label="Search people"
          />
        </div>
        {(departments.length > 0 || tiers.length > 1) && (
          <div className="mt-2 flex gap-2">
            {departments.length > 0 && (
              <select value={dept} onChange={(e) => setDept(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-border bg-white px-2 py-1.5 text-xs text-text-primary focus:outline-none" aria-label="Filter by department">
                <option value="">All departments</option>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
            {tiers.length > 1 && (
              <select value={tier} onChange={(e) => setTier(e.target.value)} className="rounded-lg border border-border bg-white px-2 py-1.5 text-xs text-text-primary focus:outline-none" aria-label="Filter by tier">
                <option value="">All tiers</option>
                {tiers.map((t) => <option key={t} value={t}>Tier {t}</option>)}
              </select>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-text-tertiary">No people match.</p>
        ) : (
          filtered.map((p) => {
            const selected = p.id === selectedId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p)}
                aria-pressed={selected}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-surface ${selected ? 'bg-primary/5' : ''}`}
              >
                <Avatar name={p.name} src={p.avatar} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-text-primary">{p.name}</span>
                    {p.isSelf && <span className="rounded bg-primary/10 px-1 text-[9px] font-semibold text-primary">You</span>}
                  </span>
                  <span className="block truncate text-[11px] text-text-tertiary">
                    {p.designation || p.department || (p.tier ? `Tier ${p.tier}` : 'Team member')}
                  </span>
                </span>
                {p.canManage
                  ? <ShieldCheck size={13} className="flex-shrink-0 text-success/70" aria-label="You can manage this planner" />
                  : <Lock size={12} className="flex-shrink-0 text-text-tertiary" aria-label="View only" />}
              </button>
            );
          })
        )}
      </div>

      {onManageDelegates && (
        <button
          type="button"
          onClick={onManageDelegates}
          className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-2.5 text-xs font-medium text-primary hover:bg-surface"
        >
          <UserCog size={13} /> Manage planner assistants
        </button>
      )}
    </div>
  );
}
