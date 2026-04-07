import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import {
  X, Users, LayoutGrid, Plus, Check, ChevronDown,
  GripVertical, UserCheck, Briefcase, Search, Zap,
} from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';
import WorkspaceSetupModal from './WorkspaceSetupModal';

const HIERARCHY_LABELS = {
  member: 'Member', team_lead: 'Team Lead', manager: 'Manager',
  senior_manager: 'Sr. Manager', director: 'Director', vp: 'VP', ceo: 'CEO',
};

// Small inline popup attached to a button
function InlinePopup({ anchorRef, open, onClose, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (open && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, left: Math.max(8, rect.left - 160) });
    }
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef.current?.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} className="fixed z-[500] bg-white rounded-xl shadow-2xl border border-border p-3 w-72 animate-fade-in"
      style={{ top: pos.top, left: pos.left }}>
      {children}
    </div>,
    document.body
  );
}

// Per-member action card in the selected panel
function SelectedMemberCard({ member, workspaces, index, onRefresh }) {
  const [wsOpen, setWsOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [setupWs, setSetupWs] = useState(null);
  const wsRef = useRef(null);
  const taskRef = useRef(null);

  const [taskTitle, setTaskTitle] = useState('');
  const [taskBoard, setTaskBoard] = useState('');
  const [savingTask, setSavingTask] = useState(false);
  const [savingWs, setSavingWs] = useState(null);

  const memberWorkspace = workspaces.find(w => w.workspaceMembers?.some(m => m.id === member.id));

  async function assignWs(wsId) {
    setSavingWs(wsId);
    try {
      await api.post(`/workspaces/${wsId}/members`, { userIds: [member.id] });
      const ws = workspaces.find(w => w.id === wsId);
      setWsOpen(false);
      onRefresh();
      // Open setup modal after assigning
      if (ws) setSetupWs(ws);
    } catch {}
    setSavingWs(null);
  }

  async function addTask() {
    if (!taskTitle.trim() || !taskBoard) return;
    setSavingTask(true);
    try {
      await api.post('/tasks', {
        title: taskTitle.trim(),
        boardId: taskBoard,
        assignedTo: member.id,
        status: 'not_started',
      });
      setTaskTitle('');
      setTaskBoard('');
      setTaskOpen(false);
      onRefresh();
    } catch {}
    setSavingTask(false);
  }

  // All boards from all workspaces
  const allBoards = workspaces.flatMap(w => (w.boards || []).map(b => ({ ...b, wsName: w.name })));

  return (
    <>
      <Draggable draggableId={`sel-${member.id}`} index={index}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.draggableProps}
            className={`flex items-center gap-2.5 p-3 rounded-xl border transition-all bg-white ${snapshot.isDragging ? 'shadow-lg border-primary/40 rotate-1' : 'border-border hover:border-border-hover hover:shadow-sm'}`}
          >
            <div {...provided.dragHandleProps} className="text-text-tertiary/40 hover:text-text-tertiary cursor-grab active:cursor-grabbing flex-shrink-0">
              <GripVertical size={14} />
            </div>
            <Avatar name={member.name} size="sm" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{member.name}</p>
              <p className="text-[10px] text-text-tertiary capitalize">
                {HIERARCHY_LABELS[member.hierarchyLevel] || member.role}
                {member.designation ? ` · ${member.designation}` : ''}
              </p>
            </div>

            {/* Workspace badge */}
            {memberWorkspace && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium flex-shrink-0 max-w-[80px] truncate"
                style={{ backgroundColor: `${memberWorkspace.color || '#0073ea'}18`, color: memberWorkspace.color || '#0073ea' }}>
                {memberWorkspace.name}
              </span>
            )}

            {/* Assign Workspace button */}
            <div className="relative flex-shrink-0">
              <button ref={wsRef} onClick={() => { setTaskOpen(false); setWsOpen(!wsOpen); }}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-surface hover:bg-primary/10 hover:text-primary text-text-secondary transition-all"
                title="Assign Workspace">
                <LayoutGrid size={11} />
                <span className="hidden sm:inline">Workspace</span>
                <ChevronDown size={10} />
              </button>
              <InlinePopup anchorRef={wsRef} open={wsOpen} onClose={() => setWsOpen(false)}>
                <p className="text-xs font-semibold text-text-secondary mb-2">Assign workspace to {member.name.split(' ')[0]}</p>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {workspaces.map(ws => {
                    const isAssigned = ws.workspaceMembers?.some(m => m.id === member.id);
                    return (
                      <button key={ws.id} onClick={() => !isAssigned && assignWs(ws.id)}
                        className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-xs transition-all ${isAssigned ? 'bg-primary/5 text-primary cursor-default' : 'hover:bg-surface text-text-secondary'}`}>
                        <div className="w-4 h-4 rounded flex items-center justify-center text-white text-[8px] font-bold"
                          style={{ backgroundColor: ws.color || '#0073ea' }}>
                          {ws.name.charAt(0)}
                        </div>
                        <span className="flex-1 text-left truncate">{ws.name}</span>
                        {isAssigned && <Check size={11} className="text-primary" />}
                        {savingWs === ws.id && <div className="w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin" />}
                      </button>
                    );
                  })}
                  {workspaces.length === 0 && <p className="text-xs text-text-tertiary text-center py-2">No workspaces yet</p>}
                </div>
              </InlinePopup>
            </div>

            {/* Add Task button */}
            <div className="relative flex-shrink-0">
              <button ref={taskRef} onClick={() => { setWsOpen(false); setTaskOpen(!taskOpen); }}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-surface hover:bg-success/10 hover:text-success text-text-secondary transition-all"
                title="Add Task">
                <Plus size={11} />
                <span className="hidden sm:inline">Task</span>
              </button>
              <InlinePopup anchorRef={taskRef} open={taskOpen} onClose={() => setTaskOpen(false)}>
                <p className="text-xs font-semibold text-text-secondary mb-2">Add task for {member.name.split(' ')[0]}</p>
                <input
                  type="text"
                  placeholder="Task title..."
                  value={taskTitle}
                  onChange={e => setTaskTitle(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addTask()}
                  autoFocus
                  className="w-full px-2.5 py-1.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary mb-2"
                />
                <select
                  value={taskBoard}
                  onChange={e => setTaskBoard(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20 mb-2"
                >
                  <option value="">Select board...</option>
                  {allBoards.map(b => <option key={b.id} value={b.id}>{b.name} ({b.wsName})</option>)}
                </select>
                <button onClick={addTask} disabled={!taskTitle.trim() || !taskBoard || savingTask}
                  className="w-full py-1.5 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-1">
                  {savingTask ? <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" /> : <Check size={12} />}
                  {savingTask ? 'Adding...' : 'Add Task'}
                </button>
              </InlinePopup>
            </div>
          </div>
        )}
      </Draggable>

      {/* Workspace setup modal */}
      {setupWs && (
        <WorkspaceSetupModal
          workspace={setupWs}
          onClose={() => setSetupWs(null)}
          onDone={() => { setSetupWs(null); onRefresh(); }}
        />
      )}
    </>
  );
}

export default function TeamPlannerModal({ onClose }) {
  const [availableMembers, setAvailableMembers] = useState([]);
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [teamRes, wsRes] = await Promise.all([
        api.get('/users/my-team'),
        api.get('/workspaces'),
      ]);
      const members = teamRes.data.members || teamRes.data.data?.members || [];
      const ws = wsRes.data.workspaces || wsRes.data.data?.workspaces || [];
      setWorkspaces(ws);
      // Remove already-selected from available
      const selectedIds = new Set(selectedMembers.map(m => m.id));
      setAvailableMembers(members.filter(m => !selectedIds.has(m.id)));
    } catch {}
    setLoading(false);
  }

  function onDragEnd(result) {
    const { source, destination } = result;
    if (!destination) return;

    const srcId = source.droppableId;
    const dstId = destination.droppableId;

    if (srcId === dstId) {
      // Reorder within same list
      if (srcId === 'available') {
        const items = Array.from(availableMembers);
        const [moved] = items.splice(source.index, 1);
        items.splice(destination.index, 0, moved);
        setAvailableMembers(items);
      } else {
        const items = Array.from(selectedMembers);
        const [moved] = items.splice(source.index, 1);
        items.splice(destination.index, 0, moved);
        setSelectedMembers(items);
      }
      return;
    }

    // Moving between lists
    if (srcId === 'available' && dstId === 'selected') {
      const avail = Array.from(availableMembers);
      const sel = Array.from(selectedMembers);
      const [moved] = avail.splice(source.index, 1);
      sel.splice(destination.index, 0, moved);
      setAvailableMembers(avail);
      setSelectedMembers(sel);
    } else if (srcId === 'selected' && dstId === 'available') {
      const sel = Array.from(selectedMembers);
      const avail = Array.from(availableMembers);
      const [moved] = sel.splice(source.index, 1);
      avail.splice(destination.index, 0, moved);
      setSelectedMembers(sel);
      setAvailableMembers(avail);
    }
  }

  function addAll() {
    setSelectedMembers(prev => [...prev, ...availableMembers]);
    setAvailableMembers([]);
  }

  function clearAll() {
    setAvailableMembers(prev => [...prev, ...selectedMembers]);
    setSelectedMembers([]);
  }

  const filteredAvailable = search
    ? availableMembers.filter(m => m.name.toLowerCase().includes(search.toLowerCase()) || (m.department || '').toLowerCase().includes(search.toLowerCase()))
    : availableMembers;

  return createPortal(
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden animate-fade-in">

        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border flex-shrink-0 bg-gradient-to-r from-primary/5 to-transparent">
          <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <Users size={18} className="text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-text-primary">Team Planner</h2>
            <p className="text-xs text-text-tertiary">Drag members to the right → assign workspaces and tasks inline</p>
          </div>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-md text-text-tertiary hover:bg-surface transition-colors">
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          </div>
        ) : (
          <DragDropContext onDragEnd={onDragEnd}>
            <div className="flex-1 grid grid-cols-2 gap-0 overflow-hidden min-h-0">

              {/* ── LEFT: Available Members ── */}
              <div className="flex flex-col border-r border-border overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex-shrink-0">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                      Available ({filteredAvailable.length})
                    </span>
                    <button onClick={addAll} className="text-xs text-primary hover:underline">Add all →</button>
                  </div>
                  <div className="flex items-center gap-2 bg-surface rounded-lg px-2.5 py-1.5 border border-border">
                    <Search size={12} className="text-text-tertiary" />
                    <input type="text" placeholder="Search members..." value={search}
                      onChange={e => setSearch(e.target.value)}
                      className="bg-transparent border-none outline-none text-xs w-full text-text-primary" />
                  </div>
                </div>

                <Droppable droppableId="available">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`flex-1 overflow-y-auto p-3 space-y-1.5 transition-colors ${snapshot.isDraggingOver ? 'bg-surface/50' : ''}`}
                    >
                      {filteredAvailable.map((member, i) => (
                        <Draggable key={member.id} draggableId={member.id} index={i}>
                          {(prov, snap) => (
                            <div
                              ref={prov.innerRef}
                              {...prov.draggableProps}
                              {...prov.dragHandleProps}
                              className={`flex items-center gap-2.5 p-2.5 rounded-xl border cursor-grab active:cursor-grabbing transition-all ${snap.isDragging ? 'shadow-lg border-primary/40 bg-white rotate-1' : 'border-border bg-white hover:border-primary/30 hover:shadow-sm'}`}
                            >
                              <GripVertical size={13} className="text-text-tertiary/40 flex-shrink-0" />
                              <Avatar name={member.name} size="sm" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-text-primary truncate">{member.name}</p>
                                <p className="text-[10px] text-text-tertiary">
                                  {HIERARCHY_LABELS[member.hierarchyLevel] || member.role}
                                  {member.department ? ` · ${member.department}` : ''}
                                </p>
                              </div>
                              <Zap size={11} className="text-text-tertiary/30 flex-shrink-0" title="Drag to plan →" />
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                      {filteredAvailable.length === 0 && (
                        <div className="text-center py-12 text-text-tertiary">
                          {availableMembers.length === 0 ? (
                            <>
                              <UserCheck size={32} className="mx-auto mb-2 text-success/50" />
                              <p className="text-sm font-medium text-success">All members planned!</p>
                            </>
                          ) : (
                            <p className="text-sm">No members match search</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </Droppable>
              </div>

              {/* ── RIGHT: Selected Team ── */}
              <div className="flex flex-col overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex-shrink-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                      Your Team ({selectedMembers.length})
                    </span>
                    {selectedMembers.length > 0 && (
                      <button onClick={clearAll} className="text-xs text-text-tertiary hover:text-danger transition-colors">← Clear all</button>
                    )}
                  </div>
                  <p className="text-[11px] text-text-tertiary mt-0.5">Drag members here, then assign workspace & tasks</p>
                </div>

                <Droppable droppableId="selected">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`flex-1 overflow-y-auto p-3 space-y-1.5 transition-colors ${snapshot.isDraggingOver ? 'bg-primary/5 border-2 border-dashed border-primary/30 rounded-xl m-1' : ''}`}
                    >
                      {selectedMembers.map((member, i) => (
                        <SelectedMemberCard
                          key={member.id}
                          member={member}
                          workspaces={workspaces}
                          index={i}
                          onRefresh={loadData}
                        />
                      ))}
                      {provided.placeholder}
                      {selectedMembers.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full text-center text-text-tertiary py-12">
                          <div className="w-16 h-16 rounded-2xl bg-primary/5 flex items-center justify-center mb-3">
                            <Users size={28} className="text-primary/40" />
                          </div>
                          <p className="text-sm font-medium text-text-secondary">Drag members here</p>
                          <p className="text-xs mt-1">From the left panel to start planning</p>
                        </div>
                      )}
                    </div>
                  )}
                </Droppable>
              </div>
            </div>
          </DragDropContext>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-border bg-surface/30 flex-shrink-0">
          <p className="text-xs text-text-tertiary">
            {selectedMembers.length > 0
              ? `${selectedMembers.length} member${selectedMembers.length > 1 ? 's' : ''} selected — use action buttons to assign workspace & tasks`
              : 'Drag team members from the left to get started'}
          </p>
          <button onClick={onClose}
            className="px-4 py-2 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary-600 transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
