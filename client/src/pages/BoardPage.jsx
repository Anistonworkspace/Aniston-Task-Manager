import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Search, Filter, SortAsc, BarChart3, Plus, Columns3, Calendar, Settings,
  LayoutGrid, Zap, Download, Upload, Eye, EyeOff, Archive, ChevronDown, GanttChart, MoreHorizontal
} from 'lucide-react';
import { DragDropContext } from '@hello-pangea/dnd';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useUndo } from '../context/UndoContext';
import useSocket from '../hooks/useSocket';
import { joinBoard, leaveBoard } from '../services/socket';
import { DEFAULT_COLUMNS, getBoardStatuses } from '../utils/constants';
import TaskGroup from '../components/board/TaskGroup';
import TaskModal from '../components/task/TaskModal';
import BoardSettingsModal from '../components/board/BoardSettingsModal';
import AdvancedFilters from '../components/board/AdvancedFilters';
import KanbanView from '../components/board/KanbanView';
import AutomationsPanel from '../components/board/AutomationsPanel';
import BulkActionBar from '../components/board/BulkActionBar';
import CalendarView from '../components/board/CalendarView';
import SortDropdown from '../components/board/SortDropdown';
import CSVImportModal from '../components/board/CSVImportModal';
import DueDateExtensionModal from '../components/board/DueDateExtensionModal';
import HelpRequestModal from '../components/board/HelpRequestModal';
import TimelineView from '../components/board/TimelineView';
import { SkeletonBoard } from '../components/common/Skeleton';
import { useToast } from '../components/common/Toast';
import { canUser as canUserFn } from '../utils/permissions';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

// Monday.com-style dropdown for "New task" split button
function NewTaskDropdown({ onNewGroup, onImport, onClose }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div ref={ref} className="absolute left-0 top-full mt-1 w-[200px] bg-white rounded-lg shadow-dropdown border border-[#e6e9ef] z-50 dropdown-enter overflow-hidden py-1">
      <button onClick={onNewGroup}
        className="w-full flex items-center gap-2.5 px-4 py-[8px] text-[13px] text-[#323338] hover:bg-[#f5f6f8] transition-colors">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="2" rx="0.5" fill="#676879"/><rect x="2" y="7" width="12" height="2" rx="0.5" fill="#676879"/><rect x="2" y="11" width="12" height="2" rx="0.5" fill="#676879"/></svg>
        New group of tasks
      </button>
      <button onClick={onImport}
        className="w-full flex items-center gap-2.5 px-4 py-[8px] text-[13px] text-[#323338] hover:bg-[#f5f6f8] transition-colors">
        <Download size={15} className="text-[#676879]" />
        Import tasks
      </button>
    </div>
  );
}

