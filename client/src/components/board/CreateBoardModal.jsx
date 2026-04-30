import React, { useState } from 'react';
import Modal from '../common/Modal';
import { BOARD_COLORS } from '../../utils/constants';

// Single-step modal: every new board uses the backend's default 3-group seed
// (New Task / In Progress / Done) so status↔group auto-move works out of the
// box. Templates were removed because they shipped non-conforming groups
// (Backlog, Sprint, Code Review, etc.) that broke the default workflow.
export default function CreateBoardModal({ isOpen, onClose, onSubmit }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(BOARD_COLORS[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function reset() {
    setName('');
    setDescription('');
    setColor(BOARD_COLORS[0]);
    setError('');
    setLoading(false);
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    if (!name.trim()) { setError('Board name is required'); return; }
    setLoading(true);
    try {
      // Intentionally omit `groups` and `columns`: the backend Board model
      // supplies the canonical defaults.
      await onSubmit({ name: name.trim(), description: description.trim(), color });
      reset();
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create board');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => { reset(); onClose(); }}
      title="Create New Board"
      footer={
        <button
          onClick={handleSubmit}
          disabled={loading}
          className="px-4 py-2 text-sm rounded-md bg-primary text-white hover:bg-primary-hover disabled:opacity-60 font-medium"
        >
          {loading ? 'Creating...' : 'Create Board'}
        </button>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-md">{error}</div>}
        <div>
          <label className="block text-sm font-medium mb-1.5">Board Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sprint 24"
            className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1.5">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this board for?"
            className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none h-20"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1.5">Color</label>
          <div className="flex gap-2 flex-wrap">
            {BOARD_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-7 h-7 rounded-full transition-all ${c === color ? 'ring-2 ring-offset-2 ring-primary scale-110' : 'hover:scale-110'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <p className="text-xs text-text-tertiary">
          Your board will start with three default groups: <strong>New Task</strong>, <strong>In Progress</strong>, and <strong>Done</strong>.
        </p>
      </form>
    </Modal>
  );
}
