import React, { useState, useEffect } from 'react';
import { Mic, FileText, Search, Trash2, Edit3, Clock, Save, X, ChevronDown } from 'lucide-react';
import api from '../services/api';

const TYPE_BADGES = {
  voice_note: { label: 'Voice', color: '#00c875', bg: '#00c87515' },
  text_note: { label: 'Text', color: '#0073ea', bg: '#0073ea15' },
};

export default function NotesPage() {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');

  useEffect(() => { loadNotes(); }, []);

  async function loadNotes() {
    setLoading(true);
    try {
      const res = await api.get('/notes/my');
      setNotes(res.data.notes || []);
    } catch (err) {
      console.error('Failed to load notes:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id) {
    try {
      await api.delete(`/notes/${id}`);
      setNotes(prev => prev.filter(n => n.id !== id));
      setDeleteConfirm(null);
      if (expandedId === id) setExpandedId(null);
    } catch {}
  }

  async function handleSaveEdit() {
    if (!editTitle.trim()) return;
    setSaving(true);
    try {
      await api.put(`/notes/${editingId}`, { title: editTitle.trim(), content: editContent.trim() });
      setNotes(prev => prev.map(n => n.id === editingId ? { ...n, title: editTitle.trim(), content: editContent.trim() } : n));
      setEditingId(null);
    } catch {} finally {
      setSaving(false);
    }
  }

  async function handleCreateNote() {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      const res = await api.post('/notes', {
        title: newTitle.trim(),
        content: newContent.trim(),
        type: 'text_note',
      });
      setNotes(prev => [res.data.note, ...prev]);
      setNewNoteOpen(false);
      setNewTitle('');
      setNewContent('');
    } catch {} finally {
      setSaving(false);
    }
  }

  function startEdit(note) {
    setEditingId(note.id);
    setEditTitle(note.title);
    setEditContent(note.content);
    setExpandedId(note.id);
  }

  const formatDuration = (secs) => {
    if (!secs) return '';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  const filtered = notes.filter(n =>
    !searchQuery || n.title.toLowerCase().includes(searchQuery.toLowerCase()) || n.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Mic size={24} className="text-emerald-500" />
            My Notes
          </h1>
          <p className="text-sm text-gray-500 mt-1">{notes.length} note{notes.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={() => setNewNoteOpen(true)}
          className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2">
          <FileText size={14} /> New Note
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search notes..."
          className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 placeholder:text-gray-400 focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/30"
        />
      </div>

      {/* Create New Note Inline */}
      {newNoteOpen && (
        <div className="bg-white dark:bg-gray-900 border border-emerald-200 dark:border-emerald-800 rounded-xl p-5 mb-4 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">New Note</h3>
            <button onClick={() => { setNewNoteOpen(false); setNewTitle(''); setNewContent(''); }}
              className="p-1 text-gray-400 hover:text-gray-600 transition-colors"><X size={14} /></button>
          </div>
          <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)}
            placeholder="Note title..."
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 mb-2 focus:outline-none focus:border-emerald-400" />
          <textarea value={newContent} onChange={e => setNewContent(e.target.value)}
            placeholder="Note content..."
            rows={4}
            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 resize-none focus:outline-none focus:border-emerald-400" />
          <div className="flex justify-end gap-2 mt-3">
            <button onClick={() => { setNewNoteOpen(false); setNewTitle(''); setNewContent(''); }}
              className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors">Cancel</button>
            <button onClick={handleCreateNote} disabled={!newTitle.trim() || saving}
              className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1">
              <Save size={12} /> {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Notes List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-xl p-5 border border-gray-100 dark:border-gray-800 animate-pulse">
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-2" />
              <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-1/4" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <Mic size={40} className="text-gray-300 dark:text-gray-600 mx-auto mb-3" />
          <p className="text-sm text-gray-400">{searchQuery ? 'No notes match your search.' : 'No notes yet. Use the voice recorder or create a text note.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(note => {
            const isExpanded = expandedId === note.id;
            const isEditing = editingId === note.id;
            const badge = TYPE_BADGES[note.type] || TYPE_BADGES.text_note;

            return (
              <div key={note.id}
                className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl overflow-hidden hover:border-gray-200 dark:hover:border-gray-700 transition-colors shadow-sm">
                {/* Header row */}
                <div className="flex items-center gap-3 px-5 py-3.5 cursor-pointer"
                  onClick={() => { setExpandedId(isExpanded ? null : note.id); if (isEditing && !isExpanded) setEditingId(null); }}>
                  <ChevronDown size={14} className={`text-gray-400 transition-transform flex-shrink-0 ${isExpanded ? '' : '-rotate-90'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{note.title}</p>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0"
                        style={{ color: badge.color, backgroundColor: badge.bg }}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-0.5">
                      <span>{formatDate(note.createdAt)}</span>
                      {note.duration > 0 && (
                        <span className="flex items-center gap-1"><Clock size={10} /> {formatDuration(note.duration)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                    <button onClick={() => startEdit(note)}
                      className="p-1.5 text-gray-400 hover:text-blue-500 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                      <Edit3 size={13} />
                    </button>
                    <button onClick={() => setDeleteConfirm(note.id)}
                      className="p-1.5 text-gray-400 hover:text-red-500 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="px-5 pb-4 border-t border-gray-100 dark:border-gray-800 pt-3">
                    {isEditing ? (
                      <div>
                        <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)}
                          className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 mb-2 focus:outline-none focus:border-emerald-400" />
                        <textarea value={editContent} onChange={e => setEditContent(e.target.value)}
                          rows={5}
                          className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 resize-none focus:outline-none focus:border-emerald-400" />
                        <div className="flex justify-end gap-2 mt-2">
                          <button onClick={() => setEditingId(null)}
                            className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors">Cancel</button>
                          <button onClick={handleSaveEdit} disabled={saving || !editTitle.trim()}
                            className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1">
                            <Save size={12} /> {saving ? 'Saving...' : 'Save'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed">
                        {note.content || <span className="italic text-gray-400">No content</span>}
                      </p>
                    )}
                  </div>
                )}

                {/* Delete confirmation */}
                {deleteConfirm === note.id && (
                  <div className="px-5 pb-3 flex items-center gap-2 text-xs">
                    <span className="text-red-500 font-medium">Delete this note?</span>
                    <button onClick={() => handleDelete(note.id)}
                      className="px-2 py-1 bg-red-500 text-white rounded text-[11px] font-medium hover:bg-red-600 transition-colors">Yes, delete</button>
                    <button onClick={() => setDeleteConfirm(null)}
                      className="px-2 py-1 text-gray-500 hover:text-gray-700 text-[11px] transition-colors">Cancel</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
