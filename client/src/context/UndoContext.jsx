import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const UndoContext = createContext(null);
const MAX_HISTORY = 50;

export function UndoProvider({ children }) {
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [toast, setToast] = useState(null);

  const pushAction = useCallback((action) => {
    // action = { type, description, undo: async () => void, redo: async () => void }
    setUndoStack(prev => [...prev.slice(-MAX_HISTORY + 1), action]);
    setRedoStack([]);
    setToast({ message: action.description, action });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const undo = useCallback(async () => {
    if (undoStack.length === 0) return;
    const action = undoStack[undoStack.length - 1];
    try {
      await action.undo();
      setUndoStack(prev => prev.slice(0, -1));
      setRedoStack(prev => [...prev, action]);
      setToast({ message: `Undone: ${action.description}`, undone: true });
      setTimeout(() => setToast(null), 3000);
    } catch (err) {
      console.error('Undo failed:', err);
    }
  }, [undoStack]);

  const redo = useCallback(async () => {
    if (redoStack.length === 0) return;
    const action = redoStack[redoStack.length - 1];
    try {
      await action.redo();
      setRedoStack(prev => prev.slice(0, -1));
      setUndoStack(prev => [...prev, action]);
    } catch (err) {
      console.error('Redo failed:', err);
    }
  }, [redoStack]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e) {
      // Ctrl+Z = Undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      // Ctrl+Y or Ctrl+Shift+Z = Redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      // Delete key = show archive message
      if (e.key === 'Delete') {
        setToast({ message: 'Tasks cannot be deleted. Use archive instead.', isWarning: true });
        setTimeout(() => setToast(null), 3000);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  const dismissToast = useCallback(() => setToast(null), []);

  return (
    <UndoContext.Provider value={{ pushAction, undo, redo, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0, undoCount: undoStack.length }}>
      {children}
      {/* Undo Toast */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] px-4 py-2.5 rounded-lg shadow-lg flex items-center gap-3 text-sm animate-slide-up ${
          toast.isWarning ? 'bg-yellow-600 text-white' : toast.undone ? 'bg-green-600 text-white' : 'bg-gray-800 text-white'
        }`}>
          <span>{toast.message}</span>
          {toast.action && !toast.undone && (
            <button onClick={() => { undo(); dismissToast(); }} className="font-bold text-white/90 hover:text-white underline">Undo</button>
          )}
          <button onClick={dismissToast} className="text-white/60 hover:text-white ml-1">✕</button>
        </div>
      )}
    </UndoContext.Provider>
  );
}

export function useUndo() {
  const ctx = useContext(UndoContext);
  if (!ctx) throw new Error('useUndo must be inside UndoProvider');
  return ctx;
}
