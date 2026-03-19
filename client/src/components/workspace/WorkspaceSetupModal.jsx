import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  X, ChevronRight, ChevronLeft, LayoutGrid, Check, Plus, Trash2,
  Zap, Briefcase, Calendar, Code2, Target, Package, Users, Star,
  BookOpen, Megaphone, Sparkles, FileText,
} from 'lucide-react';
import api from '../../services/api';
import { WORKSPACE_TEMPLATES } from '../../utils/workspaceTemplates';

const ICON_MAP = {
  Megaphone, Calendar, Code2, Target, Package, Users, Star,
  BookOpen, Briefcase, Zap, Sparkles, FileText,
};

const CATEGORIES = ['All', 'General', 'Marketing', 'Sales', 'Engineering', 'Product', 'Operations', 'HR', 'Strategy', 'Executive', 'Creative'];

export default function WorkspaceSetupModal({ workspace, onClose, onDone }) {
  const [step, setStep] = useState(1); // 1=template, 2=add tasks
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [filterCat, setFilterCat] = useState('All');
  const [applying, setApplying] = useState(false);
  const [appliedBoards, setAppliedBoards] = useState([]);
  const [tasks, setTasks] = useState([{ title: '', assignedTo: '', boardId: '' }]);
  const [members, setMembers] = useState([]);
  const [savingTasks, setSavingTasks] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Load workspace members for task assignment
    api.get(`/workspaces/${workspace.id}`).then(res => {
      const ws = res.data.workspace || res.data.data?.workspace;
      setMembers(ws?.workspaceMembers || []);
      if (ws?.boards?.length > 0) {
        setAppliedBoards(ws.boards);
        setStep(2); // workspace already has boards, skip template
      }
    }).catch(() => {});
  }, [workspace.id]);

  const filtered = filterCat === 'All'
    ? WORKSPACE_TEMPLATES
    : WORKSPACE_TEMPLATES.filter(t => t.category === filterCat);

  async function applyTemplate() {
    if (!selectedTemplate) { setError('Please select a template.'); return; }
    setApplying(true);
    setError('');
    try {
      const res = await api.post(`/workspaces/${workspace.id}/apply-template`, {
        boards: selectedTemplate.boards,
      });
      setAppliedBoards(res.data.boards || res.data.data?.boards || []);
      setStep(2);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to apply template.');
    }
    setApplying(false);
  }

  async function skipTemplate() {
    // Create a blank board in the workspace
    setApplying(true);
    try {
      const res = await api.post('/boards', {
        name: `${workspace.name} Board`,
        color: workspace.color || '#0073ea',
        workspaceId: workspace.id,
      });
      const board = res.data.board || res.data.data?.board;
      if (board) setAppliedBoards([board]);
    } catch {}
    setApplying(false);
    setStep(2);
  }

  function addTaskRow() {
    setTasks(t => [...t, { title: '', assignedTo: '', boardId: '' }]);
  }

  function removeTaskRow(i) {
    setTasks(t => t.filter((_, idx) => idx !== i));
  }

  function updateTask(i, field, val) {
    setTasks(t => t.map((task, idx) => idx === i ? { ...task, [field]: val } : task));
  }

  async function saveTasks() {
    const validTasks = tasks.filter(t => t.title.trim());
    if (validTasks.length === 0) { onDone?.(); onClose(); return; }

    setSavingTasks(true);
    setError('');
    const defaultBoardId = appliedBoards[0]?.id;

    try {
      for (const task of validTasks) {
        const boardId = task.boardId || defaultBoardId;
        if (!boardId) continue;
        await api.post('/tasks', {
          title: task.title.trim(),
          boardId,
          assignedTo: task.assignedTo || undefined,
          status: 'not_started',
        });
      }
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create tasks.');
    }
    setSavingTasks(false);
  }

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden animate-fade-in">

        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border flex-shrink-0">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-sm"
            style={{ backgroundColor: workspace.color || '#0073ea' }}>
            {workspace.name.charAt(0)}
          </div>
          <div>
            <h2 className="text-base font-semibold text-text-primary">Set up "{workspace.name}"</h2>
            <p className="text-xs text-text-tertiary">
              {step === 1 ? 'Choose a template to get started fast' : 'Add tasks to this workspace'}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {/* Step indicator */}
            <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${step >= 1 ? 'bg-primary text-white' : 'bg-surface text-text-tertiary'}`}>1</div>
              <div className="w-4 h-px bg-border" />
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${step >= 2 ? 'bg-primary text-white' : 'bg-surface text-text-tertiary'}`}>2</div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-md text-text-tertiary hover:bg-surface transition-colors">
              <X size={16} />
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-6 mt-3 bg-danger/10 text-danger text-sm px-3 py-2 rounded-lg flex items-center gap-2">
            <X size={14} /> {error}
          </div>
        )}

        {/* ─── STEP 1: Template Selection ─── */}
        {step === 1 && (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {/* Category filter */}
              <div className="flex gap-1.5 flex-wrap mb-4">
                {CATEGORIES.map(cat => (
                  <button key={cat} onClick={() => setFilterCat(cat)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${filterCat === cat ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-hover'}`}>
                    {cat}
                  </button>
                ))}
              </div>

              {/* Templates grid */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {filtered.map(template => {
                  const IconComp = ICON_MAP[template.icon] || Briefcase;
                  const isSelected = selectedTemplate?.id === template.id;
                  return (
                    <button key={template.id} onClick={() => setSelectedTemplate(template)}
                      className={`relative text-left p-4 rounded-xl border-2 transition-all hover:shadow-md ${isSelected ? 'border-primary bg-primary/5 shadow-md' : 'border-border hover:border-primary/40 bg-white'}`}>
                      {isSelected && (
                        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                          <Check size={11} className="text-white" />
                        </div>
                      )}
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center mb-3"
                        style={{ backgroundColor: `${template.color}18` }}>
                        <IconComp size={18} style={{ color: template.color }} />
                      </div>
                      <p className="text-sm font-semibold text-text-primary truncate">{template.name}</p>
                      <p className="text-xs text-text-tertiary mt-0.5 line-clamp-2">{template.description}</p>
                      <div className="flex items-center gap-1 mt-2">
                        <span className="text-[10px] text-text-tertiary bg-surface px-2 py-0.5 rounded-full">
                          {template.boards.length} board{template.boards.length > 1 ? 's' : ''}
                        </span>
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                          style={{ backgroundColor: `${template.color}18`, color: template.color }}>
                          {template.category}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-surface/30 flex-shrink-0">
              <button onClick={skipTemplate} disabled={applying}
                className="text-sm text-text-secondary hover:text-text-primary transition-colors">
                Skip — start with blank board
              </button>
              <button onClick={applyTemplate} disabled={!selectedTemplate || applying}
                className="flex items-center gap-2 px-5 py-2.5 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary-600 disabled:opacity-50 transition-colors shadow-sm">
                {applying ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : null}
                {applying ? 'Creating boards...' : <>Apply Template <ChevronRight size={15} /></>}
              </button>
            </div>
          </>
        )}

        {/* ─── STEP 2: Add Tasks ─── */}
        {step === 2 && (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {/* Boards created */}
              {appliedBoards.length > 0 && (
                <div className="mb-5 p-3 bg-success/5 border border-success/20 rounded-xl">
                  <p className="text-xs font-semibold text-success mb-2 flex items-center gap-1.5">
                    <Check size={13} /> Boards ready in workspace
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {appliedBoards.map(b => (
                      <span key={b.id} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-white border border-border">
                        <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: b.color || '#0073ea' }} />
                        {b.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-text-primary">Add initial tasks</h3>
                <span className="text-xs text-text-tertiary">Optional — you can add more later from the board</span>
              </div>

              {/* Task rows */}
              <div className="space-y-2">
                {tasks.map((task, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <div className="flex-1 flex items-center gap-2 border border-border rounded-lg px-3 py-2 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20 transition-all bg-white">
                      <input
                        type="text"
                        placeholder={`Task ${i + 1} title...`}
                        value={task.title}
                        onChange={e => updateTask(i, 'title', e.target.value)}
                        className="flex-1 border-none outline-none text-sm text-text-primary bg-transparent"
                      />
                      {/* Board selector */}
                      {appliedBoards.length > 1 && (
                        <select
                          value={task.boardId}
                          onChange={e => updateTask(i, 'boardId', e.target.value)}
                          className="border-none outline-none text-xs text-text-secondary bg-transparent cursor-pointer"
                        >
                          <option value="">Board: {appliedBoards[0]?.name}</option>
                          {appliedBoards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      )}
                      {/* Assignee selector */}
                      {members.length > 0 && (
                        <select
                          value={task.assignedTo}
                          onChange={e => updateTask(i, 'assignedTo', e.target.value)}
                          className="border-none outline-none text-xs text-text-secondary bg-transparent cursor-pointer max-w-[130px]"
                        >
                          <option value="">Assign to...</option>
                          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      )}
                    </div>
                    <button onClick={() => removeTaskRow(i)}
                      className="p-1.5 rounded-md text-text-tertiary hover:text-danger hover:bg-danger/5 transition-colors flex-shrink-0">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>

              <button onClick={addTaskRow}
                className="mt-3 flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors">
                <Plus size={15} /> Add another task
              </button>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-surface/30 flex-shrink-0">
              <button onClick={() => setStep(1)} className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors">
                <ChevronLeft size={15} /> Back to templates
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => { onDone?.(); onClose(); }}
                  className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary border border-border rounded-xl hover:bg-surface transition-colors">
                  Skip tasks
                </button>
                <button onClick={saveTasks} disabled={savingTasks}
                  className="flex items-center gap-2 px-5 py-2.5 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary-600 disabled:opacity-50 transition-colors shadow-sm">
                  {savingTasks ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Check size={15} />}
                  {savingTasks ? 'Creating tasks...' : 'Done — Save & Close'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
