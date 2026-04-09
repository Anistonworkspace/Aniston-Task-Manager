import React, { useState, useCallback } from 'react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { MessageSquare, ListChecks, Clock, Plus, ChevronDown, ChevronRight, AlertTriangle, Zap, Link2, ChevronsDown } from 'lucide-react';
import { format, parseISO, isPast } from 'date-fns';
import { STATUS_CONFIG, PRIORITY_CONFIG, DEFAULT_STATUSES } from '../../utils/constants';
import Avatar from '../common/Avatar';

const FALLBACK_KANBAN_COLUMNS = [
  { id: 'not_started', label: 'Not Started', color: '#c4c4c4', emoji: '' },
  { id: 'working_on_it', label: 'Working on it', color: '#fdab3d', emoji: '' },
  { id: 'stuck', label: 'Stuck', color: '#e2445c', emoji: '' },
  { id: 'done', label: 'Done', color: '#00c875', emoji: '' },
];

const PRIORITY_BORDER = { critical: '#e2445c', high: '#ff642e', medium: '#fdab3d', low: '#579bfc' };

export default function KanbanView({ tasks = [], members = [], onTaskClick, onTaskUpdate, onAddTask, groups, boardStatuses }) {
  const INITIAL_CARD_LIMIT = 50;
  const baseColumns = boardStatuses && boardStatuses.length > 0
    ? boardStatuses.map(s => ({ id: s.key, label: s.label, color: s.color, emoji: '' }))
    : FALLBACK_KANBAN_COLUMNS;

  // Collect any task-level custom status keys not already in board columns
  const baseIds = new Set(baseColumns.map(c => c.id));
  const extraColumns = [];
  tasks.forEach(t => {
    if (t.status && !baseIds.has(t.status)) {
      baseIds.add(t.status);
      // Try to find label/color from the task's own statusConfig
      const taskCfg = t.statusConfig && Array.isArray(t.statusConfig)
        ? t.statusConfig.find(s => s.key === t.status)
        : null;
      extraColumns.push({
        id: t.status,
        label: taskCfg?.label || t.status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        color: taskCfg?.color || '#94a3b8',
        emoji: '',
      });
    }
  });
  const KANBAN_COLUMNS = [...baseColumns, ...extraColumns];
  const [collapsedCols, setCollapsedCols] = useState({});
  const [filterPerson, setFilterPerson] = useState('');
  const [newTaskCol, setNewTaskCol] = useState(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [expandedCols, setExpandedCols] = useState({});

  const toggleShowAll = useCallback((colId) => {
    setExpandedCols(prev => ({ ...prev, [colId]: !prev[colId] }));
  }, []);

  function handleDragEnd(result) {
    const { draggableId, destination } = result;
    if (!destination) return;
    const newStatus = destination.droppableId;
    const task = tasks.find(t => t.id === draggableId);
    if (!task || task.status === newStatus) return;
    onTaskUpdate(draggableId, { status: newStatus });
  }

  function toggleCollapse(colId) {
    setCollapsedCols(prev => ({ ...prev, [colId]: !prev[colId] }));
  }

  function handleAddTaskSubmit(colId) {
    if (!newTaskTitle.trim()) { setNewTaskCol(null); return; }
    // Find first group to add the task
    const groupId = groups?.[0]?.id || 'new';
    if (onAddTask) onAddTask(groupId, newTaskTitle.trim());
    // Update the new task's status to match the column
    // The task gets created with default status, we need to update it
    // For now, just create in the first group — the status will be set by the board's default
    setNewTaskTitle('');
    setNewTaskCol(null);
  }

  const filteredTasks = filterPerson
    ? tasks.filter(t => (t.assignedTo || t.assignee?.id) === filterPerson)
    : tasks;

  // Get unique assignees for filter
  const assignees = [];
  const seen = new Set();
  tasks.forEach(t => {
    const a = t.assignee || (t.assignedTo ? members.find(m => m.id === t.assignedTo) : null);
    const id = a?.id || t.assignedTo;
    if (id && !seen.has(id)) {
      seen.add(id);
      assignees.push({ id, name: a?.name || a?.user?.name || 'Unknown' });
    }
  });

  return (
    <div>
      {/* Assignee filter bar */}
      {assignees.length > 1 && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-text-tertiary font-medium">Filter:</span>
          <button onClick={() => setFilterPerson('')}
            className={`px-2 py-1 text-[10px] font-medium rounded-full transition-colors ${!filterPerson ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-surface-dark'}`}>
            All
          </button>
          {assignees.map(a => (
            <button key={a.id} onClick={() => setFilterPerson(filterPerson === a.id ? '' : a.id)}
              className={`flex items-center gap-1 px-2 py-1 rounded-full transition-colors ${filterPerson === a.id ? 'bg-primary text-white' : 'bg-surface hover:bg-surface-dark'}`}>
              <Avatar name={a.name} size="xs" />
              <span className="text-[10px] font-medium">{a.name.split(' ')[0]}</span>
            </button>
          ))}
        </div>
      )}

      {/* Kanban board */}
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex gap-4 overflow-x-auto pb-4 min-h-[500px]">
          {KANBAN_COLUMNS.map(col => {
            const colTasks = filteredTasks.filter(t => t.status === col.id);
            const isCollapsed = collapsedCols[col.id];

            return (
              <div key={col.id} className={`flex-shrink-0 flex flex-col transition-all ${isCollapsed ? 'w-[48px]' : 'w-[290px]'}`}>
                {/* Column Header */}
                <div className={`flex items-center gap-2 mb-3 rounded-lg px-3 py-2.5 cursor-pointer select-none transition-colors hover:opacity-90`}
                  style={{ backgroundColor: `${col.color}18` }}
                  onClick={() => isCollapsed && toggleCollapse(col.id)}>
                  <button onClick={(e) => { e.stopPropagation(); toggleCollapse(col.id); }} className="text-text-secondary">
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {!isCollapsed && (
                    <>
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: col.color }} />
                      <h3 className="text-sm font-bold" style={{ color: col.color }}>{col.label}</h3>
                      <span className="text-xs font-bold ml-auto px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: col.color }}>
                        {colTasks.length}
                      </span>
                    </>
                  )}
                  {isCollapsed && (
                    <div className="flex flex-col items-center gap-1">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: col.color }} />
                      <span className="text-[9px] font-bold" style={{ color: col.color, writingMode: 'vertical-lr' }}>{col.label}</span>
                      <span className="text-[10px] font-bold mt-1 px-1.5 py-0.5 rounded-full text-white" style={{ backgroundColor: col.color }}>{colTasks.length}</span>
                    </div>
                  )}
                </div>

                {/* Column Body */}
                {!isCollapsed && (
                  <Droppable droppableId={col.id} type="KANBAN">
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                        className={`flex-1 rounded-xl p-2 space-y-2 transition-all min-h-[120px] ${
                          snapshot.isDraggingOver
                            ? 'bg-primary/5 border-2 border-dashed border-primary/30 shadow-inner'
                            : 'bg-surface/30 border-2 border-transparent'
                        }`}
                      >
                        {(expandedCols[col.id] ? colTasks : colTasks.slice(0, INITIAL_CARD_LIMIT)).map((task, index) => {
                          const priorityCfg = PRIORITY_CONFIG[task.priority] || {};
                          const assignee = task.assignee || (task.assignedTo ? members.find(m => m.id === task.assignedTo) : null);
                          const assigneeName = assignee?.name || assignee?.user?.name;
                          const subtaskTotal = task.subtaskTotal || 0;
                          const subtaskDone = task.subtaskDone || 0;
                          const isOverdue = task.dueDate && isPast(parseISO(task.dueDate)) && task.status !== 'done';
                          const priBorderColor = PRIORITY_BORDER[task.priority] || '#c4c4c4';

                          return (
                            <Draggable key={task.id} draggableId={task.id} index={index}>
                              {(provided, snapshot) => (
                                <div
                                  ref={provided.innerRef}
                                  {...provided.draggableProps}
                                  {...provided.dragHandleProps}
                                  onClick={() => onTaskClick(task)}
                                  className={`bg-white rounded-lg border border-border overflow-hidden cursor-pointer transition-all group ${
                                    snapshot.isDragging
                                      ? 'shadow-xl ring-2 ring-primary/30 rotate-[2deg] scale-105'
                                      : 'hover:shadow-md hover:-translate-y-0.5'
                                  }`}
                                >
                                  {/* Priority color stripe */}
                                  <div className="h-[3px]" style={{ backgroundColor: priBorderColor }} />

                                  <div className="p-3">
                                    {/* Title + badges */}
                                    <div className="flex items-start gap-1.5 mb-2">
                                      <p className="text-[13px] font-medium text-text-primary line-clamp-2 flex-1 leading-snug">{task.title}</p>
                                      {task.autoAssigned && <Zap size={11} className="text-purple flex-shrink-0 mt-0.5" />}
                                    </div>

                                    {/* Overdue warning */}
                                    {isOverdue && (
                                      <div className="flex items-center gap-1 text-[10px] text-danger font-semibold mb-2 bg-danger/5 px-2 py-1 rounded">
                                        <AlertTriangle size={10} /> Overdue — {format(parseISO(task.dueDate), 'MMM d')}
                                      </div>
                                    )}

                                    {/* Meta chips */}
                                    <div className="flex items-center gap-1.5 flex-wrap mb-2.5">
                                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md"
                                        style={{ backgroundColor: `${priorityCfg.color || '#c4c4c4'}12`, color: priorityCfg.color || '#999', border: `1px solid ${priorityCfg.color || '#c4c4c4'}25` }}>
                                        {priorityCfg.label || task.priority}
                                      </span>

                                      {task.dueDate && !isOverdue && (
                                        <span className="text-[10px] text-text-tertiary flex items-center gap-0.5 bg-surface px-1.5 py-0.5 rounded-md">
                                          <Clock size={9} /> {format(parseISO(task.dueDate), 'MMM d')}
                                        </span>
                                      )}

                                      {subtaskTotal > 0 && (
                                        <span className={`text-[10px] flex items-center gap-0.5 px-1.5 py-0.5 rounded-md ${subtaskDone === subtaskTotal ? 'bg-success/10 text-success' : 'bg-surface text-text-tertiary'}`}>
                                          <ListChecks size={10} /> {subtaskDone}/{subtaskTotal}
                                        </span>
                                      )}
                                    </div>

                                    {/* Footer */}
                                    <div className="flex items-center justify-between pt-2 border-t border-border/40">
                                      {assigneeName ? (
                                        <div className="flex items-center gap-1.5">
                                          <Avatar name={assigneeName} size="xs" />
                                          <span className="text-[10px] text-text-secondary font-medium">{assigneeName.split(' ')[0]}</span>
                                        </div>
                                      ) : (
                                        <span className="text-[10px] text-text-tertiary italic">Unassigned</span>
                                      )}
                                      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <MessageSquare size={11} className="text-text-tertiary" />
                                        <Link2 size={11} className="text-text-tertiary" />
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </Draggable>
                          );
                        })}
                        {provided.placeholder}

                        {/* Show all button when cards exceed limit */}
                        {!expandedCols[col.id] && colTasks.length > INITIAL_CARD_LIMIT && (
                          <button
                            onClick={() => toggleShowAll(col.id)}
                            className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium text-primary hover:bg-primary/5 rounded-lg transition-colors"
                          >
                            <ChevronsDown size={12} />
                            Show all {colTasks.length} tasks ({colTasks.length - INITIAL_CARD_LIMIT} more)
                          </button>
                        )}
                        {expandedCols[col.id] && colTasks.length > INITIAL_CARD_LIMIT && (
                          <button
                            onClick={() => toggleShowAll(col.id)}
                            className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium text-text-tertiary hover:bg-surface rounded-lg transition-colors"
                          >
                            Show less
                          </button>
                        )}

                        {/* Empty state */}
                        {colTasks.length === 0 && !snapshot.isDraggingOver && (
                          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
                            <div className="w-10 h-10 rounded-full bg-surface flex items-center justify-center mb-2">
                              <div className="w-4 h-4 rounded-full border-2 border-dashed" style={{ borderColor: col.color }} />
                            </div>
                            <p className="text-xs">No tasks</p>
                            <p className="text-[10px] mt-0.5">Drag here or add below</p>
                          </div>
                        )}

                        {/* Add task button */}
                        {newTaskCol === col.id ? (
                          <div className="mt-1">
                            <input
                              type="text"
                              value={newTaskTitle}
                              onChange={e => setNewTaskTitle(e.target.value)}
                              onKeyDown={e => { if (e.key === 'Enter') handleAddTaskSubmit(col.id); if (e.key === 'Escape') { setNewTaskCol(null); setNewTaskTitle(''); } }}
                              onBlur={() => handleAddTaskSubmit(col.id)}
                              autoFocus
                              placeholder="Task name..."
                              className="w-full px-3 py-2 text-sm border border-primary/30 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 bg-white"
                            />
                          </div>
                        ) : (
                          <button onClick={() => { setNewTaskCol(col.id); setNewTaskTitle(''); }}
                            className="flex items-center gap-1.5 w-full px-3 py-2 mt-1 text-xs text-text-tertiary hover:text-primary hover:bg-white rounded-lg transition-colors">
                            <Plus size={13} /> Add task
                          </button>
                        )}
                      </div>
                    )}
                  </Droppable>
                )}
              </div>
            );
          })}
        </div>
      </DragDropContext>
    </div>
  );
}
