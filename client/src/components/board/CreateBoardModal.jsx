import React, { useState, useEffect, useRef } from 'react';
import { X, Plus, ArrowUp, ArrowDown } from 'lucide-react';
import Modal from '../common/Modal';
import { BOARD_COLORS, GROUP_COLORS, BOARD_GROUP_TEMPLATES } from '../../utils/constants';

// Pick a random colour from BOARD_COLORS that hasn't already been used by
// another board in the same workspace. If every palette colour is already
// taken, fall back to a fully random pick from the full palette.
function pickRandomColor(usedColors = []) {
  const used = new Set((usedColors || []).filter(Boolean).map(c => String(c).toLowerCase()));
  const available = BOARD_COLORS.filter(c => !used.has(c.toLowerCase()));
  const pool = available.length > 0 ? available : BOARD_COLORS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Default groups when no template is selected — mirrors the backend's Board
// model defaults so a do-nothing submit produces the legacy 3-group board.
const DEFAULT_GROUPS = ['New Task', 'In Progress', 'Done'];

const MAX_GROUP_NAME_LEN = 80;

function normalizeName(s) { return String(s || '').trim(); }

// Build the final groups payload sent to the backend. Each group gets a
// stable id, a colour cycled from GROUP_COLORS, and an explicit position so
// the server doesn't have to infer ordering. Status mapping is intentionally
// omitted: only the canonical "Default Task Flow" preset hits the legacy
// status auto-move codepath, and that one we still default-send (because
// when the user picks "Default" we omit `groups` from the payload entirely
// and let the Board model defaults — which include mappedStatus — apply).
function buildGroupsPayload(names) {
  return names.map((name, i) => ({
    id: `g_${i}_${Math.random().toString(36).slice(2, 8)}`,
    title: name,
    color: GROUP_COLORS[i % GROUP_COLORS.length],
    position: i,
  }));
}

// Single-step modal that creates a board inside a specific workspace. The
// modal is reused both from the per-workspace dropdown ("Create Board")
// where `workspaceId` is fixed, and from the bottom-of-sidebar button where
// `availableWorkspaces` is provided so the user can pick.
//
// Props:
//   workspaceId          — fixed workspace; selector is hidden when set.
//   workspaceName        — cosmetic; shown in the title when fixed.
//   usedColors           — colours already taken in the target workspace.
//   availableWorkspaces  — full workspace list shown when no fixed workspace.
export default function CreateBoardModal({
  isOpen, onClose, onSubmit,
  workspaceId = null, workspaceName = '', usedColors = [],
  availableWorkspaces = [],
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(() => pickRandomColor(usedColors));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Workspace selection — when workspaceId is fixed (per-workspace open) we
  // mirror it into local state so the submit path is uniform; when not, the
  // user picks from availableWorkspaces.
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaceId || '');

  // Group editor state.
  const [templateId, setTemplateId] = useState('default');
  const [selectedGroups, setSelectedGroups] = useState([...DEFAULT_GROUPS]);
  const [customGroupInput, setCustomGroupInput] = useState('');

  const wasOpen = useRef(false);

  // Re-roll the random colour every time the modal transitions closed → open
  // so a fresh choice is made when the user opens it from a different
  // workspace. Also reset groups + workspace selection.
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setColor(pickRandomColor(usedColors));
      setSelectedWorkspaceId(workspaceId || '');
      setTemplateId('default');
      setSelectedGroups([...DEFAULT_GROUPS]);
      setCustomGroupInput('');
      setError('');
      wasOpen.current = true;
    } else if (!isOpen) {
      wasOpen.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function reset() {
    setName('');
    setDescription('');
    setColor(pickRandomColor(usedColors));
    setSelectedWorkspaceId(workspaceId || '');
    setTemplateId('default');
    setSelectedGroups([...DEFAULT_GROUPS]);
    setCustomGroupInput('');
    setError('');
    setLoading(false);
  }

  function applyTemplate(id) {
    setTemplateId(id);
    const tpl = BOARD_GROUP_TEMPLATES.find(t => t.id === id);
    if (!tpl) return;
    setSelectedGroups([...tpl.groups]);
  }

  function addCustomGroup() {
    const v = normalizeName(customGroupInput);
    if (!v) return;
    if (v.length > MAX_GROUP_NAME_LEN) {
      setError(`Group name must be ${MAX_GROUP_NAME_LEN} characters or fewer`);
      return;
    }
    if (selectedGroups.some(g => g.toLowerCase() === v.toLowerCase())) {
      setError(`Group "${v}" already exists`);
      return;
    }
    setError('');
    setSelectedGroups(prev => [...prev, v]);
    setCustomGroupInput('');
    // Adding a custom group implicitly switches the template to "Custom" so
    // the UI doesn't lie about what's been selected.
    if (templateId !== 'custom') setTemplateId('custom');
  }

  function removeGroupAt(idx) {
    setSelectedGroups(prev => prev.filter((_, i) => i !== idx));
  }

  function moveGroup(idx, dir) {
    const target = idx + dir;
    if (target < 0 || target >= selectedGroups.length) return;
    setSelectedGroups(prev => {
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  // Submit guards: name required, at least one group, no duplicate group
  // names. Workspace selection is required when no fixed workspace was passed
  // in AND there are workspaces available to choose from.
  async function handleSubmit(e) {
    e?.preventDefault();
    if (loading) return;
    if (!name.trim()) { setError('Board name is required'); return; }

    const trimmedGroups = selectedGroups.map(normalizeName).filter(Boolean);
    if (trimmedGroups.length === 0) {
      setError('At least one group is required');
      return;
    }
    const dupCheck = new Set();
    for (const g of trimmedGroups) {
      const k = g.toLowerCase();
      if (dupCheck.has(k)) { setError(`Duplicate group name: "${g}"`); return; }
      dupCheck.add(k);
    }

    const effectiveWsId = workspaceId || selectedWorkspaceId || null;
    if (!effectiveWsId && availableWorkspaces.length > 0) {
      setError('Please select a workspace');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        color,
      };
      if (effectiveWsId) payload.workspaceId = effectiveWsId;
      // Only send a custom groups array when the user has changed it. Sending
      // the unchanged default would override the Board model's mappedStatus
      // metadata which keeps status↔group auto-move working.
      const isDefaultUnchanged = templateId === 'default'
        && trimmedGroups.length === DEFAULT_GROUPS.length
        && trimmedGroups.every((g, i) => g === DEFAULT_GROUPS[i]);
      if (!isDefaultUnchanged) {
        payload.groups = buildGroupsPayload(trimmedGroups);
      }

      await onSubmit(payload);
      reset();
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create board');
    } finally {
      setLoading(false);
    }
  }

  const showWorkspaceSelector = !workspaceId && availableWorkspaces.length > 0;
  const fixedWorkspaceLabel = workspaceName || (workspaceId ? 'Selected workspace' : '');

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => { reset(); onClose(); }}
      title={fixedWorkspaceLabel ? `Create Board in ${fixedWorkspaceLabel}` : 'Create New Board'}
      size="lg"
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

        {/* Workspace context line — fixed workspace shows as read-only label */}
        {!showWorkspaceSelector && fixedWorkspaceLabel && (
          <div className="text-xs text-text-tertiary">
            Workspace: <span className="font-semibold text-text-secondary">{fixedWorkspaceLabel}</span>
          </div>
        )}

        {/* Workspace selector — only when no fixed workspace was provided */}
        {showWorkspaceSelector && (
          <div>
            <label className="block text-sm font-medium mb-1.5">Workspace *</label>
            <select
              value={selectedWorkspaceId}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary bg-white dark:bg-[#1E1F23]"
            >
              <option value="">Select a workspace…</option>
              {availableWorkspaces.map(ws => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </div>
        )}

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
          <label className="block text-sm font-medium mb-1.5">Color <span className="text-text-tertiary font-normal">(auto-picked, click to change)</span></label>
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

        {/* Group template + group editor */}
        <div className="border-t border-border pt-4">
          <label className="block text-sm font-medium mb-1.5">Choose board groups / phases</label>
          <select
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            className="w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary bg-white dark:bg-[#1E1F23]"
          >
            {BOARD_GROUP_TEMPLATES.map(t => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>

          <div className="mt-3 space-y-1.5">
            {selectedGroups.length === 0 && (
              <p className="text-xs text-text-tertiary">No groups yet — pick a template or add a custom group below.</p>
            )}
            {selectedGroups.map((g, i) => (
              <div key={`${g}-${i}`} className="flex items-center gap-2 bg-surface-50 dark:bg-[#27272a] rounded-md px-2 py-1.5 text-sm">
                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: GROUP_COLORS[i % GROUP_COLORS.length] }} />
                <span className="flex-1 truncate text-text-primary">{g}</span>
                <button type="button" onClick={() => moveGroup(i, -1)} disabled={i === 0}
                  className="p-1 rounded hover:bg-surface-100 disabled:opacity-30" title="Move up">
                  <ArrowUp size={12} />
                </button>
                <button type="button" onClick={() => moveGroup(i, 1)} disabled={i === selectedGroups.length - 1}
                  className="p-1 rounded hover:bg-surface-100 disabled:opacity-30" title="Move down">
                  <ArrowDown size={12} />
                </button>
                <button type="button" onClick={() => removeGroupAt(i)}
                  className="p-1 rounded hover:bg-danger/10 text-text-tertiary hover:text-danger" title="Remove">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>

          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={customGroupInput}
              onChange={(e) => setCustomGroupInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomGroup(); } }}
              maxLength={MAX_GROUP_NAME_LEN}
              placeholder="Add custom group (e.g. On Hold)"
              className="flex-1 px-3 py-1.5 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
            <button type="button" onClick={addCustomGroup}
              className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-surface-100 transition-colors flex items-center gap-1">
              <Plus size={12} /> Add
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
