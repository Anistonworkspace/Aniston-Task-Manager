import React, { useState } from 'react';
import {
  ClipboardCheck,
  Inbox,
  Clock,
  HelpCircle,
  Search,
  ArrowUpDown,
  SlidersHorizontal,
  Check,
  X,
  ArrowRight,
  Sparkles,
  Plus,
  Quote,
} from 'lucide-react';

const ACCENT = '#5B5BD6';

const TABS = [
  { id: 'approvals', label: 'Approvals', icon: ClipboardCheck, count: 13 },
  { id: 'feedback', label: 'My Feedback', icon: Inbox, count: 3 },
  { id: 'extensions', label: 'Extensions', icon: Clock, count: 5 },
  { id: 'help', label: 'Help Requests', icon: HelpCircle, count: null },
];

const STATUSES = [
  { id: 'all', label: 'All', dot: null },
  { id: 'pending', label: 'Pending', dot: '#F59E0B' },
  { id: 'approved', label: 'Approved', dot: '#10B981' },
  { id: 'rejected', label: 'Rejected', dot: '#EF4444' },
  { id: 'resolved', label: 'Resolved', dot: '#3B82F6' },
];

const STATUS_META = {
  pending: {
    accent: '#F59E0B',
    label: 'Pending Approval',
    badgeBg: '#FFFBEB',
    badgeText: '#B45309',
    badgeRing: '#FDE68A',
  },
  approved: {
    accent: '#10B981',
    label: 'Approved',
    badgeBg: '#ECFDF5',
    badgeText: '#047857',
    badgeRing: '#A7F3D0',
  },
  rejected: {
    accent: '#EF4444',
    label: 'Rejected',
    badgeBg: '#FEF2F2',
    badgeText: '#B91C1C',
    badgeRing: '#FECACA',
  },
  resolved: {
    accent: '#3B82F6',
    label: 'Resolved',
    badgeBg: '#EFF6FF',
    badgeText: '#1D4ED8',
    badgeRing: '#BFDBFE',
  },
};

const ITEMS = [
  {
    id: 1,
    group: 'Today',
    title: 'task for ashok',
    status: 'pending',
    board: { name: 'Friday', dot: '#EF4444' },
    assignee: { initials: 'SM', name: 'Sunny Mehta', color: '#6366F1' },
    submittedAt: '5/5/2026, 3:12:19 PM',
    updatedAgo: 'about 2 hours ago',
    comment: 'done',
    isNew: true,
  },
  {
    id: 2,
    group: 'Today',
    title: 'TUCO',
    status: 'pending',
    board: { name: 'Marketing board test', dot: '#A855F7' },
    assignee: { initials: 'SM', name: 'Sunny Mehta', color: '#6366F1' },
    submittedAt: '5/5/2026, 1:46:58 PM',
    updatedAgo: 'about 3 hours ago',
    comment: 'done',
    isNew: true,
  },
  {
    id: 3,
    group: 'Yesterday',
    title: 'Q2 campaign creative review',
    status: 'pending',
    board: { name: 'Marketing board test', dot: '#A855F7' },
    assignee: { initials: 'AR', name: 'Ananya Rao', color: '#10B981' },
    submittedAt: '5/4/2026, 6:22:04 PM',
    updatedAgo: 'about 22 hours ago',
    comment: 'Final round of edits applied — ready for sign-off.',
  },
  {
    id: 4,
    group: 'Earlier this week',
    title: 'invoice batch 04-29',
    status: 'approved',
    board: { name: 'Finance ops', dot: '#0EA5E9' },
    assignee: { initials: 'KP', name: 'Karan Patel', color: '#F59E0B' },
    submittedAt: '5/2/2026, 10:18:00 AM',
    updatedAgo: '3 days ago',
    comment: 'done',
  },
  {
    id: 5,
    group: 'Earlier this week',
    title: 'vendor onboarding — Acme Co.',
    status: 'rejected',
    board: { name: 'Procurement', dot: '#F97316' },
    assignee: { initials: 'NV', name: 'Neha Verma', color: '#EC4899' },
    submittedAt: '5/1/2026, 4:54:22 PM',
    updatedAgo: '4 days ago',
    comment: 'Missing tax docs — please re-upload section 3 and resubmit.',
  },
];

