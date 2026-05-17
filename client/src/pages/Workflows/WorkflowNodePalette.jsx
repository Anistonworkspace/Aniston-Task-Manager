import React, { useState } from 'react';
import { Zap, PlayCircle, GitBranch } from 'lucide-react';
import { TRIGGERS, ACTIONS, CONDITIONS } from './workflowCatalog';

/**
 * WorkflowNodePalette — left-rail catalog of draggable trigger + action
 * items for the canvas. Two tabs: "Triggers" and "Actions".
 *
 * Drag implementation: we set a `application/x-aniston-workflow-node` data
 * payload encoding `{ type, kind }`. The canvas listens for `onDrop` and
 * dispatches createNode(...) at the drop position. Triggers themselves only
 * have one valid drop target (the canvas), and the canvas rejects a second
 * trigger drop with a toast — see WorkflowCanvasPage.handleDrop.
 *
 * Items flagged `comingSoon` are visually muted and refuse to start a drag.
 * This is the v1 stub for send_message + wait — their server handlers don't
 * exist yet.
 */

const DRAG_MIME = 'application/x-aniston-workflow-node';

function paletteAccent(type) {
  // Triggers get amber-emerald; actions get blue; conditions get violet —
  // same visual language the node cards on the canvas use, so drag-source
  // and drop-target match.
  if (type === 'trigger')   return { bg: 'rgba(245, 158, 11, 0.12)', fg: '#d97706' };
  if (type === 'condition') return { bg: 'rgba(168, 85, 247, 0.15)', fg: '#a855f7' };
  return { bg: 'rgba(59, 130, 246, 0.12)', fg: '#2563eb' };
}

function PaletteItem({ entry, type }) {
  const { bg, fg } = paletteAccent(type);
  const disabled = !!entry.comingSoon;

  function onDragStart(e) {
    if (disabled) {
      e.preventDefault();
      return;
    }
    const payload = JSON.stringify({ type, kind: entry.kind });
    e.dataTransfer.setData(DRAG_MIME, payload);
    // text/plain fallback — some environments (jsdom, older Edge) only honor
    // the standard MIME types. The canvas accepts either as a robustness net.
    try { e.dataTransfer.setData('text/plain', payload); } catch { /* noop */ }
    e.dataTransfer.effectAllowed = 'copy';
  }

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      draggable={!disabled}
      onDragStart={onDragStart}
      data-testid={`palette-item-${entry.kind}`}
      data-node-type={type}
      data-node-kind={entry.kind}
      aria-disabled={disabled || undefined}
      className={`flex items-start gap-2 px-2.5 py-2 rounded-md border border-border-light bg-surface mb-1.5 select-none ${
        disabled
          ? 'opacity-50 cursor-not-allowed'
          : 'cursor-grab active:cursor-grabbing hover:border-primary hover:shadow-sm transition'
      }`}
    >
      <span
        className="w-7 h-7 rounded-md inline-flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ backgroundColor: bg, color: fg }}
      >
        {type === 'trigger' ? <Zap size={13} /> : type === 'condition' ? <GitBranch size={13} /> : <PlayCircle size={13} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold text-text-primary leading-snug flex items-center gap-1.5">
          <span className="truncate">{entry.label}</span>
          {disabled && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 flex-shrink-0">
              Soon
            </span>
          )}
        </div>
        {entry.description && (
          <div className="text-[11px] text-text-tertiary leading-snug mt-0.5">
            {entry.description}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkflowNodePalette() {
  const [tab, setTab] = useState('triggers');

  return (
    <aside
      className="w-64 flex-shrink-0 flex flex-col bg-surface border-r border-border"
      data-testid="workflow-palette"
    >
      <div className="px-3 pt-3">
        <div className="grid grid-cols-3 rounded-md border border-border-light overflow-hidden text-[11px] font-semibold">
          <button
            type="button"
            onClick={() => setTab('triggers')}
            className={`py-1.5 transition-colors ${
              tab === 'triggers'
                ? 'bg-primary text-white'
                : 'bg-surface text-text-secondary hover:bg-surface-50'
            }`}
          >
            Triggers
          </button>
          <button
            type="button"
            onClick={() => setTab('actions')}
            className={`py-1.5 transition-colors ${
              tab === 'actions'
                ? 'bg-primary text-white'
                : 'bg-surface text-text-secondary hover:bg-surface-50'
            }`}
          >
            Actions
          </button>
          <button
            type="button"
            onClick={() => setTab('conditions')}
            className={`py-1.5 transition-colors ${
              tab === 'conditions'
                ? 'bg-primary text-white'
                : 'bg-surface text-text-secondary hover:bg-surface-50'
            }`}
          >
            Conditions
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {tab === 'triggers' && (
          <>
            <p className="text-[11px] text-text-tertiary mb-2 uppercase tracking-wide font-semibold">
              Choose a trigger
            </p>
            {TRIGGERS.map((t) => (
              <PaletteItem key={t.kind} entry={t} type="trigger" />
            ))}
          </>
        )}
        {tab === 'actions' && (
          <>
            <p className="text-[11px] text-text-tertiary mb-2 uppercase tracking-wide font-semibold">
              Add an action
            </p>
            {ACTIONS.map((a) => (
              <PaletteItem key={a.kind} entry={a} type="action" />
            ))}
          </>
        )}
        {tab === 'conditions' && (
          <>
            <p className="text-[11px] text-text-tertiary mb-2 uppercase tracking-wide font-semibold">
              Add a branch
            </p>
            {CONDITIONS.map((c) => (
              <PaletteItem key={c.kind} entry={c} type="condition" />
            ))}
            <div className="mt-3 p-2.5 rounded-md border border-dashed border-border-light text-[11px] text-text-tertiary">
              The first connection out of a condition node becomes the
              <strong> Yes</strong> path; the second becomes the <strong>No</strong> path.
              Extra connections fall through unconditionally.
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

export { DRAG_MIME };