export default function BoardPage() {
  const { id: boardId } = useParams();
  const navigate = useNavigate();
  const { user, canManage, isSuperAdmin, permissionGrants, effectivePermissions } = useAuth();
  const canCreateTask = canUserFn(user?.role, 'create_task', isSuperAdmin, permissionGrants, effectivePermissions);
  const canEditBoard = canUserFn(user?.role, 'edit_board', isSuperAdmin, permissionGrants, effectivePermissions);
  const { pushAction } = useUndo();
  const { error: toastError, success: toastSuccess } = useToast();
  const [board, setBoard] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState(null);
  const [viewTab, setViewTab] = useState('table');
  const [searchQuery, setSearchQuery] = useState('');
  const [advFilters, setAdvFilters] = useState({ status: [], priority: [], person: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAutomations, setShowAutomations] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);
  const [sortConfig, setSortConfig] = useState(null);
  const [showCSVImport, setShowCSVImport] = useState(false);
  const [extensionTask, setExtensionTask] = useState(null);
  const [helpTask, setHelpTask] = useState(null);
  const [showNewTaskMenu, setShowNewTaskMenu] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState(() => {
    return JSON.parse(localStorage.getItem(`board_hidden_cols_${boardId}`) || '[]');
  });
  const [showHideColumns, setShowHideColumns] = useState(false);

  // Board columns — merge default + custom
  const allColumns = useMemo(() => {
    const boardCustomCols = board?.customColumns || [];
    const baseCols = [...DEFAULT_COLUMNS];
    // Add progress & label columns by default
    if (!baseCols.find(c => c.id === 'progress')) {
      baseCols.push({ id: 'progress', title: 'Progress', type: 'progress', width: 130 });
    }
    if (!baseCols.find(c => c.id === 'label')) {
      baseCols.push({ id: 'label', title: 'Labels', type: 'label', width: 120 });
    }
    return [...baseCols, ...boardCustomCols];
  }, [board?.customColumns]);

  // Visible columns (exclude hidden, apply saved widths + order)
  const visibleColumns = useMemo(() => {
    const widths = JSON.parse(localStorage.getItem(`board_col_widths_${boardId}`) || '{}');
    const savedOrder = JSON.parse(localStorage.getItem(`board_col_order_${boardId}`) || '[]');
    let cols = allColumns
      .filter(col => !hiddenColumns.includes(col.id))
      .map(col => ({ ...col, width: widths[col.id] || col.width }));
    // Apply saved column order if available
    if (savedOrder.length > 0) {
      cols.sort((a, b) => {
        const ai = savedOrder.indexOf(a.id);
        const bi = savedOrder.indexOf(b.id);
        // Columns not in savedOrder go to the end
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
    }
    return cols;
  }, [allColumns, hiddenColumns, board?._resizeTick, board?._reorderTick, boardId]);

  // Persist hidden columns
  useEffect(() => {
    localStorage.setItem(`board_hidden_cols_${boardId}`, JSON.stringify(hiddenColumns));
  }, [hiddenColumns, boardId]);

  const loadBoard = useCallback(async () => {
    try {
      const [boardRes, usersRes] = await Promise.all([
        api.get(`/boards/${boardId}`),
        api.get('/auth/assignable-users'),
      ]);
      const data = boardRes.data.board || boardRes.data;
      setBoard(data);
      const allUsers = usersRes.data.users || usersRes.data || [];
      setMembers(allUsers.length > 0 ? allUsers : data.members || data.Users || []);
    } catch (err) {
      console.error('[BoardPage] loadBoard error:', err);
      // If access denied (403), redirect to home instead of showing broken board
      if (err?.response?.status === 403) {
        toastError('You do not have access to this board.');
        navigate('/');
        return;
      }
      toastError('Failed to load board. Please refresh the page.');
    }
  }, [boardId, navigate]);

  const loadTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('boardId', boardId);
      if (advFilters.person) params.set('assignedTo', advFilters.person);
      if (searchQuery) params.set('search', searchQuery);
      const res = await api.get(`/tasks?${params.toString()}`);
      let fetched = res.data.tasks || res.data || [];
      if (advFilters.status.length > 0) {
        fetched = fetched.filter(t => advFilters.status.includes(t.status));
      }
      if (advFilters.priority.length > 0) {
        fetched = fetched.filter(t => advFilters.priority.includes(t.priority));
      }
      // Filter out archived tasks
      fetched = fetched.filter(t => !t.isArchived);
      setTasks(fetched);
    } catch (err) {
      console.error('[BoardPage] loadTasks error:', err);
      toastError('Failed to load tasks. Please refresh the page.');
    } finally {
      setLoading(false);
    }
  }, [boardId, advFilters, searchQuery]);

  useEffect(() => { loadBoard(); }, [loadBoard]);
  useEffect(() => { loadTasks(); }, [loadTasks]);

  useEffect(() => {
    if (boardId) joinBoard(boardId);
    return () => { if (boardId) leaveBoard(boardId); };
  }, [boardId]);

  useSocket('task:created', (data) => { if (data?.task?.boardId === boardId) loadTasks(); });
  useSocket('task:updated', (data) => {
    if (data?.task?.boardId === boardId) {
      setTasks(prev => prev.map(t => t.id === data.task.id ? { ...t, ...data.task } : t));
    }
  });
  useSocket('task:deleted', (data) => { if (data?.taskId) setTasks(prev => prev.filter(t => t.id !== data.taskId)); });
  useSocket('tasks:reordered', () => loadTasks());
  useSocket('board:updated', (data) => { if (data?.board?.id === boardId) setBoard(data.board); });

  async function handleAddTask(groupId, title) {
    try {
      const res = await api.post('/tasks', {
        title, boardId, groupId,
        status: 'not_started', priority: 'medium',
        position: tasks.filter(t => t.groupId === groupId).length,
      });
      const newTask = res.data.task || res.data;
      setTasks(prev => [...prev, newTask]);
      pushAction({
        description: `Added task "${title}"`,
        undo: async () => {
          await api.put(`/tasks/${newTask.id}`, { isArchived: true });
          setTasks(prev => prev.filter(t => t.id !== newTask.id));
        },
        redo: async () => {
          await api.put(`/tasks/${newTask.id}`, { isArchived: false });
          loadTasks();
        },
      });
    } catch (err) {
      console.error('[BoardPage] handleAddTask error:', err);
      toastError('Failed to add task. Please try again.');
    }
  }

  async function handleTaskUpdate(taskId, updates) {
    const oldTask = tasks.find(t => t.id === taskId);
    try {
      const res = await api.put(`/tasks/${taskId}`, updates);
      // Use the full task from server response to get correct assignedTo/taskAssignees
      const serverTask = res.data?.task || res.data?.data?.task;
      const mergeData = serverTask || updates;
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...mergeData } : t));
      if (selectedTask?.id === taskId) setSelectedTask(prev => ({ ...prev, ...mergeData }));

      // Push to undo stack
      if (oldTask) {
        const oldValues = {};
        Object.keys(updates).forEach(k => { oldValues[k] = oldTask[k]; });
        pushAction({
          description: `Updated task "${oldTask.title}"`,
          undo: async () => {
            await api.put(`/tasks/${taskId}`, oldValues);
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...oldValues } : t));
          },
          redo: async () => {
            await api.put(`/tasks/${taskId}`, updates);
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...updates } : t));
          },
        });
      }
    } catch (err) {
      console.error('[BoardPage] handleTaskUpdate error:', err);
      toastError('Failed to update task. Please try again.');
    }
  }

  async function handleArchiveTask(taskId) {
    const oldTask = tasks.find(t => t.id === taskId);
    try {
      await api.put(`/tasks/${taskId}`, { isArchived: true });
      setTasks(prev => prev.filter(t => t.id !== taskId));
      pushAction({
        description: `Archived "${oldTask?.title || 'task'}"`,
        undo: async () => {
          await api.put(`/tasks/${taskId}`, { isArchived: false });
          loadTasks();
        },
        redo: async () => {
          await api.put(`/tasks/${taskId}`, { isArchived: true });
          setTasks(prev => prev.filter(t => t.id !== taskId));
        },
      });
    } catch (err) {
      console.error('[BoardPage] handleArchiveTask error:', err);
      toastError('Failed to archive task. Please try again.');
    }
  }

  function handleTaskDelete(taskId) {
    // NO DELETE — archive instead
    handleArchiveTask(taskId);
  }

  async function handleArchiveGroup(groupId) {
    try {
      // Archive all tasks in this group
      const groupTasks = tasks.filter(t => t.groupId === groupId);
      await Promise.all(groupTasks.map(t => api.put(`/tasks/${t.id}`, { isArchived: true })));

      // Move group from groups → archivedGroups (preserve group info)
      const archivedGroup = groups.find(g => g.id === groupId);
      const updatedGroups = groups.filter(g => g.id !== groupId);
      const currentArchivedGroups = board?.archivedGroups || [];
      const updatedArchivedGroups = [...currentArchivedGroups, { ...archivedGroup, archivedAt: new Date().toISOString(), taskCount: groupTasks.length }];

      await api.put(`/boards/${boardId}`, { groups: updatedGroups, archivedGroups: updatedArchivedGroups });
      setGroups(updatedGroups);
      setBoard(prev => ({ ...prev, archivedGroups: updatedArchivedGroups }));
      setTasks(prev => prev.filter(t => t.groupId !== groupId));
    } catch (err) {
      console.error('[BoardPage] handleArchiveGroup error:', err);
      toastError('Failed to archive group. Please try again.');
    }
  }

  async function handleRenameGroup(groupId, newName) {
    try {
      const updatedGroups = groups.map(g => g.id === groupId ? { ...g, title: newName, name: newName } : g);
      await api.put(`/boards/${boardId}`, { groups: updatedGroups });
      setGroups(updatedGroups);
    } catch (err) {
      console.error('[BoardPage] handleRenameGroup error:', err);
      toastError('Failed to rename group. Please try again.');
    }
  }

  function handleSelectTask(taskId, selected) {
    setSelectedTaskIds(prev =>
      selected ? [...prev, taskId] : prev.filter(id => id !== taskId)
    );
  }

  // Column management
  function handleEditColumn(colId, updates) {
    const cols = [...(board?.customColumns || [])];
    // Check if it's a custom column
    const idx = cols.findIndex(c => c.id === colId);
    if (idx >= 0) {
      cols[idx] = { ...cols[idx], ...updates };
      setBoard(prev => ({ ...prev, customColumns: cols }));
      api.put(`/boards/${boardId}`, { customColumns: cols }).catch(console.error);
    }
    // For default columns, we save title overrides in localStorage
    const overrides = JSON.parse(localStorage.getItem(`board_col_titles_${boardId}`) || '{}');
    overrides[colId] = updates.title;
    localStorage.setItem(`board_col_titles_${boardId}`, JSON.stringify(overrides));
  }

  function handleAddColumn(col, afterColumnId) {
    const cols = [...(board?.customColumns || [])];
    if (afterColumnId) {
      const idx = cols.findIndex(c => c.id === afterColumnId);
      cols.splice(idx >= 0 ? idx + 1 : cols.length, 0, col);
    } else {
      cols.push(col);
    }
    setBoard(prev => ({ ...prev, customColumns: cols }));
    api.put(`/boards/${boardId}`, { customColumns: cols }).catch(err => {
      console.error('Failed to save column:', err);
    });
  }

  function handleRemoveColumn(colId) {
    const cols = (board?.customColumns || []).filter(c => c.id !== colId);
    setBoard(prev => ({ ...prev, customColumns: cols }));
    api.put(`/boards/${boardId}`, { customColumns: cols }).catch(console.error);
  }

  // Duplicate column
  function handleDuplicateColumn(column) {
    const newCol = {
      id: `custom_${Date.now()}`,
      title: `${column.title} (copy)`,
      type: column.type || 'text',
      width: column.width || 130,
    };
    const cols = [...(board?.customColumns || [])];
    const idx = cols.findIndex(c => c.id === column.id);
    if (idx >= 0) {
      // Custom column — insert right after it
      cols.splice(idx + 1, 0, newCol);
    } else {
      // Built-in column — append to custom columns (will appear after built-ins)
      cols.push(newCol);
    }
    setBoard(prev => ({ ...prev, customColumns: cols }));
    api.put(`/boards/${boardId}`, { customColumns: cols }).catch(console.error);
  }

  // Set column as required
  function handleSetColumnRequired(colId) {
    const cols = (board?.customColumns || []).map(c =>
      c.id === colId ? { ...c, required: !c.required } : c
    );
    setBoard(prev => ({ ...prev, customColumns: cols }));
    api.put(`/boards/${boardId}`, { customColumns: cols }).catch(console.error);
  }

  // Set column description
  function handleSetColumnDescription(colId, description) {
    const cols = (board?.customColumns || []).map(c =>
      c.id === colId ? { ...c, description } : c
    );
    setBoard(prev => ({ ...prev, customColumns: cols }));
    api.put(`/boards/${boardId}`, { customColumns: cols }).catch(console.error);
  }

  // Reorder columns via drag-and-drop
  function handleReorderColumns(draggedColId, targetColId) {
    // Save column order to localStorage (works for both built-in and custom)
    const currentOrder = visibleColumns.map(c => c.id);
    const fromIdx = currentOrder.indexOf(draggedColId);
    const toIdx = currentOrder.indexOf(targetColId);
    if (fromIdx < 0 || toIdx < 0) return;
    const newOrder = [...currentOrder];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, draggedColId);
    localStorage.setItem(`board_col_order_${boardId}`, JSON.stringify(newOrder));
    setBoard(prev => ({ ...prev, _reorderTick: Date.now() })); // trigger re-render
  }

  // Change column type
  function handleChangeColumnType(colId, newType) {
    const cols = (board?.customColumns || []).map(c =>
      c.id === colId ? { ...c, type: newType } : c
    );
    setBoard(prev => ({ ...prev, customColumns: cols }));
    api.put(`/boards/${boardId}`, { customColumns: cols }).catch(console.error);
  }

  // Column resize — update width in allColumns or customColumns
  function handleResizeColumn(colId, newWidth) {
    // Save to localStorage for persistence
    const widths = JSON.parse(localStorage.getItem(`board_col_widths_${boardId}`) || '{}');
    widths[colId] = newWidth;
    localStorage.setItem(`board_col_widths_${boardId}`, JSON.stringify(widths));
    // Force re-render by updating board state
    setBoard(prev => ({ ...prev, _resizeTick: Date.now() }));
  }

  // Add new group/sprint to board
  async function handleAddGroup() {
    const newGroup = {
      id: `group_${Date.now()}`,
      title: 'New Group',
      color: ['#e2445c', '#fdab3d', '#00c875', '#579bfc', '#a25ddc', '#ff642e'][Math.floor(Math.random() * 6)],
      position: (board?.groups?.length || 0),
    };
    const updatedGroups = [...(board?.groups || []), newGroup];
    setBoard(prev => ({ ...prev, groups: updatedGroups }));
    try {
      await api.put(`/boards/${boardId}`, { groups: updatedGroups });
    } catch (err) {
      console.error('[BoardPage] handleAddGroup error:', err);
      toastError('Failed to add group. Please try again.');
    }
  }

  function toggleHideColumn(colId) {
    setHiddenColumns(prev =>
      prev.includes(colId) ? prev.filter(id => id !== colId) : [...prev, colId]
    );
  }

  // CSV Export
  async function handleExportCSV() {
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Monday Aniston';
      wb.created = new Date();
      const ws = wb.addWorksheet(board?.name || 'Board Tasks');

      const boardGroups = board?.groups || [];
      const customCols = board?.customColumns || [];

      // Column headers
      const headers = ['Task', 'Status', 'Owner', 'Due Date', 'Start Date', 'Priority', 'Progress', 'Description', ...customCols.map(c => c.title)];

      // Status label map
      const statusLabels = { not_started: 'Not Started', working_on_it: 'Working on it', stuck: 'Stuck', done: 'Done', review: 'In Review' };
      const statusColors = { not_started: 'C4C4C4', working_on_it: 'FDAB3D', stuck: 'E2445C', done: '00C875', review: '579BFC' };
      const priorityColors = { critical: '333333', high: 'E2445C', medium: 'FDAB3D', low: '579BFC' };

      // Board title row
      const titleRow = ws.addRow([board?.name || 'Board Export']);
      titleRow.font = { bold: true, size: 16, color: { argb: 'FF323338' } };
      ws.mergeCells(1, 1, 1, headers.length);
      titleRow.alignment = { horizontal: 'left', vertical: 'middle' };
      titleRow.height = 32;
      ws.addRow([]); // spacing

      // Process each group
      const groupOrder = boardGroups.length > 0 ? boardGroups : [{ id: 'ungrouped', title: 'All Tasks', color: '#579bfc' }];

      for (const group of groupOrder) {
        const groupTasks = tasks.filter(t => boardGroups.length > 0 ? t.groupId === group.id : true);
        const groupColor = (group.color || '#579bfc').replace('#', '');

        // Group header row
        const groupRow = ws.addRow([`${group.title} (${groupTasks.length} items)`, ...Array(headers.length - 1).fill('')]);
        ws.mergeCells(groupRow.number, 1, groupRow.number, headers.length);
        groupRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
        groupRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${groupColor}` } };
        groupRow.alignment = { horizontal: 'left', vertical: 'middle' };
        groupRow.height = 28;

        // Column headers row
        const headerRow = ws.addRow(headers);
        headerRow.font = { bold: true, size: 10, color: { argb: 'FF676879' } };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6F8' } };
        headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
        headerRow.height = 24;
        headerRow.eachCell(cell => {
          cell.border = { bottom: { style: 'thin', color: { argb: 'FFE6E9EF' } } };
        });

        // Task rows
        if (groupTasks.length === 0) {
          const emptyRow = ws.addRow(['No tasks in this group', ...Array(headers.length - 1).fill('')]);
          emptyRow.font = { italic: true, color: { argb: 'FFC4C4C4' } };
          emptyRow.height = 22;
        } else {
          for (const t of groupTasks) {
            const owner = members.find(m => m.id === t.assignedTo)?.name || '';
            const statusLabel = statusLabels[t.status] || t.status || '';
            const row = ws.addRow([
              t.title || '',
              statusLabel,
              owner,
              t.dueDate ? t.dueDate.slice(0, 10) : '',
              t.startDate ? t.startDate.slice(0, 10) : '',
              (t.priority || 'medium').charAt(0).toUpperCase() + (t.priority || 'medium').slice(1),
              `${t.progress || 0}%`,
              t.description || '',
              ...customCols.map(c => t.customFields?.[c.id] || ''),
            ]);
            row.height = 22;
            row.alignment = { vertical: 'middle' };

            // Color the status cell
            const sColor = statusColors[t.status];
            if (sColor) {
              const statusCell = row.getCell(2);
              statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${sColor}` } };
              statusCell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 9 };
              statusCell.alignment = { horizontal: 'center' };
            }

            // Color the priority cell
            const pColor = priorityColors[t.priority];
            if (pColor) {
              const prioCell = row.getCell(6);
              prioCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${pColor}` } };
              prioCell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 9 };
              prioCell.alignment = { horizontal: 'center' };
            }

            // Light row border
            row.eachCell(cell => {
              cell.border = { bottom: { style: 'thin', color: { argb: 'FFF0F0F0' } } };
            });
          }
        }

        // Spacing between groups
        ws.addRow([]);
      }

      // Set column widths
      const widths = [35, 15, 20, 14, 14, 12, 10, 40, ...customCols.map(() => 15)];
      headers.forEach((_, i) => { ws.getColumn(i + 1).width = widths[i] || 15; });

      // Generate and download
      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      saveAs(blob, `${board?.name || 'Board'}_export.xlsx`);
    } catch (err) {
      console.error('[BoardPage] handleExportCSV error:', err);
      toastError('Export failed. Please try again.');
    }
  }

  // Sort tasks
  const sortedTasks = useMemo(() => {
    if (!sortConfig) return tasks;
    return [...tasks].sort((a, b) => {
      let aVal = a[sortConfig.key];
      let bVal = b[sortConfig.key];
      if (sortConfig.key === 'dueDate' || sortConfig.key === 'createdAt' || sortConfig.key === 'updatedAt') {
        aVal = aVal ? new Date(aVal).getTime() : 0;
        bVal = bVal ? new Date(bVal).getTime() : 0;
      }
      if (sortConfig.key === 'progress') {
        aVal = aVal || 0;
        bVal = bVal || 0;
      }
      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
      return 0;
    });
  }, [tasks, sortConfig]);

  async function handleDragEnd(result) {
    const { source, destination, type } = result;
    if (!destination) return;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    if (type === 'TASK') {
      const sourceGroupId = source.droppableId;
      const destGroupId = destination.droppableId;
      const newTasks = [...tasks];

      const sourceTasks = newTasks
        .filter(t => (t.groupId || groups[0]?.id) === sourceGroupId)
        .sort((a, b) => (a.position || 0) - (b.position || 0));

      const [movedTask] = sourceTasks.splice(source.index, 1);
      if (!movedTask) return;

      if (sourceGroupId === destGroupId) {
        sourceTasks.splice(destination.index, 0, movedTask);
        const reorderItems = sourceTasks.map((t, i) => ({ id: t.id, groupId: sourceGroupId, position: i }));
        setTasks(prev => prev.map(t => {
          const item = reorderItems.find(r => r.id === t.id);
          return item ? { ...t, position: item.position } : t;
        }));
        try { await api.put('/tasks/reorder', { boardId, items: reorderItems }); }
        catch { loadTasks(); }
      } else {
        const destTasks = newTasks
          .filter(t => (t.groupId || groups[0]?.id) === destGroupId)
          .sort((a, b) => (a.position || 0) - (b.position || 0));
        movedTask.groupId = destGroupId;
        destTasks.splice(destination.index, 0, movedTask);
        const reorderItems = [
          ...sourceTasks.map((t, i) => ({ id: t.id, groupId: sourceGroupId, position: i })),
          ...destTasks.map((t, i) => ({ id: t.id, groupId: destGroupId, position: i })),
        ];
        setTasks(prev => prev.map(t => {
          const item = reorderItems.find(r => r.id === t.id);
          return item ? { ...t, groupId: item.groupId, position: item.position } : t;
        }));
        try { await api.put('/tasks/reorder', { boardId, items: reorderItems }); }
        catch { loadTasks(); }
      }
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      // Ctrl+N or N: New task (only if user can create tasks)
      if ((e.key === 'n' || e.key === 'N') && canCreateTask) {
        if (e.ctrlKey || e.metaKey || !e.shiftKey) {
          e.preventDefault();
          const firstGroupId = board?.groups?.[0]?.id || 'new';
          handleAddTask(firstGroupId, 'New Task');
        }
      }
      // Ctrl+F or F: Toggle filters
      if (e.key === 'f' || e.key === 'F') {
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          setShowFilters(prev => !prev);
        } else if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          document.querySelector('[data-search-input]')?.focus();
        }
      }
      // 1: Switch to Table view
      if (e.key === '1') { e.preventDefault(); setViewTab('table'); }
      // 2: Switch to Kanban view
      if (e.key === '2') { e.preventDefault(); setViewTab('kanban'); }
      // 3: Switch to Calendar view
      if (e.key === '3') { e.preventDefault(); setViewTab('calendar'); }
      // 4: Switch to Gantt view
      if (e.key === '4') { e.preventDefault(); setViewTab('gantt'); }
      if (e.key === 'Delete') {
        e.preventDefault();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [board]);

  if (loading) return <SkeletonBoard />;

  const groups = board?.groups || [
    { id: 'new', title: 'To-Do', color: '#579bfc' },
    { id: 'in_progress', title: 'In Progress', color: '#fdab3d' },
    { id: 'completed', title: 'Completed', color: '#00c875' },
  ];

  const activeFilterCount = (advFilters.status.length > 0 ? 1 : 0) + (advFilters.priority.length > 0 ? 1 : 0) + (advFilters.person ? 1 : 0);

  return (
    <div className="h-full flex flex-col">
      {/* Board Header — Monday.com style */}
      <div className="px-6 pt-4 pb-1">
        {/* Board Title */}
        <div className="flex items-center gap-2 mb-3">
          <h1 className="text-[22px] font-bold text-[#323338]">{board?.name || 'Board'}</h1>
          {board?.workspace?.name && (
            <span className="text-sm font-medium text-text-tertiary bg-surface px-2.5 py-0.5 rounded-full">{board.workspace.name}</span>
          )}
          {canManage && (
            <button onClick={() => setShowSettings(true)} className="p-1 rounded hover:bg-[#dcdfec] text-[#c4c4c4] hover:text-[#676879] transition-colors" title="Board Settings">
              <Settings size={16} />
            </button>
          )}
        </div>

        {/* View Tabs — Monday.com style: Main table ... Gantt Calendar Kanban + */}
        <div className="flex items-center gap-0 mb-3 border-b border-[#e6e9ef]">
          {[
            { id: 'table', label: 'Main table' },
            { id: 'gantt', label: 'Gantt' },
            { id: 'calendar', label: 'Calendar' },
            { id: 'kanban', label: 'Kanban' },
          ].map(tab => (
            <button key={tab.id} onClick={() => setViewTab(tab.id)}
              className={`px-3 py-2 text-[14px] border-b-[3px] -mb-px transition-all duration-100 ${
                viewTab === tab.id
                  ? 'border-[#0073ea] text-[#323338] font-medium'
                  : 'border-transparent text-[#676879] hover:text-[#323338]'
              }`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 py-1.5 flex-wrap">
          {/* New group split button with dropdown — only for users who can edit boards */}
          {canEditBoard && (
            <div className="flex items-center relative">
              <button onClick={() => handleAddGroup()}
                className="flex items-center gap-1.5 h-[34px] px-4 bg-[#0073ea] hover:bg-[#0060c2] text-white text-[13px] font-medium rounded-l-md transition-colors">
                <Plus size={14} strokeWidth={2.5} /> New group
              </button>
              <button onClick={() => setShowNewTaskMenu(!showNewTaskMenu)}
                className="flex items-center justify-center h-[34px] w-[30px] bg-[#0060c2] hover:bg-[#004fa3] text-white rounded-r-md border-l border-white/20 transition-colors">
                <ChevronDown size={13} className={`transition-transform duration-150 ${showNewTaskMenu ? 'rotate-180' : ''}`} />
              </button>
              {showNewTaskMenu && (
                <NewTaskDropdown
                  onNewGroup={() => { handleAddGroup(); setShowNewTaskMenu(false); }}
                  onImport={() => { setShowCSVImport(true); setShowNewTaskMenu(false); }}
                  onClose={() => setShowNewTaskMenu(false)}
                />
              )}
            </div>
          )}

          <div className="flex items-center gap-0.5 ml-2">
            {/* Search */}
            <button onClick={() => {
              const inp = document.querySelector('[data-search-input]');
              if (inp) { inp.style.width = '160px'; inp.focus(); }
            }} className={`flex items-center gap-1.5 px-2.5 py-[6px] text-[14px] rounded-[4px] transition-colors ${searchQuery ? 'bg-[#cce5ff] text-[#0073ea]' : 'text-[#676879] hover:bg-[#dcdfec]'}`}>
              <Search size={14} /> Search
            </button>
            <input data-search-input type="text" placeholder="Search tasks..." value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onBlur={(e) => { if (!e.target.value) e.target.style.width = '0'; }}
              className={`bg-transparent border-none outline-none text-[14px] text-[#323338] transition-all duration-300 ${searchQuery ? 'w-[160px] border-b border-[#0073ea] ml-1' : 'w-0'}`} />

            {/* Filter */}
            <button onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-1.5 px-2.5 py-[6px] text-[14px] rounded-[4px] transition-colors ${
                showFilters || activeFilterCount > 0 ? 'bg-[#cce5ff] text-[#0073ea]' : 'text-[#676879] hover:bg-[#dcdfec]'
              }`}>
              <Filter size={14} /> Filter
              {activeFilterCount > 0 && <span className="text-[11px] font-bold">/ {activeFilterCount}</span>}
            </button>

            {/* Sort */}
            <SortDropdown sortConfig={sortConfig} onSort={setSortConfig} />

            {/* Hide */}
            <div className="relative">
              <button onClick={() => setShowHideColumns(!showHideColumns)}
                className={`flex items-center gap-1.5 px-2.5 py-[6px] text-[14px] rounded-[4px] transition-colors ${
                  hiddenColumns.length > 0 ? 'bg-[#cce5ff] text-[#0073ea]' : 'text-[#676879] hover:bg-[#dcdfec]'
                }`}>
                <Eye size={14} /> Hide
                {hiddenColumns.length > 0 && <span className="text-[11px] font-bold">/ {hiddenColumns.length}</span>}
              </button>
              {showHideColumns && (
                <div className="absolute top-full left-0 mt-1 w-52 bg-white rounded-lg shadow-dropdown border border-[#e6e9ef] z-50 dropdown-enter p-2">
                  <p className="text-[11px] font-medium text-[#676879] px-2 pb-1.5">Toggle Columns</p>
                  {allColumns.map(col => (
                    <label key={col.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[#f5f6f8] cursor-pointer transition-colors">
                      <input type="checkbox" checked={!hiddenColumns.includes(col.id)} onChange={() => toggleHideColumn(col.id)}
                        className="w-3.5 h-3.5 rounded border-[#c4c4c4] text-[#0073ea] focus:ring-[#0073ea]/20" />
                      <span className="text-[#323338] text-[13px]">{col.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

          </div>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-1">
            {canEditBoard && (
              <button onClick={() => setShowCSVImport(true)} className="flex items-center gap-1 px-2 py-[6px] text-[13px] text-[#676879] hover:bg-[#dcdfec] rounded-[4px] transition-colors">
                <Upload size={13} /> Import
              </button>
            )}
            <button onClick={handleExportCSV} className="flex items-center gap-1 px-2 py-[6px] text-[13px] text-[#676879] hover:bg-[#dcdfec] rounded-[4px] transition-colors">
              <Download size={13} /> Export
            </button>
            {canManage && (
              <>
                <button onClick={() => setShowAutomations(true)} className="flex items-center gap-1 px-2 py-[6px] text-[13px] text-[#676879] hover:bg-[#dcdfec] rounded-[4px] transition-colors">
                  <Zap size={13} /> Automate
                </button>
                <button onClick={() => navigate(`/boards/${boardId}/dashboard`)} className="flex items-center gap-1 px-2 py-[6px] text-[13px] text-[#676879] hover:bg-[#dcdfec] rounded-[4px] transition-colors">
                  <BarChart3 size={13} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Advanced Filters Panel */}
        {showFilters && (
          <div className="animate-fade-in">
            <AdvancedFilters
              filters={advFilters}
              onChange={setAdvFilters}
              members={members}
              boardStatuses={getBoardStatuses(board)}
              onClear={() => setAdvFilters({ status: [], priority: [], person: '' })}
            />
          </div>
        )}
      </div>

      {/* Board Content */}
      {viewTab === 'gantt' ? (
        <div className="flex-1 overflow-auto px-6 pb-6">
          <TimelineView tasks={sortedTasks} members={members} onTaskClick={setSelectedTask} />
        </div>
      ) : viewTab === 'calendar' ? (
        <div className="flex-1 overflow-auto px-6 pb-6">
          <CalendarView tasks={sortedTasks} members={members} onTaskClick={setSelectedTask} />
        </div>
      ) : viewTab === 'kanban' ? (
        <div className="flex-1 overflow-auto px-6 pb-6">
          <KanbanView
            tasks={sortedTasks}
            members={members}
            groups={groups}
            boardStatuses={getBoardStatuses(board)}
            onTaskClick={setSelectedTask}
            onTaskUpdate={(taskId, updates) => handleTaskUpdate(taskId, updates)}
            onAddTask={handleAddTask}
          />
        </div>
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          <div className="flex-1 overflow-auto px-2 sm:px-6 pb-6 -webkit-overflow-scrolling-touch" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            {/* Empty state for employees with no visible tasks */}
            {sortedTasks.length === 0 && !loading && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 rounded-full bg-surface-100 flex items-center justify-center mb-4">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#c4c4c4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="2"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
                </div>
                <h3 className="text-lg font-semibold text-[#323338] mb-1">No tasks assigned to you</h3>
                <p className="text-sm text-[#676879] max-w-sm">You don't have any tasks on this board yet. Tasks will appear here once a manager assigns them to you.</p>
              </div>
            )}
            {groups.map((group, idx) => {
              const validGroupIds = groups.map(g => g.id);
              const groupTasks = sortedTasks
                .filter(t => t.groupId === group.id || ((!t.groupId || !validGroupIds.includes(t.groupId)) && group.id === groups[0]?.id))
                .sort((a, b) => sortConfig ? 0 : (a.position || 0) - (b.position || 0));
              return (
                <TaskGroup
                  key={group.id}
                  group={group}
                  tasks={groupTasks}
                  members={members}
                  columns={visibleColumns}
                  boardId={boardId}
                  boardStatuses={getBoardStatuses(board)}
                  color={group.color}
                  index={idx}
                  onTaskClick={setSelectedTask}
                  onTaskUpdate={handleTaskUpdate}
                  onAddTask={handleAddTask}
                  onArchiveTask={handleArchiveTask}
                  onRequestExtension={setExtensionTask}
                  onRequestHelp={setHelpTask}
                  onEditColumn={handleEditColumn}
                  onAddColumn={handleAddColumn}
                  onRemoveColumn={handleRemoveColumn}
                  onHideColumn={toggleHideColumn}
                  onResizeColumn={handleResizeColumn}
                  onSort={setSortConfig}
                  isDragEnabled={true}
                  selectedTaskIds={selectedTaskIds}
                  onSelectTask={handleSelectTask}
                  onArchiveGroup={handleArchiveGroup}
                  onRenameGroup={handleRenameGroup}
                  onGroupBy={(col) => {
                    const key = col.id === 'status' ? 'status' : col.id === 'date' ? 'dueDate' : col.id === 'priority' ? 'priority' : col.id;
                    setSortConfig({ key, direction: 'asc' });
                  }}
                  onDuplicateColumn={handleDuplicateColumn}
                  onChangeColumnType={handleChangeColumnType}
                  onSetColumnRequired={handleSetColumnRequired}
                  onSetColumnDescription={handleSetColumnDescription}
                  onReorderColumns={handleReorderColumns}
                />
              );
            })}
          </div>
        </DragDropContext>
      )}

      {/* Task Modal */}
      {selectedTask && (
        <TaskModal
          task={selectedTask}
          boardId={boardId}
          members={members}
          boardStatuses={getBoardStatuses(board)}
          onClose={() => setSelectedTask(null)}
          onUpdate={(updated) => {
            setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
            setSelectedTask(updated);
          }}
          onDelete={handleTaskDelete}
        />
      )}

      {/* Bulk Action Bar */}
      <BulkActionBar
        selectedIds={selectedTaskIds}
        members={members}
        boardStatuses={getBoardStatuses(board)}
        onDone={() => { setSelectedTaskIds([]); loadTasks(); }}
        onClear={() => setSelectedTaskIds([])}
      />

      {/* Automations Panel */}
      {showAutomations && <AutomationsPanel boardId={boardId} onClose={() => setShowAutomations(false)} />}

      {/* Board Settings Modal */}
      {showSettings && board && (
        <BoardSettingsModal
          board={{ ...board, members }}
          onClose={() => setShowSettings(false)}
          onUpdate={(updated) => { setBoard(updated); setMembers(updated.members || updated.Users || []); }}
          onDelete={() => navigate('/boards')}
        />
      )}

      {/* CSV Import Modal */}
      {showCSVImport && (
        <CSVImportModal boardId={boardId} board={board} columns={allColumns} members={members} onClose={() => setShowCSVImport(false)} onImported={loadTasks} />
      )}

      {/* Due Date Extension Modal */}
      {extensionTask && (
        <DueDateExtensionModal task={extensionTask} onClose={() => setExtensionTask(null)} onSubmit={loadTasks} />
      )}

      {/* Help Request Modal */}
      {helpTask && (
        <HelpRequestModal task={helpTask} members={members} onClose={() => setHelpTask(null)} onSubmit={loadTasks} />
      )}
    </div>
  );
}
