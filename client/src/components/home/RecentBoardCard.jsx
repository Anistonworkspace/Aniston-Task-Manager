import React from 'react';
import { motion } from 'framer-motion';
import { FolderKanban, ChevronRight } from 'lucide-react';
import { staggerItem, pressable } from '../../utils/animations';

const FALLBACK_TINTS = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#14b8a6', '#3b82f6'];

/**
 * Single-row clickable board card for the Recent list.
 * - Uses board.color when available, otherwise rotates a soft pastel palette.
 * - Chevron slides 4px on hover.
 */
export default function RecentBoardCard({ board, index = 0, onClick, active = false }) {
  const tint = board.color || FALLBACK_TINTS[index % FALLBACK_TINTS.length];

  return (
    <motion.button
      variants={staggerItem}
      {...pressable}
      onClick={onClick}
      className={`group relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all
        focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500
        ${active
          ? 'bg-primary-50/60 dark:bg-primary-900/15 border-primary-200/70 dark:border-primary-800/40'
          : 'bg-white dark:bg-[var(--bg-elevated)] border-[rgba(15,15,25,0.06)] dark:border-[rgba(255,255,255,0.06)] hover:bg-surface-50/80 dark:hover:bg-surface-100'
        }`}
    >
      {/* Left accent bar that fades in on hover */}
      <span
        className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ backgroundColor: tint }}
        aria-hidden="true"
      />
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: `${tint}1F` }}
      >
        <FolderKanban size={14} style={{ color: tint }} strokeWidth={1.9} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary truncate group-hover:text-primary-600 transition-colors">
          {board.name}
        </p>
        <p className="text-[10px] text-text-tertiary truncate">Workspace</p>
      </div>
      <ChevronRight
        size={14}
        className="text-text-muted opacity-50 group-hover:opacity-100 transition-all duration-200 group-hover:translate-x-1"
        aria-hidden="true"
      />
    </motion.button>
  );
}
