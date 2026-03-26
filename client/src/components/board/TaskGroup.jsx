import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { ChevronDown, ChevronRight, Plus, MoreHorizontal, Edit3, Check, X, Archive, Pencil, Trash2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { Droppable, Draggable } from 'react-beautiful-dnd';
import TaskRow from './TaskRow';
import AddColumnModal from './AddColumnModal';
import ColumnHeaderMenu from './ColumnHeaderMenu';
import ColumnInfoTooltip from './ColumnInfoTooltip';
import { STATUS_CONFIG } from '../../utils/constants';

export default function TaskGroup({
  group, tasks = [], members = [], columns = [], boardId,
  onTaskClick, onTaskUpdate, onAddTask, onArchiveTask,
  onRequestExtension, onRequestHelp, onEditColumn, onAddColumn, onRemoveColumn,
  onHideColumn, onResizeColumn, onSort, onArchiveGroup, onRenameGroup,
  onDuplicateColumn, onChangeColumnType, onFilter, onGroupBy, onSetColumnRequired, onSetColumnDescription, onReorderColumns,
  color = '#579bfc', index, isDragEnabled = false,
  selectedTaskIds = [], onSelectTask,
}) {
  const TASK_DISPLAY_LIMIT = 100;
  const { canManage } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const groupMenuRef = useRef(null);
  const [editingColId, setEditingColId] = useState(null);
  const [editingColTitle, setEditingColTitle] = useState('');
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [addAfterColId, setAddAfterColId] = useState(null);
  const [resizingCol, setResizingCol] = useState(null);
  const [dragColId, setDragColId] = useState(null);
  const [dragOverColId, setDragOverColId] = useState(null);
  const [taskColWidth, setTaskColWidth] = useState(() => {
    try { return parseInt(localStorage.getItem(`board_task_col_width_${boardId}`)) || 300; } catch { return 300; }
  });
  const addColBtnRef = useRef(null);

  // Task column resize handler (mouse + touch)
  const handleTaskColResize = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const isTouch = e.type === 'touchstart';
    const startX = isTouch ? e.touches[0].clientX : e.clientX;
    const startW = taskColWidth;
    setResizingCol('__task__');
    function onMove(ev) {
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const newW = Math.max(180, Math.min(500, startW + clientX - startX));
      setTaskColWidth(newW);
    }
    function onEnd() {
      setResizingCol(null);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(`board_task_col_width_${boardId}`, taskColWidth.toString());
    }
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener(isTouch ? 'touchmove' : 'mousemove', onMove, { passive: false });
    document.addEventListener(isTouch ? 'touchend' : 'mouseup', onEnd);
  }, [taskColWidth, boardId]);

  // Column resize handler (mouse + touch)
  const handleResizeStart = useCallback((e, col) => {
    e.preventDefault();
    e.stopPropagation();
    const isTouch = e.type === 'touchstart';
    const startX = isTouch ? e.touches[0].clientX : e.clientX;
    const startWidth = col.width || 140;
    setResizingCol(col.id);

    function onMove(ev) {
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const diff = clientX - startX;
      const newWidth = Math.max(80, Math.min(400, startWidth + diff));
      if (onResizeColumn) onResizeColumn(col.id, newWidth);
    }
    function onEnd() {
      setResizingCol(null);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener(isTouch ? 'touchmove' : 'mousemove', onMove, { passive: false });
    document.addEventListener(isTouch ? 'touchend' : 'mouseup', onEnd);
  }, [onResizeColumn]);

  const statusSummary = useMemo(() => {
    const counts = {};
    tasks.forEach(t => { const s = t.status || 'not_started'; counts[s] = (counts[s] || 0) + 1; });
    return Object.entries(counts).map(([status, count]) => ({
      status, count, color: STATUS_CONFIG[status]?.bgColor || '#c4c4c4',
      pct: tasks.length > 0 ? (count / tasks.length) * 100 : 0,
    }));
  }, [tasks]);

  function handleAddTask(e) {
    if (e.key === 'Enter' && newTaskTitle.trim()) { onAddTask(group.id, newTaskTitle.trim()); setNewTaskTitle(''); setAdding(false); }
    if (e.key === 'Escape') { setNewTaskTitle(''); setAdding(false); }
  }

  function startEditColumn(col) { setEditingColId(col.id); setEditingColTitle(col.title); }
  function saveColumnEdit() {
    if (editingColTitle.trim() && editingColId && onEditColumn) onEditColumn(editingColId, { title: editingColTitle.trim() });
    setEditingColId(null);
  }

  const visibleTasks = showAllTasks ? tasks : tasks.slice(0, TASK_DISPLAY_LIMIT);
  const hasMoreTasks = tasks.length > TASK_DISPLAY_LIMIT && !showAllTasks;

  const renderRows = (provided, snapshot) => (
    <div ref={provided?.innerRef} {...(provided?.droppableProps || {})}
      className={`min-h-[2px] ${snapshot?.isDraggingOver ? 'bg-[#e6f0ff]/30' : ''}`}>
      {visibleTasks.map((task, taskIndex) => {
        const rowContent = (dragHandleProps) => (
          <TaskRow task={task} members={members} columns={columns} boardId={boardId} color={color}
            taskColWidth={taskColWidth}
            onClick={() => onTaskClick(task)} onUpdate={(u) => onTaskUpdate(task.id, u)} onArchive={onArchiveTask}
            onRequestExtension={onRequestExtension} onRequestHelp={onRequestHelp}
            dragHandleProps={dragHandleProps} selected={selectedTaskIds.includes(task.id)}
            onSelect={(sel) => onSelectTask?.(task.id, sel)} />
        );
        if (isDragEnabled) {
          return (
            <Draggable key={task.id} draggableId={task.id} index={taskIndex}>
              {(dp, ds) => (
                <div ref={dp.innerRef} {...dp.draggableProps}
                  style={{ ...dp.draggableProps.style, ...(ds.isDragging ? { boxShadow: '0 4px 20px rgba(0,0,0,0.1)', background: 'white', zIndex: 10 } : {}) }}>
                  {rowContent(dp.dragHandleProps)}
                </div>
              )}
            </Draggable>
          );
        }
        return <React.Fragment key={task.id}>{rowContent(null)}</React.Fragment>;
      })}
      {provided?.placeholder}
      {hasMoreTasks && (
        <div className="flex items-center justify-center py-2 border-t border-[#e6e9ef]">
          <button onClick={() => setShowAllTasks(true)} className="text-[11px] font-medium text-[#0073ea] hover:underline">
            Show all {tasks.length} tasks ({tasks.length - TASK_DISPLAY_LIMIT} more hidden)
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="mb-8 group/group">
      {/* Group Header — Monday.com large colored text — sticky so it doesn't scroll */}
      <div className="flex items-center gap-2 mb-0.5 px-1 sticky left-0 z-[10] w-fit">
        <button onClick={() => setCollapsed(!collapsed)} className="p-0.5 hover:bg-gray-100 rounded transition-colors" style={{ color }}>
          {collapsed ? <ChevronRight size={20} /> : <ChevronDown size={20} />}
        </button>
        <h3 className="text-[18px] font-bold" style={{ color }}>{group.title || group.name}</h3>
        <span className="text-[13px] text-[#676879]">{tasks.length} items</span>
        <div className="relative ml-auto">
          <button onClick={e => { e.stopPropagation(); setShowGroupMenu(!showGroupMenu); }}
            className="p-1 rounded hover:bg-gray-100 text-[#c4c4c4] opacity-0 group-hover/group:opacity-100 transition-opacity">
            <MoreHorizontal size={16} />
          </button>
          {showGroupMenu && (
            <div ref={groupMenuRef} className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-[100] w-44"
              onMouseLeave={() => setShowGroupMenu(false)}>
              {onRenameGroup && (
                <button onClick={() => { setShowGroupMenu(false); const name = prompt('Rename group:', group.title || group.name); if (name) onRenameGroup(group.id, name); }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50 transition-colors">
                  <Pencil size={12} /> Rename Group
                </button>
              )}
              {canManage && onArchiveGroup && (
                <button onClick={() => { setShowGroupMenu(false); if (confirm(`Archive group "${group.title || group.name}"? Tasks will be archived.`)) onArchiveGroup(group.id); }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] text-orange-600 hover:bg-orange-50 transition-colors">
                  <Archive size={12} /> Archive Group
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="min-w-fit">
        {/* Table container — no individual scroll, parent BoardPage scrolls */}
        <div className="border border-[#e6e9ef] rounded-lg bg-white">
          <div>
            {/* Column Headers */}
            <div className="flex items-center border-b border-[#e6e9ef] text-[13px] font-medium text-[#676879] sticky top-0 bg-white z-[5]">
              {/* Sticky left: color bar + checkbox + task name */}
              <div className="flex items-center sticky left-0 z-[6] bg-white">
                <div className="w-[6px] flex-shrink-0 self-stretch" style={{ backgroundColor: color }} />
                <div className="w-10 flex-shrink-0 flex items-center justify-center py-2.5">
                  <input type="checkbox" className="w-4 h-4 rounded border-[#c4c4c4] text-[#0073ea] focus:ring-[#0073ea]/20 cursor-pointer" onClick={e => e.stopPropagation()} />
                </div>
                <div style={{ width: taskColWidth }} className=" flex-shrink-0 px-3 py-2.5 border-r border-[#e6e9ef] relative">
                  Task
                  {/* Task column resize handle (mouse + touch) */}
                  <div onMouseDown={handleTaskColResize} onTouchStart={handleTaskColResize}
                    className={`absolute right-0 top-0 bottom-0 w-[6px] md:w-[3px] cursor-col-resize z-[7] hover:bg-[#0073ea] transition-colors ${resizingCol === '__task__' ? 'bg-[#0073ea]' : 'bg-transparent'}`} />
                </div>
              </div>

              {/* Scrollable columns */}
              {columns.map(col => (
                <div key={col.id}
                  draggable
                  onDragStart={(e) => { setDragColId(col.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { e.preventDefault(); setDragOverColId(col.id); }}
                  onDragLeave={() => setDragOverColId(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragColId && dragColId !== col.id && onReorderColumns) {
                      onReorderColumns(dragColId, col.id);
                    }
                    setDragColId(null);
                    setDragOverColId(null);
                  }}
                  onDragEnd={() => { setDragColId(null); setDragOverColId(null); }}
                  className={`flex-shrink-0 py-2.5 px-2 border-r border-[#e6e9ef] group/col relative cursor-grab active:cursor-grabbing transition-all ${dragOverColId === col.id ? 'bg-[#e6f0ff] border-l-2 border-l-[#0073ea]' : ''} ${dragColId === col.id ? 'opacity-40' : ''}`}
                  style={{ width: col.width || 140 }}>
                  {editingColId === col.id ? (
                    <div className="flex items-center gap-1">
                      <input type="text" value={editingColTitle} onChange={e => setEditingColTitle(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveColumnEdit(); if (e.key === 'Escape') setEditingColId(null); }}
                        className="w-full text-xs bg-white border border-[#0073ea] rounded px-2 py-0.5 outline-none text-center" autoFocus />
                      <button onClick={saveColumnEdit} className="text-[#00c875]"><Check size={12} /></button>
                      <button onClick={() => setEditingColId(null)} className="text-[#e2445c]"><X size={12} /></button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-1">
                      <span className="truncate cursor-default" onDoubleClick={() => startEditColumn(col)}>
                        {col.title}
                        {col.required && <span className="text-[#e2445c] ml-0.5" title="Required">*</span>}
                      </span>
                      <ColumnInfoTooltip column={col} />
                      <ColumnHeaderMenu
                        column={col}
                        onRename={() => startEditColumn(col)}
                        onRemove={onRemoveColumn}
                        onHide={onHideColumn}
                        onSort={onSort}
                        onAddColumnRight={() => { setAddAfterColId(col.id); setShowAddColumn(true); }}
                        onDuplicate={onDuplicateColumn ? (c) => onDuplicateColumn(c) : undefined}
                        onChangeType={onChangeColumnType ? (colId, type) => onChangeColumnType(colId, type) : undefined}
                        onFilter={onFilter ? (c) => onFilter(c) : undefined}
                        onCollapse={onHideColumn ? (c) => onHideColumn(c.id) : undefined}
                        onGroupBy={onGroupBy ? (c) => onGroupBy(c) : undefined}
                        onSetRequired={onSetColumnRequired}
                        onSetDescription={onSetColumnDescription}
                      />
                    </div>
                  )}
                  {/* Resize handle — Monday.com blue line on drag (mouse + touch) */}
                  <div
                    onMouseDown={(e) => handleResizeStart(e, col)}
                    onTouchStart={(e) => handleResizeStart(e, col)}
                    className={`absolute right-0 top-0 bottom-0 w-[6px] md:w-[3px] cursor-col-resize z-[7] group/resize hover:bg-[#0073ea] transition-colors ${resizingCol === col.id ? 'bg-[#0073ea]' : 'bg-transparent'}`}
                    title="Resize Column"
                  >
                    <div className={`absolute right-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full transition-colors ${resizingCol === col.id ? 'bg-[#0073ea]' : 'bg-transparent group-hover/resize:bg-[#0073ea]'}`} />
                  </div>
                </div>
              ))}

              {/* + Add column */}
              <div className="w-[50px] flex-shrink-0 flex items-center justify-center">
                <button ref={addColBtnRef} onClick={() => setShowAddColumn(!showAddColumn)}
                  className="p-1.5 rounded hover:bg-gray-100 text-[#c4c4c4] hover:text-[#0073ea] transition-colors">
                  <Plus size={14} />
                </button>
                {showAddColumn && (
                  <AddColumnModal anchorRef={addColBtnRef} onAdd={col => { onAddColumn?.(col, addAfterColId); setShowAddColumn(false); setAddAfterColId(null); }} onClose={() => { setShowAddColumn(false); setAddAfterColId(null); }} />
                )}
              </div>
            </div>

            {/* Task Rows */}
            {isDragEnabled ? (
              <Droppable droppableId={group.id} type="TASK">
                {(provided, snapshot) => renderRows(provided, snapshot)}
              </Droppable>
            ) : renderRows()}

            {/* + Add task */}
            <div className="flex items-center border-t border-[#e6e9ef]">
              <div className="flex items-center sticky left-0 bg-white">
                <div className="w-[6px] flex-shrink-0 self-stretch" style={{ backgroundColor: color, opacity: 0.3 }} />
                <div className="w-10 flex-shrink-0" />
                {adding ? (
                  <div style={{ width: taskColWidth }} className=" px-3 py-2">
                    <input type="text" value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)} onKeyDown={handleAddTask}
                      onBlur={() => { if (!newTaskTitle) setAdding(false); }}
                      placeholder="+ Add task" className="w-full text-[14px] border-none outline-none bg-transparent text-[#323338] placeholder:text-[#c4c4c4]" autoFocus />
                  </div>
                ) : (
                  <button onClick={() => setAdding(true)} style={{ width: taskColWidth }} className=" flex items-center gap-1.5 px-3 py-2.5 text-[14px] text-[#c4c4c4] hover:text-[#0073ea] transition-colors">
                    <Plus size={14} /> Add task
                  </button>
                )}
              </div>
            </div>

          </div>
        </div>

        {/* Summary Bar — Monday.com style: border starts under Status column */}
        {(() => {
          // Find where the first status column is — summary border starts there
          const statusIdx = columns.findIndex(c => c.type === 'status');
          const splitAt = statusIdx >= 0 ? statusIdx : 0;
          const leftCols = columns.slice(0, splitAt);  // columns before Status (spacers)
          const rightCols = columns.slice(splitAt);     // columns from Status onward (bordered)
          return (
        <div className="flex items-center relative">
          {/* Empty left area: columns before Status — no border */}
          <div className="flex items-center sticky left-0 z-[2]">
            <div className="w-[6px] flex-shrink-0" />
            <div className="w-10 flex-shrink-0" />
            <div style={{ width: taskColWidth }} />
            {leftCols.map(col => (
              <div key={col.id} className="flex-shrink-0" style={{ width: col.width || 140 }} />
            ))}
          </div>
          {/* Data columns summary — border starts here (under Status) */}
          <div className="flex items-center border-t border-b border-r border-[#e6e9ef] rounded-b-lg" style={{ borderLeft: `3px solid ${color}` }}>
            {rightCols.map(col => {
              const cellWidth = col.width || 140;
              return (
                <div key={col.id} className="flex-shrink-0 py-[6px] px-[4px] flex items-center justify-center" style={{ width: cellWidth }}>
                  {col.type === 'status' && tasks.length > 0 ? (
                    <div className="flex h-[24px] w-full rounded-[4px] overflow-hidden bg-[#c4c4c4]">
                      {statusSummary.map((s, i) => (
                        <div key={i} className="h-full transition-all" style={{ width: `${s.pct}%`, backgroundColor: s.color }} title={`${STATUS_CONFIG[s.status]?.label}: ${s.count}`} />
                      ))}
                    </div>
                  ) : col.type === 'priority' && tasks.length > 0 ? (
                    <div className="flex h-[24px] w-full rounded-[4px] overflow-hidden bg-[#c4c4c4]">
                      {Object.entries(tasks.reduce((a, t) => { a[t.priority || 'medium'] = (a[t.priority || 'medium'] || 0) + 1; return a; }, {})).map(([p, c], i) => {
                        const cls = { low: '#579bfc', medium: '#fdab3d', high: '#e2445c', critical: '#333' };
                        return <div key={i} className="h-full transition-all" style={{ width: `${(c / tasks.length) * 100}%`, backgroundColor: cls[p] || '#c4c4c4' }} />;
                      })}
                    </div>
                  ) : col.type === 'date' ? (
                    <div className="h-[24px] w-full rounded-[4px] bg-[#cce5ff] flex items-center justify-center">
                      <span className="text-[11px] text-[#676879]">
                        {(() => {
                          const dates = tasks.filter(t => t.dueDate).map(t => new Date(t.dueDate));
                          if (dates.length === 0) return '—';
                          const min = new Date(Math.min(...dates));
                          const max = new Date(Math.max(...dates));
                          return `${min.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${max.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
                        })()}
                      </span>
                    </div>
                  ) : (
                    <div className="h-[24px] w-full rounded-[4px] bg-[#f5f6f8] flex items-center justify-center">
                      <span className="text-[11px] text-[#c3c6d4]">—</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
          );
        })()}
        </div>
      )}
    </div>
  );
}
