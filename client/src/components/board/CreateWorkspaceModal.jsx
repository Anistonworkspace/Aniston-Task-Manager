import React, { useState } from 'react';
import {
  X, Plus, Search, Check, ArrowLeft, Megaphone, Calendar, Code, Map,
  Package, TrendingUp, UserPlus, Target, FolderKanban, FileText,
  Lightbulb, Crown, Briefcase, LayoutGrid
} from 'lucide-react';
import api from '../../services/api';
import { WORKSPACE_TEMPLATES, TEMPLATE_CATEGORIES } from '../../utils/workspaceTemplates';

const ICON_MAP = {
  Megaphone, Calendar, Code, Map, Package, TrendingUp, UserPlus, Target,
  FolderKanban, FileText, Lightbulb, Crown, Briefcase, LayoutGrid,
};

const PRESET_COLORS = ['#0073ea', '#00c875', '#fdab3d', '#e2445c', '#a25ddc', '#579bfc', '#ff642e', '#333333', '#9cd326', '#ff158a', '#66ccff', '#037f4c'];

export default function CreateWorkspaceModal({ onClose, onCreated }) {
  const [step, setStep] = useState(1);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#0073ea');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const filtered = WORKSPACE_TEMPLATES.filter(t => {
    if (category !== 'all' && t.category !== category) return false;
    if (searchQuery && !t.name.toLowerCase().includes(searchQuery.toLowerCase()) && !t.description.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  function selectTemplate(template) {
    setSelectedTemplate(template);
    setName(template.name);
    setDescription(template.description);
    setColor(template.color);
    setStep(2);
  }

  function selectBlank() {
    setSelectedTemplate(null);
    setName('');
    setDescription('');
    setColor('#0073ea');
    setStep(2);
  }

  async function handleCreate() {
    if (!name.trim()) { setError('Name is required'); return; }
    setCreating(true);
    setError('');
    try {
      if (selectedTemplate) {
        await api.post('/workspaces/from-template', {
          templateId: selectedTemplate.id,
          name, description, color,
          icon: selectedTemplate.icon,
          boards: selectedTemplate.boards,
        });
      } else {
        await api.post('/workspaces', { name, description, color });
      }
      if (onCreated) onCreated();
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create workspace.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden animate-slide-in" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border dark:border-zinc-700">
          <div className="flex items-center gap-3">
            {step === 2 && (
              <button onClick={() => setStep(1)} className="p-1 rounded-lg hover:bg-surface dark:hover:bg-zinc-700 text-text-secondary transition-colors">
                <ArrowLeft size={18} />
              </button>
            )}
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-400 flex items-center justify-center">
              <Plus size={16} className="text-white" />
            </div>
            <div>
              <h2 className="text-base font-bold text-text-primary dark:text-white">
                {step === 1 ? 'Add New Workspace' : selectedTemplate ? `Create "${selectedTemplate.name}"` : 'New Workspace'}
              </h2>
              <p className="text-[11px] text-text-tertiary">
                {step === 1 ? 'Choose a template or start from scratch' : selectedTemplate ? `${selectedTemplate.boards.length} board(s) with sprints will be created` : 'Start with an empty workspace'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface dark:hover:bg-zinc-700 text-text-tertiary hover:text-text-primary transition-colors">
            <X size={18} />
          </button>
        </div>

        {step === 1 ? (
          <div className="p-5 overflow-y-auto max-h-[calc(85vh-80px)]">
            {/* Search */}
            <div className="relative mb-4">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search templates..."
                className="w-full pl-10 pr-4 py-2.5 border border-border dark:border-zinc-600 rounded-xl text-sm focus:outline-none focus:border-primary bg-transparent" autoFocus />
            </div>

            {/* Category Chips */}
            <div className="flex gap-1.5 flex-wrap mb-5">
              {TEMPLATE_CATEGORIES.map(cat => (
                <button key={cat.id} onClick={() => setCategory(cat.id)}
                  className={`px-3 py-1.5 text-[11px] font-medium rounded-full transition-all duration-200 border ${
                    category === cat.id
                      ? 'bg-primary text-white border-primary shadow-sm'
                      : 'bg-white dark:bg-zinc-700 text-text-secondary border-border dark:border-zinc-600 hover:border-primary/30'
                  }`}>{cat.label}</button>
              ))}
            </div>

            {/* Blank Workspace */}
            <button onClick={selectBlank}
              className="w-full mb-4 border-2 border-dashed border-border dark:border-zinc-600 rounded-xl p-4 hover:border-primary hover:bg-primary/5 transition-all duration-200 flex items-center gap-4 text-left group">
              <div className="w-12 h-12 rounded-xl bg-surface dark:bg-zinc-700 flex items-center justify-center group-hover:bg-primary/10 transition-colors">
                <Plus size={22} className="text-text-tertiary group-hover:text-primary transition-colors" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary dark:text-white">Empty Workspace</h3>
                <p className="text-[11px] text-text-tertiary">Start from scratch with a blank workspace</p>
              </div>
            </button>

            {/* Template Grid */}
            <p className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider mb-3">Templates</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {filtered.map(template => {
                const Icon = ICON_MAP[template.icon] || Briefcase;
                return (
                  <button key={template.id} onClick={() => selectTemplate(template)}
                    className="bg-white dark:bg-zinc-800 border border-border dark:border-zinc-700 rounded-xl p-3.5 text-left hover:shadow-lg hover:border-primary/30 transition-all duration-200 group">
                    {/* Mini Preview */}
                    <div className="rounded-lg p-2.5 mb-2.5" style={{ backgroundColor: `${template.color}10` }}>
                      <div className="flex items-center gap-2 mb-2">
                        <Icon size={14} style={{ color: template.color }} />
                        <span className="text-xs font-bold truncate" style={{ color: template.color }}>{template.name}</span>
                      </div>
                      {/* Sprint preview */}
                      <div className="bg-white dark:bg-zinc-800 rounded-md p-2 border border-gray-100/50 dark:border-zinc-700/50">
                        {template.boards[0]?.groups.slice(0, 4).map(g => (
                          <div key={g.id} className="flex items-center gap-1.5 mb-1 last:mb-0">
                            <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: g.color }} />
                            <span className="text-[8px] text-text-tertiary truncate">{g.title}</span>
                            <div className="h-0.5 bg-gray-100 dark:bg-zinc-600 rounded flex-1" />
                          </div>
                        ))}
                      </div>
                    </div>
                    <p className="text-[11px] text-text-secondary line-clamp-1">{template.description}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[9px] text-text-tertiary">{template.boards.length} board{template.boards.length > 1 ? 's' : ''}</span>
                      <span className="text-[9px] text-text-tertiary">·</span>
                      <span className="text-[9px] text-text-tertiary capitalize">{template.category}</span>
                      <span className="text-[9px] text-text-tertiary">·</span>
                      <span className="text-[9px] text-text-tertiary">{template.boards[0]?.groups.length} sprints</span>
                    </div>
                  </button>
                );
              })}
            </div>
            {filtered.length === 0 && (
              <div className="text-center py-8 text-text-tertiary text-sm">No templates match your search</div>
            )}
          </div>
        ) : (
          /* Step 2: Customize */
          <div className="p-6 overflow-y-auto max-h-[calc(85vh-80px)]">
            <div className="max-w-md mx-auto space-y-5">
              {error && (
                <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs px-4 py-2.5 rounded-lg">{error}</div>
              )}

              {/* Name */}
              <div>
                <label className="text-xs font-medium text-text-secondary mb-1.5 block">Workspace Name</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus
                  placeholder="e.g., Engineering Team, Marketing Q1..."
                  className="w-full px-3.5 py-2.5 border border-border dark:border-zinc-600 rounded-xl text-sm focus:outline-none focus:border-primary bg-transparent" />
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-medium text-text-secondary mb-1.5 block">Description</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
                  placeholder="What's this workspace for?"
                  className="w-full px-3.5 py-2.5 border border-border dark:border-zinc-600 rounded-xl text-sm focus:outline-none focus:border-primary bg-transparent resize-none" />
              </div>

              {/* Color */}
              <div>
                <label className="text-xs font-medium text-text-secondary mb-1.5 block">Color</label>
                <div className="flex items-center gap-2 flex-wrap">
                  {PRESET_COLORS.map(c => (
                    <button key={c} onClick={() => setColor(c)}
                      className={`w-7 h-7 rounded-lg transition-all duration-200 ${color === c ? 'ring-2 ring-offset-2 ring-gray-400 dark:ring-offset-zinc-800 scale-110' : 'hover:scale-105'}`}
                      style={{ backgroundColor: c }} />
                  ))}
                </div>
              </div>

              {/* Template boards preview */}
              {selectedTemplate && (
                <div>
                  <label className="text-xs font-medium text-text-secondary mb-2 block">Boards & Sprints to Create</label>
                  <div className="space-y-2">
                    {selectedTemplate.boards.map((b, i) => (
                      <div key={i} className="bg-surface dark:bg-zinc-700 rounded-xl p-3.5">
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-3 h-3 rounded" style={{ backgroundColor: b.color }} />
                          <span className="text-xs font-semibold text-text-primary dark:text-white">{b.name}</span>
                          <span className="text-[9px] text-text-tertiary ml-auto">{b.columns.length} columns</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {b.groups.map(g => (
                            <span key={g.id} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full text-white font-medium"
                              style={{ backgroundColor: g.color }}>
                              {g.title}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Create Button */}
              <button onClick={handleCreate} disabled={creating || !name.trim()}
                className="w-full py-3 bg-primary text-white text-sm font-semibold rounded-xl hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2 transition-all duration-200 shadow-sm hover:shadow-md">
                {creating ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                ) : (
                  <><Check size={16} /> Create Workspace</>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
