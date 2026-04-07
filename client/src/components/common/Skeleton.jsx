import React from 'react';

export function SkeletonLine({ width = '100%', height = 12, className = '' }) {
  return <div className={`skeleton ${className}`} style={{ width, height }} />;
}

export function SkeletonCircle({ size = 32, className = '' }) {
  return <div className={`skeleton rounded-full ${className}`} style={{ width: size, height: size }} />;
}

export function SkeletonCard({ className = '' }) {
  return (
    <div className={`bg-white rounded-lg border border-border p-4 space-y-3 ${className}`}>
      <div className="flex items-center gap-3">
        <SkeletonCircle size={36} />
        <div className="flex-1 space-y-1.5">
          <SkeletonLine width="60%" height={14} />
          <SkeletonLine width="40%" height={10} />
        </div>
      </div>
      <SkeletonLine height={10} />
      <SkeletonLine width="75%" height={10} />
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4, className = '' }) {
  return (
    <div className={`bg-white rounded-lg border border-border overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-3 bg-surface/30 border-b border-border">
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonLine key={i} width={`${Math.random() * 40 + 60}px`} height={10} />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-border/50 last:border-b-0">
          <SkeletonCircle size={28} />
          <div className="flex-1 space-y-1">
            <SkeletonLine width={`${Math.random() * 30 + 40}%`} height={12} />
            <SkeletonLine width={`${Math.random() * 20 + 20}%`} height={8} />
          </div>
          <SkeletonLine width="60px" height={22} className="rounded-full" />
          <SkeletonLine width="50px" height={10} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonDashboard() {
  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <SkeletonLine width="200px" height={24} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-white rounded-lg border border-border p-4 space-y-2">
            <SkeletonLine width="60px" height={10} />
            <SkeletonLine width="40px" height={28} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg border border-border p-5 h-[250px]">
          <SkeletonLine width="120px" height={14} className="mb-4" />
          <SkeletonLine width="100%" height={180} className="rounded-lg" />
        </div>
        <div className="bg-white rounded-lg border border-border p-5 h-[250px]">
          <SkeletonLine width="140px" height={14} className="mb-4" />
          <SkeletonLine width="100%" height={180} className="rounded-lg" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonBoard() {
  return (
    <div className="px-6 pt-5">
      <SkeletonLine width="180px" height={22} className="mb-4" />
      <div className="flex gap-2 mb-4">
        <SkeletonLine width="80px" height={32} className="rounded-md" />
        <SkeletonLine width="60px" height={32} className="rounded-md" />
        <SkeletonLine width="70px" height={32} className="rounded-md" />
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="mb-5">
          <div className="flex items-center gap-2 mb-2">
            <SkeletonLine width="100px" height={16} />
            <SkeletonLine width="30px" height={14} className="rounded-full" />
          </div>
          <SkeletonTable rows={2 + i} cols={4} />
        </div>
      ))}
    </div>
  );
}