function TabButton({ tab, active, onClick }) {
  const Icon = tab.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group relative flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium',
        'transition-all duration-150 outline-none',
        active
          ? 'bg-white text-neutral-900 shadow-[0_1px_2px_rgba(10,10,10,0.06),0_0_0_1px_rgba(10,10,10,0.06)]'
          : 'text-neutral-500 hover:text-neutral-900',
      ].join(' ')}
    >
      <Icon
        size={15}
        strokeWidth={2}
        className={active ? '' : 'opacity-70 group-hover:opacity-100'}
        style={active ? { color: ACCENT } : undefined}
      />
      <span className="tracking-[-0.005em]">{tab.label}</span>
      {tab.count !== null && (
        <span
          className={[
            'ml-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums',
            active
              ? 'bg-neutral-100 text-neutral-700'
              : 'bg-neutral-200/60 text-neutral-500 group-hover:bg-neutral-200',
          ].join(' ')}
        >
          {tab.count}
        </span>
      )}
    </button>
  );
}

function StatusPill({ status, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'group inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium',
        'transition-all duration-150 outline-none',
        active
          ? 'bg-neutral-900 text-white shadow-[0_1px_2px_rgba(10,10,10,0.12)]'
          : 'border border-neutral-200/80 bg-white/60 text-neutral-600 hover:border-neutral-300 hover:bg-white hover:text-neutral-900',
      ].join(' ')}
    >
      {status.dot && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: status.dot, boxShadow: active ? `0 0 0 2px ${status.dot}33` : undefined }}
        />
      )}
      {status.label}
    </button>
  );
}

function GroupDivider({ label }) {
  return (
    <div className="mb-2 mt-5 flex items-center gap-3 first:mt-0">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
        {label}
      </span>
      <div className="h-px flex-1 bg-neutral-200/70" />
    </div>
  );
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{
        backgroundColor: meta.badgeBg,
        color: meta.badgeText,
        boxShadow: `inset 0 0 0 1px ${meta.badgeRing}`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: meta.accent }}
      />
      {meta.label}
    </span>
  );
}

function Avatar({ initials, color }) {
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-white"
      style={{ backgroundColor: color }}
    >
      {initials}
    </div>
  );
}

