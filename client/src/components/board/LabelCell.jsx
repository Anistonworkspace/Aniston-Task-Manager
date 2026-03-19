import React, { useState, useRef, useEffect } from 'react';
import { Plus, X, Search, Tag } from 'lucide-react';
import api from '../../services/api';

export default function LabelCell({ taskId, boardId, labels: initialLabels = [] }) {
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState(initialLabels);
  const [allLabels, setAllLabels] = useState([]);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#579bfc');
  const [showCreate, setShowCreate] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (open && boardId) {
      api.get(`/labels?boardId=${boardId}`).then(res => {
        setAllLabels(res.data.labels || []);
      }).catch(() => {});
    }
  }, [open, boardId]);

  async function toggleLabel(label) {
    const isAssigned = labels.some(l => l.id === label.id);
    try {
      if (isAssigned) {
        await api.post('/labels/unassign', { taskId, labelId: label.id });
        setLabels(prev => prev.filter(l => l.id !== label.id));
      } else {
        await api.post('/labels/assign', { taskId, labelId: label.id });
        setLabels(prev => [...prev, label]);
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function createLabel() {
    if (!newName.trim()) return;
    try {
      const res = await api.post('/labels', { name: newName, color: newColor, boardId });
      const label = res.data.label;
      setAllLabels(prev => [...prev, label]);
      await api.post('/labels/assign', { taskId, labelId: label.id });
      setLabels(prev => [...prev, label]);
      setNewName('');
      setShowCreate(false);
    } catch (err) {
      console.error(err);
    }
  }

  const filtered = allLabels.filter(l => !search || l.name.toLowerCase().includes(search.toLowerCase()));
  const COLORS = ['#579bfc', '#00c875', '#fdab3d', '#e2445c', '#a25ddc', '#ff642e', '#cab641', '#ff158a', '#66ccff', '#333'];

  return (
    <div ref={ref} className="relative w-full h-full flex items-center px-2" onClick={e => e.stopPropagation()}>
      <div className="flex items-center gap-1 flex-wrap cursor-pointer" onClick={() => setOpen(!open)}>
        {labels.length > 0 ? (
          labels.slice(0, 3).map(l => (
            <span key={l.id} className="text-[9px] font-medium px-1.5 py-0.5 rounded-full text-white" style={{ backgroundColor: l.color }}>
              {l.name}
            </span>
          ))
        ) : (
          <span className="text-[10px] text-gray-400 flex items-center gap-0.5"><Tag size={10} /> Add</span>
        )}
        {labels.length > 3 && <span className="text-[9px] text-gray-400">+{labels.length - 3}</span>}
      </div>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-gray-200 dark:border-zinc-700 z-50 w-52 dropdown-enter">
          <div className="p-2">
            <div className="relative mb-2">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search labels..." className="w-full pl-7 pr-2 py-1 text-xs border border-gray-200 dark:border-zinc-600 rounded focus:outline-none focus:border-primary" />
            </div>
            <div className="max-h-32 overflow-y-auto space-y-0.5">
              {filtered.map(l => {
                const isActive = labels.some(lb => lb.id === l.id);
                return (
                  <button key={l.id} onClick={() => toggleLabel(l)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-gray-50 dark:hover:bg-zinc-700 ${isActive ? 'bg-gray-50 dark:bg-zinc-700' : ''}`}>
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: l.color }} />
                    <span className="flex-1 text-left text-gray-700 dark:text-gray-300">{l.name}</span>
                    {isActive && <span className="text-primary text-[10px] font-bold">✓</span>}
                  </button>
                );
              })}
              {filtered.length === 0 && <p className="text-[10px] text-gray-400 py-2 text-center">No labels found</p>}
            </div>
          </div>
          <div className="border-t border-gray-100 dark:border-zinc-700 p-2">
            {showCreate ? (
              <div className="space-y-1.5">
                <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
                  placeholder="Label name" className="w-full text-xs border border-gray-200 dark:border-zinc-600 rounded px-2 py-1 focus:outline-none focus:border-primary"
                  onKeyDown={e => e.key === 'Enter' && createLabel()} autoFocus />
                <div className="flex gap-1">
                  {COLORS.map(c => (
                    <button key={c} onClick={() => setNewColor(c)}
                      className={`w-3.5 h-3.5 rounded-full ${newColor === c ? 'ring-2 ring-offset-1 ring-gray-400' : ''}`} style={{ backgroundColor: c }} />
                  ))}
                </div>
                <div className="flex gap-1">
                  <button onClick={createLabel} className="flex-1 text-[10px] bg-primary text-white rounded py-1">Create</button>
                  <button onClick={() => setShowCreate(false)} className="text-[10px] text-gray-400 px-2">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setShowCreate(true)} className="flex items-center gap-1 w-full text-xs text-gray-500 hover:text-primary px-1 py-1 rounded hover:bg-gray-50 dark:hover:bg-zinc-700">
                <Plus size={11} /> Create label
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
