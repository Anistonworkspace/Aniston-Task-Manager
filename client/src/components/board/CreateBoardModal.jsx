import React, { useState } from 'react';
import Modal from '../common/Modal';
import { BOARD_COLORS } from '../../utils/constants';
import { BOARD_TEMPLATES } from '../../utils/boardTemplates';

export default function CreateBoardModal({ isOpen, onClose, onSubmit }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(BOARD_COLORS[0]);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState('template'); // 'template' | 'details'

  function reset() { setName(''); setDescription(''); setColor(BOARD_COLORS[0]); setError(''); setLoading(false); setSelectedTemplate(null); setStep('template'); }

  function selectTemplate(tmpl) {
    setSelectedTemplate(tmpl);
    if (tmpl) {
      setName(tmpl.name);
      setDescription(tmpl.description);
      setColor(tmpl.color);
    }
    setStep('details');
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    if (!name.trim()) { setError('Board name is required'); return; }
    setLoading(true);
    try {
      const payload = { name: name.trim(), description: description.trim(), color };
      if (selectedTemplate) {
        payload.groups = selectedTemplate.groups;
        payload.columns = selectedTemplate.columns;
      }
      await onSubmit(payload);
      reset(); onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create board');
    } finally { setLoading(false); }
  }

  return (
    <Modal isOpen={isOpen} onClose={() => { reset(); onClose(); }} title={step === 'template' ? 'Choose a Template' : 'Create New Board'} footer={
      step === 'details' ? (
        <>
          <button onClick={() => setStep('template')} className="px-4 py-2 text-sm rounded-md border border-border text-text-primary hover:bg-surface">Back</button>
          <button onClick={handleSubmit} disabled={loading} className="px-4 py-2 text-sm rounded-md bg-primary text-white hover:bg-primary-hover disabled:opacity-60 font-medium">
            {loading ? 'Creating...' : 'Create Board'}
          </button>
        </>
      ) : null
    }>
      {step === 'template' ? (
        <div className="space-y-3">
          {/* Blank board option */}
          <button onClick={() => selectTemplate(null)}
            className="w-full text-left p-3 rounded-lg border-2 border-dashed border-border hover:border-primary/30 hover:bg-primary/5 transition-all">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-surface flex items-center justify-center text-lg">📋</div>
              <div>
                <p className="text-sm font-semibold text-text-primary">Blank Board</p>
                <p className="text-xs text-text-tertiary">Start from scratch with default groups</p>
              </div>
            </div>
          </button>

          <p className="text-[10px] uppercase tracking-wider font-semibold text-text-tertiary">Or start from a template</p>

          {BOARD_TEMPLATES.map(tmpl => (
            <button key={tmpl.id} onClick={() => selectTemplate(tmpl)}
              className="w-full text-left p-3 rounded-lg border border-border hover:border-primary/30 hover:shadow-sm transition-all">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center text-lg" style={{ backgroundColor: `${tmpl.color}15` }}>
                  {tmpl.icon}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-text-primary">{tmpl.name}</p>
                  <p className="text-xs text-text-tertiary">{tmpl.description}</p>
                </div>
                <div className="text-[10px] text-text-tertiary">{tmpl.groups.length} groups</div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-md">{error}</div>}
          {selectedTemplate && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-xs">
              <span className="text-lg">{selectedTemplate.icon}</span>
              <span className="font-medium text-primary">Using template: {selectedTemplate.name}</span>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1.5">Board Name *</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sprint 24" className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" autoFocus />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Description</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this board for?" className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none h-20" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Color</label>
            <div className="flex gap-2 flex-wrap">
              {BOARD_COLORS.map(c => (
                <button key={c} type="button" onClick={() => setColor(c)} className={`w-7 h-7 rounded-full transition-all ${c === color ? 'ring-2 ring-offset-2 ring-primary scale-110' : 'hover:scale-110'}`} style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
