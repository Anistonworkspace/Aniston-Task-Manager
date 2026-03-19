import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api';
import { WORKSPACE_TEMPLATES, TEMPLATE_CATEGORIES } from '../utils/workspaceTemplates';
import {
  Search, X, Plus, ArrowRight, LayoutGrid, Megaphone, Calendar, Code, Map,
  Package, TrendingUp, UserPlus, Target, FolderKanban, FileText, Lightbulb,
  Crown, Briefcase, Check, ChevronRight
} from 'lucide-react';

const ICON_MAP = {
  Megaphone, Calendar, Code, Map, Package, TrendingUp, UserPlus, Target,
  FolderKanban, FileText, Lightbulb, Crown, Briefcase, LayoutGrid,
};

export default function CreateWorkspacePage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1); // 1=select template, 2=customize
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
          name,
          description,
          color,
          icon: selectedTemplate.icon,
          boards: selectedTemplate.boards,
        });
      } else {
        await api.post('/workspaces', { name, description, color });
      }
      navigate('/admin-settings');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create workspace.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div key="step1" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, x: -30 }}>
            {/* Header */}
            <div className="text-center mb-8">
              <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100 mb-1">Create a Workspace</h1>
              <p className="text-sm text-gray-500">Choose a template or start from scratch</p>
            </div>

            {/* Search + Category Filter */}
            <div className="flex items-center gap-3 mb-6">
              <div className="flex-1 relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search templates..."
                  className="w-full pl-10 pr-4 py-2.5 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary" />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            {/* Category Tabs */}
            <div className="flex gap-1.5 flex-wrap mb-6">
              {TEMPLATE_CATEGORIES.map(cat => (
                <button key={cat.id} onClick={() => setCategory(cat.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all border ${
                    category === cat.id
                      ? 'bg-primary text-white border-primary'
                      : 'bg-white dark:bg-zinc-700 text-gray-500 border-gray-200 dark:border-zinc-600 hover:border-gray-300'
                  }`}>{cat.label}</button>
              ))}
            </div>

            {/* Blank Workspace */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-4">
              <motion.div whileHover={{ scale: 1.03 }} onClick={selectBlank}
                className="border-2 border-dashed border-gray-300 dark:border-zinc-600 rounded-xl p-5 cursor-pointer hover:border-primary hover:bg-primary/5 transition-all text-center">
                <div className="w-12 h-12 rounded-xl bg-gray-100 dark:bg-zinc-700 flex items-center justify-center mx-auto mb-3">
                  <Plus size={24} className="text-gray-400" />
                </div>
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Empty Workspace</h3>
                <p className="text-[11px] text-gray-400 mt-1">Start from scratch</p>
              </motion.div>
            </div>

            {/* Template Grid */}
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Templates</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filtered.map(template => {
                const Icon = ICON_MAP[template.icon] || Briefcase;
                return (
                  <motion.div key={template.id} whileHover={{ scale: 1.03, y: -2 }}
                    onClick={() => selectTemplate(template)}
                    className="bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl p-4 cursor-pointer hover:shadow-lg hover:border-primary/30 transition-all group">
                    <div className="rounded-lg p-3 mb-3" style={{ backgroundColor: `${template.color}12` }}>
                      <div className="flex items-center gap-2 mb-2">
                        <Icon size={16} style={{ color: template.color }} />
                        <h3 className="text-sm font-bold" style={{ color: template.color }}>{template.name}</h3>
                      </div>
                      {/* Mini preview */}
                      <div className="bg-white dark:bg-zinc-800 rounded-md p-2 border border-gray-100 dark:border-zinc-700">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Icon size={10} style={{ color: template.color }} />
                          <span className="text-[9px] font-semibold text-gray-600 dark:text-gray-400">{template.boards[0]?.name}</span>
                        </div>
                        {template.boards[0]?.groups.slice(0, 3).map(g => (
                          <div key={g.id} className="flex items-center gap-1.5 mb-1">
                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: g.color }} />
                            <div className="h-1 bg-gray-100 dark:bg-zinc-600 rounded flex-1" />
                            <div className="h-1 bg-gray-100 dark:bg-zinc-600 rounded w-6" />
                          </div>
                        ))}
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 line-clamp-1">{template.description}</p>
                    <div className="flex items-center gap-1.5 mt-2">
                      <span className="text-[10px] text-gray-400">{template.boards.length} board{template.boards.length > 1 ? 's' : ''}</span>
                      <span className="text-[10px] text-gray-300">·</span>
                      <span className="text-[10px] text-gray-400 capitalize">{template.category}</span>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div key="step2" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
            <button onClick={() => setStep(1)} className="flex items-center gap-1 text-sm text-gray-500 hover:text-primary mb-4">
              ← Back to templates
            </button>

            <div className="max-w-lg mx-auto">
              <div className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-6 shadow-sm">
                <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-1">
                  {selectedTemplate ? `Create "${selectedTemplate.name}" Workspace` : 'Create Workspace'}
                </h2>
                <p className="text-sm text-gray-500 mb-6">
                  {selectedTemplate ? `${selectedTemplate.boards.length} board(s) will be created automatically` : 'Start with an empty workspace'}
                </p>

                {error && (
                  <div className="bg-red-50 text-red-600 text-xs px-3 py-2 rounded-lg mb-4">{error}</div>
                )}

                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5 block">Workspace Name</label>
                    <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus
                      placeholder="e.g., Marketing Team, Engineering..."
                      className="w-full px-3 py-2.5 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5 block">Description</label>
                    <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
                      placeholder="What is this workspace for?"
                      className="w-full px-3 py-2.5 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary resize-none" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5 block">Color</label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={color} onChange={e => setColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer" />
                      <span className="text-xs text-gray-400">{color}</span>
                    </div>
                  </div>

                  {/* Template preview */}
                  {selectedTemplate && (
                    <div>
                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5 block">Boards to be created</label>
                      <div className="space-y-2">
                        {selectedTemplate.boards.map((b, i) => (
                          <div key={i} className="flex items-center gap-2 p-2.5 bg-gray-50 dark:bg-zinc-700 rounded-lg">
                            <div className="w-3 h-3 rounded" style={{ backgroundColor: b.color }} />
                            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{b.name}</span>
                            <span className="text-[10px] text-gray-400 ml-auto">{b.groups.length} groups · {b.columns.length} columns</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button onClick={handleCreate} disabled={creating}
                    className="w-full py-2.5 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2 mt-2 transition-colors">
                    {creating ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                    ) : (
                      <><Check size={16} /> Create Workspace</>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