function ActionButton({ icon: Icon, label, shortcut, onClick, variant = 'default' }) {
  const variants = {
    approve: 'text-emerald-700 bg-emerald-50/0 hover:bg-emerald-50 hover:text-emerald-800 ring-emerald-200',
    reject: 'text-red-700 bg-red-50/0 hover:bg-red-50 hover:text-red-800 ring-red-200',
    default: 'text-neutral-600 bg-neutral-50/0 hover:bg-neutral-100 hover:text-neutral-900 ring-neutral-200',
  };
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      title={`${label}${shortcut ? `  (${shortcut})` : ''}`}
      className={[
        'group/btn relative inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium',
        'ring-1 ring-inset transition-all duration-150 outline-none',
        variants[variant],
      ].join(' ')}
    >
      <Icon size={13} strokeWidth={2.25} />
      <span>{label}</span>
      {shortcut && (
        <kbd className="ml-0.5 hidden rounded border border-neutral-200 bg-white px-1 text-[9.5px] font-semibold text-neutral-500 shadow-sm group-hover/btn:inline">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}

function Card({ item, isHovered, onHover }) {
  const meta = STATUS_META[item.status];
  return (
    <div
      onMouseEnter={() => onHover(item.id)}
      onMouseLeave={() => onHover(null)}
      className={[
        'group relative cursor-pointer overflow-hidden rounded-lg bg-white',
        'border transition-all duration-150',
        isHovered
          ? 'border-[#5B5BD6]/40 shadow-[0_2px_8px_-2px_rgba(91,91,214,0.12),0_0_0_1px_rgba(91,91,214,0.18)]'
          : 'border-neutral-200/70 hover:border-neutral-300',
      ].join(' ')}
    >
      <span
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ backgroundColor: meta.accent }}
      />

      <div className="flex items-start gap-4 py-3.5 pl-5 pr-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-neutral-900">
              {item.title}
            </h3>
            {item.isNew && (
              <span className="inline-flex h-[16px] items-center rounded-full bg-[#5B5BD6]/10 px-1.5 text-[9.5px] font-bold uppercase tracking-wide text-[#5B5BD6]">
                New
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[13px] text-neutral-500">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: item.board.dot }}
            />
            <span className="truncate">{item.board.name}</span>
          </div>
        </div>

        <div className="hidden min-w-0 shrink-0 items-center gap-2 sm:flex">
          <Avatar initials={item.assignee.initials} color={item.assignee.color} />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[12.5px] font-medium text-neutral-700">
              {item.assignee.name}
            </div>
            <div className="truncate text-[11.5px] font-medium text-neutral-400">
              submitted {item.updatedAgo}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div
            className={[
              'flex items-center gap-1.5 transition-all duration-150',
              isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none -translate-x-1',
            ].join(' ')}
          >
            <ActionButton icon={Check} label="Approve" shortcut="A" variant="approve" />
            <ActionButton icon={X} label="Reject" shortcut="R" variant="reject" />
            <ActionButton icon={ArrowRight} label="View" shortcut="V" variant="default" />
          </div>
          <div className={isHovered ? 'opacity-0 pointer-events-none' : 'opacity-100 transition-opacity duration-150'}>
            <StatusBadge status={item.status} />
          </div>
        </div>
      </div>

      {item.comment && (
        <div className="mb-3 ml-5 mr-4 pl-3" style={{ borderLeft: `2px solid ${ACCENT}55` }}>
          <p
            className="line-clamp-2 italic text-[13px] leading-snug text-neutral-500"
            title={item.comment}
          >
            <span className="text-neutral-400">“</span>
            {item.comment}
            <span className="text-neutral-400">”</span>
            <span className="ml-2 not-italic text-[11.5px] font-medium text-neutral-400">
              · {item.assignee.name.split(' ')[0]} submitted for approval · {item.submittedAt}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-neutral-200 bg-white">
        <Inbox size={20} className="text-neutral-400" strokeWidth={1.75} />
      </div>
      <h3 className="mt-4 text-[14px] font-semibold text-neutral-900">You're all caught up</h3>
      <p className="mt-1 max-w-xs text-[12.5px] leading-relaxed text-neutral-500">
        New items will appear here when teammates submit work that needs your attention.
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200/70 bg-white">
      <div className="flex items-start gap-4 py-3.5 pl-5 pr-4">
        <div className="flex-1 space-y-2">
          <div className="h-3.5 w-48 animate-pulse rounded bg-neutral-200/80" />
          <div className="h-3 w-32 animate-pulse rounded bg-neutral-100" />
        </div>
        <div className="h-7 w-7 animate-pulse rounded-full bg-neutral-200/80" />
        <div className="h-5 w-24 animate-pulse rounded-full bg-neutral-100" />
      </div>
    </div>
  );
}

export default function TasksPageRedesign() {
  const [activeTab, setActiveTab] = useState('approvals');
  const [statusFilter, setStatusFilter] = useState('all');
  const [hoveredId, setHoveredId] = useState(null);
  const [search, setSearch] = useState('');

  const filtered = ITEMS.filter((i) => {
    if (statusFilter !== 'all' && i.status !== statusFilter) return false;
    if (search && !i.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const grouped = filtered.reduce((acc, item) => {
    if (!acc[item.group]) acc[item.group] = [];
    acc[item.group].push(item);
    return acc;
  }, {});
  const groupOrder = ['Today', 'Yesterday', 'Earlier this week'];

  const newCount = ITEMS.filter((i) => i.isNew).length;

  return (
    <div
      className="relative min-h-screen text-neutral-900"
      style={{
        backgroundColor: '#FAFAF9',
        fontFamily:
          'Inter, "Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-0"
        style={{
          background:
            'radial-gradient(900px 500px at 100% 0%, rgba(91,91,214,0.05), transparent 60%)',
        }}
      />

      <div className="relative z-10 mx-auto max-w-5xl px-6 pb-24 pt-8">
        <header className="mb-5">
          <h1 className="text-[24px] font-bold tracking-[-0.02em] text-neutral-900">
            Tasks &amp; Workflows
          </h1>
          <p className="mt-1 text-[13.5px] text-neutral-500">
            Approvals, your submitted feedback, extensions, and help requests
          </p>
        </header>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div
            className="inline-flex items-center gap-0.5 rounded-lg border border-neutral-200/80 bg-neutral-100/70 p-1"
            role="tablist"
          >
            {TABS.map((tab) => (
              <TabButton
                key={tab.id}
                tab={tab}
                active={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400"
                strokeWidth={2}
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search queue..."
                className="h-8 w-48 rounded-md border border-neutral-200 bg-white pl-8 pr-2 text-[12.5px] text-neutral-900 placeholder:text-neutral-400 outline-none transition-all focus:border-[#5B5BD6]/50 focus:ring-2 focus:ring-[#5B5BD6]/15"
              />
            </div>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 text-[12.5px] font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
            >
              <ArrowUpDown size={13} strokeWidth={2} />
              Sort
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-2.5 text-[12.5px] font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
            >
              <SlidersHorizontal size={13} strokeWidth={2} />
              Filter
            </button>
          </div>
        </div>

        <div className="mb-4 flex items-center gap-2">
          <span className="mr-1 text-[11.5px] font-medium uppercase tracking-wide text-neutral-400">
            Status
          </span>
          {STATUSES.map((status) => (
            <StatusPill
              key={status.id}
              status={status}
              active={statusFilter === status.id}
              onClick={() => setStatusFilter(status.id)}
            />
          ))}
        </div>

        {newCount > 0 && (
          <div className="mb-3 flex items-center gap-2 rounded-md bg-[#5B5BD6]/[0.06] px-3 py-1.5 text-[12px] font-medium text-[#5B5BD6]">
            <Sparkles size={12} strokeWidth={2.25} />
            {newCount} new since you last visited
          </div>
        )}

        {filtered.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-2">
            {groupOrder.map((group) => {
              const items = grouped[group];
              if (!items || !items.length) return null;
              return (
                <div key={group}>
                  <GroupDivider label={group} />
                  <div className="space-y-2">
                    {items.map((item) => (
                      <Card
                        key={item.id}
                        item={item}
                        isHovered={hoveredId === item.id}
                        onHover={setHoveredId}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {false && (
          <div className="space-y-2">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        )}
      </div>

      <button
        type="button"
        aria-label="New item"
        className="fixed bottom-6 right-6 z-20 flex h-12 w-12 items-center justify-center rounded-full text-white shadow-[0_4px_16px_-4px_rgba(91,91,214,0.55),0_0_0_1px_rgba(91,91,214,0.1)] transition-all duration-200 hover:scale-105 hover:shadow-[0_6px_20px_-4px_rgba(91,91,214,0.7),0_0_0_1px_rgba(91,91,214,0.2)] active:scale-95"
        style={{ backgroundColor: ACCENT }}
      >
        <Plus size={20} strokeWidth={2.25} />
      </button>
    </div>
  );
}
