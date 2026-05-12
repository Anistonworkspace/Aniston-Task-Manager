import React, { createContext, useContext, useMemo } from 'react';

// App-level undo/redo for task operations was disabled per product request
// (May 12 2026). Background:
//
//   - Ctrl+Z / Ctrl+Y previously reverted *saved* task state (status, due
//     date, priority, assignee, archive, etc.) via the stack maintained
//     here. That behaviour was surprising in a shared multi-user board:
//     one user could quietly roll back another user's persisted change
//     simply by pressing a keyboard shortcut.
//   - The PM decision is to remove this surface entirely for every tier.
//
// We keep the file (instead of deleting the module) and the `UndoProvider`
// + `useUndo` exports so the existing callers in BoardPage.jsx — and any
// future caller that re-introduces a `useUndo()` lookup — don't crash with
// "useUndo must be inside UndoProvider". Every API entry is a no-op:
//
//   - pushAction(...) silently drops the action; no toast, no stack push.
//   - undo() / redo() are no-ops.
//   - canUndo / canRedo are always false; undoCount is 0.
//   - No keyboard listener is registered, so Ctrl+Z / Ctrl+Y fall through
//     to the browser's native handler (text-input undo in <input>/<textarea>
//     still works as expected — we only stripped the *app-level* override).
//   - The bottom-centre Undo toast UI is removed.
//
// If you ever want to re-enable a task-level undo system, do it as a new
// well-scoped feature (per-board opt-in, server-side audit-trail-backed)
// rather than restoring this client-only stack.

const UndoContext = createContext(null);

const NOOP_API = Object.freeze({
  pushAction: () => {},
  undo: () => {},
  redo: () => {},
  canUndo: false,
  canRedo: false,
  undoCount: 0,
});

export function UndoProvider({ children }) {
  const value = useMemo(() => NOOP_API, []);
  return <UndoContext.Provider value={value}>{children}</UndoContext.Provider>;
}

export function useUndo() {
  const ctx = useContext(UndoContext);
  // If the provider is somehow missing (e.g. a test renders a component in
  // isolation), still return the no-op surface so the caller doesn't crash.
  return ctx || NOOP_API;
}
