import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Calendar, Save, Plus, X, Clock, ChevronLeft, ChevronRight, ChevronDown as ChevronDownIcon, Trash2, Edit3, Hammer, Receipt, Package, ClipboardList, Scale, FlaskConical, Factory, Bot, Monitor, Palette, Folder, Star, Target, BookOpen, Phone, Mail, Coffee, Briefcase as BriefcaseIcon, Paintbrush, Link2, Copy, Check, ListChecks, FileText, Paperclip, Download, Eye, GripVertical, AlertTriangle, FileSpreadsheet } from 'lucide-react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { useToast } from '../components/common/Toast';
import { useUndo } from '../context/UndoContext';
import useSocket from '../hooks/useSocket';
import { format, addDays, subDays, isToday, isYesterday, isTomorrow, isFuture } from 'date-fns';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

const CATEGORY_ICONS = {
  briefcase: '\uD83D\uDCBC',
  users: '\uD83D\uDC65',
  phone: '\uD83D\uDCDE',
  mail: '\uD83D\uDCE7',
  clipboard: '\uD83D\uDCCB',
  star: '\u2B50',
  flag: '\uD83D\uDEA9',
  target: '\uD83C\uDFAF',
  coffee: '\u2615',
  book: '\uD83D\uDCDA',
  calendar: '\uD83D\uDCC5',
  clock: '\u23F0',
};

const ICON_MAP = {
  Hammer, Receipt, Package, ClipboardList, Scale, FlaskConical, Factory, Bot, Monitor, Palette,
  Folder, Star, Target, BookOpen, Phone, Mail, Coffee, BriefcaseIcon, Paintbrush, Calendar, Clock, Trash2,
};
const ICON_OPTIONS = ['Hammer','Receipt','Package','ClipboardList','Scale','FlaskConical','Factory','Bot','Monitor','Palette','Folder','Star','Target','BookOpen','Phone','Mail','Coffee','BriefcaseIcon','Paintbrush'];
const COLOR_OPTIONS = ['#E8590C','#D6336C','#9333EA','#4F46E5','#2563EB','#059669','#D97706','#DC2626','#0D9488','#7C3AED','#6366F1','#EC4899','#14B8A6','#F97316'];

const PRIORITY_OPTIONS = [
  { value: 'urgent', label: 'Urgent', color: 'bg-red-500', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
  { value: 'high', label: 'High', color: 'bg-orange-500', bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
  { value: 'medium', label: 'Medium', color: 'bg-blue-500', bg: 'bg-blue-50', text: 'text-blue-600', border: 'border-blue-200' },
  { value: 'low', label: 'Low', color: 'bg-gray-400', bg: 'bg-gray-50', text: 'text-gray-500', border: 'border-gray-200' },
];
const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
const sortByPriority = (tasks) => [...(tasks || [])].sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));
const getPriorityStyle = (p) => PRIORITY_OPTIONS.find(o => o.value === p) || PRIORITY_OPTIONS[2];

function getDeadlineUrgency(deadline) {
  if (!deadline) return null;
  const now = new Date();
  const dl = new Date(deadline);
  const hoursLeft = (dl - now) / (1000 * 60 * 60);
  if (hoursLeft < 0) return { label: 'Overdue', color: 'bg-red-100 text-red-700 border-red-200' };
  if (hoursLeft <= 24) return { label: 'Due Soon', color: 'bg-orange-100 text-orange-700 border-orange-200' };
  if (hoursLeft <= 48) return { label: '2 Days', color: 'bg-yellow-100 text-yellow-700 border-yellow-200' };
  return { label: format(dl, 'MMM d'), color: 'bg-gray-100 text-gray-600 border-gray-200' };
}

function getIcon(name, size = 18) {
  const Icon = ICON_MAP[name];
  return Icon ? <Icon size={size} /> : <Folder size={size} />;
}

function getRelativeDayLabel(date) {
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  if (isTomorrow(date)) return 'Tomorrow';
  if (isFuture(date)) return 'Future';
  return 'Past';
}

export default function AssistantManagerPlanPage() {
  const { isAssistantManager, isSuperAdmin } = useAuth();
  const toast = useToast();
  const { pushAction } = useUndo();

  const [selectedDate, setSelectedDate] = useState(new Date());
  const [categories, setCategories] = useState([]);
  const [notes, setNotes] = useState('');
  const [directorName, setDirectorName] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newTaskInputs, setNewTaskInputs] = useState({});
  const [openIconSelector, setOpenIconSelector] = useState(null);
  const [openColorSelector, setOpenColorSelector] = useState(null);
  const [expandedTasks, setExpandedTasks] = useState({});
  const [newSubtaskInputs, setNewSubtaskInputs] = useState({});
  const [copiedLink, setCopiedLink] = useState(null);
  const [directors, setDirectors] = useState([]);
  const [selectedDirectorId, setSelectedDirectorId] = useState(null);
  const [viewingTask, setViewingTask] = useState(null); // { catIndex, taskIndex, task, catLabel }
  const [currentTime, setCurrentTime] = useState(new Date());
  // users state removed — assignee dropdown uses directors list instead
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { type: 'task'|'card', catIndex, taskIndex?, taskText?, catLabel? }
  const [exportConfirm, setExportConfirm] = useState(null); // null or { catIndex? } for single card export

  const [viewMode, setViewMode] = useState(''); // 'cumulative' or 'snapshot'
  const [saveStatus, setSaveStatus] = useState(''); // '', 'saving', 'saved'
  const autoSaveTimer = useRef(null);
  const loadTimerRef = useRef(null);
  const abortControllerRef = useRef(null);
  const dirtyRef = useRef(false);
  const categoriesRef = useRef([]);
  const notesRef = useRef('');
  const dateStrRef = useRef('');
  const selectedDirectorIdRef = useRef(null);

  const dateStr = format(selectedDate, 'yyyy-MM-dd');
  const displayDate = format(selectedDate, 'EEEE, MMMM d, yyyy');

  // Keep refs in sync so save-before-navigate always has fresh values
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { categoriesRef.current = categories; }, [categories]);
  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { dateStrRef.current = dateStr; }, [dateStr]);
  useEffect(() => { selectedDirectorIdRef.current = selectedDirectorId; }, [selectedDirectorId]);

  // Save current plan immediately (used before navigating away)
  const saveCurrentPlan = useCallback(async () => {
    if (!dirtyRef.current) return;
    try {
      await api.put(`/director-plan/${dateStrRef.current}`, {
        categories: categoriesRef.current,
        notes: notesRef.current,
        directorId: selectedDirectorIdRef.current,
      });
      dirtyRef.current = false;
      setDirty(false);
    } catch (err) {
      console.error('Auto-save before navigate failed:', err);
    }
  }, []);

  // Load available directors on mount
  useEffect(() => {
    api.get('/director-plan/directors').then(res => {
      const d = res.data;
      const dirs = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.directors) ? d.directors : [];
      setDirectors(dirs);
      if (dirs.length > 0 && !selectedDirectorId) {
        setSelectedDirectorId(dirs[0].id);
      }
      // No directors found — loadPlan will use server-side fallback (no directorId param)
    }).catch((e) => { console.error('Failed to load directors:', e); });
  }, []);

  // Directors list is used for the assignee dropdown (only directors/superadmins can be assigned)

  // Load plan for selected date + director
  const loadPlan = useCallback(async () => {
    // Cancel any in-flight request (handles rapid date navigation)
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      setLoading(true);
      clearTimeout(loadTimerRef.current);
      loadTimerRef.current = setTimeout(() => setLoading(false), 5000);
      const dirParam = selectedDirectorId ? `?directorId=${selectedDirectorId}` : '';
      const res = await api.get(`/director-plan/${dateStr}${dirParam}`, {
        signal: controller.signal,
      });
      const raw = res.data;
      const plan = (raw && typeof raw === 'object') ? raw : {};
      const cats = Array.isArray(plan.categories) ? plan.categories : [];
      setCategories(cats.map(cat => ({
        ...cat,
        tasks: Array.isArray(cat.tasks) ? cat.tasks : [],
      })));
      setNotes(plan.notes || '');
      setDirectorName(plan.directorName || 'Director');
      setViewMode(plan.viewMode || '');
      setDirty(false);
      setSaveStatus('');
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return; // Request was cancelled by newer navigation
      console.error('Failed to load director plan:', err);
      toast?.error?.('Failed to load plan');
    } finally {
      clearTimeout(loadTimerRef.current);
      setLoading(false);
    }
  }, [dateStr, selectedDirectorId]);

  useEffect(() => {
    loadPlan();
    return () => clearTimeout(loadTimerRef.current);
  }, [loadPlan]);

  // Warn before closing browser tab with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Update current time every minute for NOW detection
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Determine which category is "NOW" (current time falls within its range)
  const nowCategoryIndex = useMemo(() => {
    const now = currentTime.getHours() * 60 + currentTime.getMinutes();
    return categories.findIndex(cat => {
      if (!cat.startTime || !cat.endTime) return false;
      const [sh, sm] = cat.startTime.split(':').map(Number);
      const [eh, em] = cat.endTime.split(':').map(Number);
      const start = sh * 60 + sm;
      const end = eh * 60 + em;
      return now >= start && now < end;
    });
  }, [categories, currentTime]);

  // Build display order: NOW card first, then rest in saved order
  const displayOrder = useMemo(() => {
    if (!Array.isArray(categories)) return [];
    const indices = categories.map((_, i) => i);
    if (nowCategoryIndex >= 0) {
      const filtered = indices.filter(i => i !== nowCategoryIndex);
      return [nowCategoryIndex, ...filtered];
    }
    return indices;
  }, [categories, nowCategoryIndex]);

  // Drag-and-drop handler for category cards and tasks
  function onDragEnd(result) {
    if (!result.destination) return;

    if (result.type === 'TASK') {
      // Task-level drag and drop
      const srcCatIndex = parseInt(result.source.droppableId.split('-')[1]);
      const destCatIndex = parseInt(result.destination.droppableId.split('-')[1]);
      const srcTaskIndex = result.source.index;
      const destTaskIndex = result.destination.index;

      if (srcCatIndex === destCatIndex && srcTaskIndex === destTaskIndex) return;

      setCategories(prev => {
        const updated = prev.map(cat => ({ ...cat, tasks: [...(cat.tasks || [])] }));
        const [movedTask] = updated[srcCatIndex].tasks.splice(srcTaskIndex, 1);
        updated[destCatIndex].tasks.splice(destTaskIndex, 0, movedTask);
        return updated;
      });
      markDirty();
      return;
    }

    // Card-level drag and drop (type === 'CARD')
    const srcDisplayIdx = result.source.index;
    const destDisplayIdx = result.destination.index;
    if (srcDisplayIdx === destDisplayIdx) return;

    // Convert display indices back to actual category indices
    const srcActualIdx = displayOrder[srcDisplayIdx];
    const destActualIdx = displayOrder[destDisplayIdx];

    setCategories(prev => {
      const updated = [...prev];
      const [moved] = updated.splice(srcActualIdx, 1);
      // Find where destActualIdx ended up after the splice
      const insertAt = srcActualIdx < destActualIdx ? destActualIdx : destActualIdx;
      updated.splice(insertAt, 0, moved);
      return updated;
    });
    markDirty();
  }

  // Auto-save after 2 seconds of inactivity
  useEffect(() => {
    if (!dirty) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      handleSave(true);
    }, 2000);
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [dirty, categories, notes]);

  // Real-time sync: reload when director toggles tasks
  useSocket('director-plan:updated', (data) => {
    // Only reload if it's for the same date and we're not currently dirty (avoid overwriting PA's unsaved edits)
    if (!dirty && data?.date === dateStr) {
      loadPlan();
    }
  });

  // Access check
  if (!isAssistantManager && !isSuperAdmin) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Calendar size={48} className="text-gray-300 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-gray-700">Access Denied</h2>
          <p className="text-sm text-gray-500 mt-2">This page is only available for the Assistant Manager or Super Admin.</p>
        </div>
      </div>
    );
  }

  // Save plan
  async function handleSave(isAutoSave = false) {
    try {
      setSaving(true);
      if (isAutoSave) setSaveStatus('saving');
      await api.put(`/director-plan/${dateStr}`, { categories, notes, directorId: selectedDirectorId });
      setDirty(false);
      if (isAutoSave) {
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus(''), 3000);
      } else {
        toast?.success?.(`Plan saved for ${displayDate}`);
        setSaveStatus('');
      }
    } catch (err) {
      console.error('Failed to save plan:', err);
      toast?.error?.('Failed to save plan');
      setSaveStatus('');
    } finally {
      setSaving(false);
    }
  }

  // Date navigation — save dirty data before switching
  async function goToPrev() {
    await saveCurrentPlan();
    setSelectedDate(prev => subDays(prev, 1));
  }
  async function goToNext() {
    await saveCurrentPlan();
    setSelectedDate(prev => addDays(prev, 1));
  }
  async function goToToday() {
    await saveCurrentPlan();
    setSelectedDate(new Date());
  }

  // Mark dirty on any edit
  function markDirty() {
    setDirty(true);
  }

  // Toggle task done
  function toggleTask(catIndex, taskIndex) {
    setCategories(prev => {
      const updated = prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return {
          ...cat,
          tasks: (cat.tasks || []).map((t, ti) =>
            ti === taskIndex ? { ...t, done: !t.done } : t
          ),
        };
      });
      return updated;
    });
    markDirty();
  }

  // Update task text
  function updateTaskText(catIndex, taskIndex, text) {
    setCategories(prev =>
      prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return {
          ...cat,
          tasks: (cat.tasks || []).map((t, ti) =>
            ti === taskIndex ? { ...t, text } : t
          ),
        };
      })
    );
    markDirty();
  }

  // Delete task — show confirmation modal
  function confirmDeleteTask(catIndex, taskIndex) {
    const task = categories[catIndex]?.tasks?.[taskIndex];
    setDeleteConfirm({ type: 'task', catIndex, taskIndex, taskText: task?.text || 'Untitled task', catLabel: categories[catIndex]?.label });
  }

  function executeDeleteTask(catIndex, taskIndex) {
    const deletedTask = categories[catIndex]?.tasks?.[taskIndex];
    const deletedFrom = categories[catIndex]?.label;
    const deletedTaskId = deletedTask?.id;

    setCategories(prev =>
      prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return {
          ...cat,
          tasks: (cat.tasks || []).filter((_, ti) => ti !== taskIndex),
          // Track deleted task ID so cumulative view doesn't resurrect it from older plans
          _deletedTaskIds: [...(cat._deletedTaskIds || []), deletedTaskId].filter(Boolean),
        };
      })
    );
    markDirty();
    setDeleteConfirm(null);

    // Push undo action — restore task for 5 seconds
    if (deletedTask) {
      pushAction({
        type: 'delete_director_task',
        description: `Deleted "${deletedTask.text || 'task'}" from ${deletedFrom}`,
        undo: async () => {
          setCategories(prev =>
            prev.map((cat, ci) => {
              if (ci !== catIndex) return cat;
              const tasks = [...(cat.tasks || [])];
              tasks.splice(taskIndex, 0, deletedTask);
              return {
                ...cat,
                tasks,
                _deletedTaskIds: (cat._deletedTaskIds || []).filter(id => id !== deletedTaskId),
              };
            })
          );
          markDirty();
        },
        redo: async () => {
          setCategories(prev =>
            prev.map((cat, ci) => {
              if (ci !== catIndex) return cat;
              return {
                ...cat,
                tasks: (cat.tasks || []).filter((_, ti) => ti !== taskIndex),
                _deletedTaskIds: [...(cat._deletedTaskIds || []), deletedTaskId].filter(Boolean),
              };
            })
          );
          markDirty();
        },
      });
    }
  }

  // Delete card — show confirmation modal
  function confirmDeleteCard(catIndex) {
    const cat = categories[catIndex];
    setDeleteConfirm({ type: 'card', catIndex, catLabel: cat?.label, taskCount: (cat?.tasks || []).length });
  }

  function executeDeleteCard(catIndex) {
    const deletedCard = categories[catIndex];
    const deletedCatId = deletedCard?.id;

    setCategories(prev => {
      const filtered = prev.filter((_, i) => i !== catIndex);
      // Track deleted category ID on remaining categories so cumulative view excludes it
      if (deletedCatId && filtered.length > 0) {
        filtered[0] = {
          ...filtered[0],
          _deletedCategoryIds: [...(filtered[0]._deletedCategoryIds || []), deletedCatId],
        };
      }
      return filtered;
    });
    markDirty();
    setDeleteConfirm(null);

    if (deletedCard) {
      pushAction({
        type: 'delete_director_card',
        description: `Deleted card "${deletedCard.label}" with ${(deletedCard.tasks || []).length} tasks`,
        undo: async () => {
          setCategories(prev => {
            const updated = [...prev];
            updated.splice(catIndex, 0, deletedCard);
            // Remove from deleted tracking
            if (deletedCatId && updated.length > 0) {
              const first = updated.find(c => c.id !== deletedCatId);
              if (first) {
                first._deletedCategoryIds = (first._deletedCategoryIds || []).filter(id => id !== deletedCatId);
              }
            }
            return updated;
          });
          markDirty();
        },
        redo: async () => {
          setCategories(prev => {
            const filtered = prev.filter((_, i) => i !== catIndex);
            if (deletedCatId && filtered.length > 0) {
              filtered[0] = {
                ...filtered[0],
                _deletedCategoryIds: [...(filtered[0]._deletedCategoryIds || []), deletedCatId],
              };
            }
            return filtered;
          });
          markDirty();
        },
      });
    }
  }

  // Export plan to Excel
  async function exportToExcel(singleCatIndex = null) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Director Plan');

    // Title
    ws.mergeCells('A1', 'G1');
    const titleCell = ws.getCell('A1');
    titleCell.value = `Director's Daily Plan — ${directorName}`;
    titleCell.font = { bold: true, size: 16, color: { argb: 'FF1e1b4b' } };
    titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
    ws.getRow(1).height = 30;

    ws.mergeCells('A2', 'G2');
    ws.getCell('A2').value = `Date: ${displayDate}`;
    ws.getCell('A2').font = { size: 11, color: { argb: 'FF6b7280' } };

    // Column widths
    ws.getColumn(1).width = 5;   // #
    ws.getColumn(2).width = 40;  // Task
    ws.getColumn(3).width = 12;  // Priority
    ws.getColumn(4).width = 14;  // Status
    ws.getColumn(5).width = 18;  // Deadline
    ws.getColumn(6).width = 20;  // Assignee
    ws.getColumn(7).width = 10;  // Subtasks

    let row = 4;
    const catsToExport = singleCatIndex !== null
      ? [{ cat: categories[singleCatIndex], idx: singleCatIndex }]
      : categories.map((cat, idx) => ({ cat, idx }));

    for (const { cat } of catsToExport) {
      if (!cat) continue;
      const colorHex = (cat.color || '#6366F1').replace('#', '');

      // Category header
      ws.mergeCells(row, 1, row, 7);
      const headerCell = ws.getCell(row, 1);
      headerCell.value = `${cat.label}  (${cat.startTime || ''} - ${cat.endTime || ''})`;
      headerCell.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
      headerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + colorHex } };
      headerCell.alignment = { horizontal: 'left', vertical: 'middle' };
      ws.getRow(row).height = 28;
      row++;

      // Column headers
      const headers = ['#', 'Task', 'Priority', 'Status', 'Deadline', 'Assignee', 'Subtasks'];
      const headerRow = ws.addRow(headers);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, size: 10, color: { argb: 'FF374151' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
      });
      row++;

      // Task rows
      const tasks = cat.tasks || [];
      if (tasks.length === 0) {
        ws.mergeCells(row, 1, row, 7);
        ws.getCell(row, 1).value = 'No tasks';
        ws.getCell(row, 1).font = { italic: true, color: { argb: 'FF9CA3AF' } };
        row++;
      } else {
        tasks.forEach((task, ti) => {
          const priorityColors = { urgent: 'FFEF4444', high: 'FFF97316', medium: 'FF3B82F6', low: 'FF9CA3AF' };
          const priorityColor = priorityColors[task.priority] || priorityColors.medium;
          const deadlineStr = task.deadline ? format(new Date(task.deadline), 'MMM d, yyyy h:mm a') : '—';
          const subCount = (task.subtasks || []).length;
          const subDone = (task.subtasks || []).filter(s => s.done).length;

          const taskRow = ws.addRow([
            ti + 1,
            task.text || task.title || '',
            (task.priority || 'medium').charAt(0).toUpperCase() + (task.priority || 'medium').slice(1),
            task.done ? 'Done' : 'Pending',
            deadlineStr,
            task.assigneeName || 'Unassigned',
            subCount > 0 ? `${subDone}/${subCount}` : '—',
          ]);

          // Priority color
          taskRow.getCell(3).font = { bold: true, color: { argb: priorityColor } };
          // Status color
          taskRow.getCell(4).font = { color: { argb: task.done ? 'FF10B981' : 'FFF59E0B' } };
          // Strikethrough for done tasks
          if (task.done) {
            taskRow.getCell(2).font = { strike: true, color: { argb: 'FF9CA3AF' } };
          }
          row++;
        });
      }

      row++; // Spacing between categories
    }

    // Footer
    ws.getCell(row + 1, 1).value = `Exported from Monday Aniston — ${format(new Date(), 'MMM d, yyyy h:mm a')}`;
    ws.getCell(row + 1, 1).font = { size: 9, italic: true, color: { argb: 'FF9CA3AF' } };

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const filename = singleCatIndex !== null
      ? `${categories[singleCatIndex]?.label || 'Card'}_${dateStr}.xlsx`
      : `Director_Plan_${directorName}_${dateStr}.xlsx`;
    saveAs(blob, filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_'));
    setExportConfirm(null);
    toast?.success?.('Excel exported successfully');
  }

  // Add task to category
  function addTask(catIndex) {
    const text = (newTaskInputs[catIndex] || '').trim();
    if (!text) return;
    const now = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
    setCategories(prev =>
      prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return {
          ...cat,
          tasks: [...(cat.tasks || []), {
            id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
            text, done: false, time: now,
            description: '', link: '',
            startTime: '', endTime: '',
            priority: 'medium',
            deadline: null,
            assigneeId: null,
            assigneeName: null,
            subtasks: [],
          }],
        };
      })
    );
    setNewTaskInputs(prev => ({ ...prev, [catIndex]: '' }));
    markDirty();
  }

  // Update any task field
  function updateTaskField(catIndex, taskIndex, field, value) {
    setCategories(prev =>
      prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return { ...cat, tasks: (cat.tasks || []).map((t, ti) => ti === taskIndex ? { ...t, [field]: value } : t) };
      })
    );
    markDirty();
  }

  // Toggle task expand
  function toggleExpand(catIndex, taskIndex) {
    const key = `${catIndex}-${taskIndex}`;
    setExpandedTasks(prev => ({ ...prev, [key]: !prev[key] }));
  }

  // Add subtask
  function addSubtask(catIndex, taskIndex) {
    const key = `${catIndex}-${taskIndex}`;
    const title = (newSubtaskInputs[key] || '').trim();
    if (!title) return;
    setCategories(prev =>
      prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return {
          ...cat,
          tasks: (cat.tasks || []).map((t, ti) => {
            if (ti !== taskIndex) return t;
            return {
              ...t,
              subtasks: [...(t.subtasks || []), {
                id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
                title, description: '', link: '',
                done: false, startTime: '', endTime: '',
              }],
            };
          }),
        };
      })
    );
    setNewSubtaskInputs(prev => ({ ...prev, [key]: '' }));
    markDirty();
  }

  // Toggle subtask done
  function toggleSubtask(catIndex, taskIndex, subIndex) {
    setCategories(prev =>
      prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return {
          ...cat,
          tasks: (cat.tasks || []).map((t, ti) => {
            if (ti !== taskIndex) return t;
            return {
              ...t,
              subtasks: (t.subtasks || []).map((s, si) =>
                si === subIndex ? { ...s, done: !s.done } : s
              ),
            };
          }),
        };
      })
    );
    markDirty();
  }

  // Update subtask field
  function updateSubtaskField(catIndex, taskIndex, subIndex, field, value) {
    setCategories(prev =>
      prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return {
          ...cat,
          tasks: (cat.tasks || []).map((t, ti) => {
            if (ti !== taskIndex) return t;
            return {
              ...t,
              subtasks: (t.subtasks || []).map((s, si) =>
                si === subIndex ? { ...s, [field]: value } : s
              ),
            };
          }),
        };
      })
    );
    markDirty();
  }

  // Delete subtask
  function deleteSubtask(catIndex, taskIndex, subIndex) {
    setCategories(prev =>
      prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return {
          ...cat,
          tasks: (cat.tasks || []).map((t, ti) => {
            if (ti !== taskIndex) return t;
            return { ...t, subtasks: (t.subtasks || []).filter((_, si) => si !== subIndex) };
          }),
        };
      })
    );
    markDirty();
  }

  // Copy link to clipboard
  function copyLink(link, id) {
    navigator.clipboard.writeText(link).then(() => {
      setCopiedLink(id);
      setTimeout(() => setCopiedLink(null), 2000);
    });
  }

  // Upload file attachment for a task
  async function handleFileUpload(catIndex, taskIndex, file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
      toast?.error?.('File too large (max 25 MB)');
      return;
    }
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.post('/files/upload-general', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const fileUrl = res.data?.data?.url || res.data?.url;
      const fileName = file.name;
      if (fileUrl) {
        setCategories(prev =>
          prev.map((cat, ci) => {
            if (ci !== catIndex) return cat;
            return {
              ...cat,
              tasks: (cat.tasks || []).map((t, ti) => {
                if (ti !== taskIndex) return t;
                return { ...t, attachments: [...(t.attachments || []), { name: fileName, url: fileUrl }] };
              }),
            };
          })
        );
        markDirty();
        toast?.success?.(`File "${fileName}" attached`);
      }
    } catch (err) {
      console.error('File upload failed:', err);
      toast?.error?.('Failed to upload file');
    }
  }

  // Remove file attachment
  function removeAttachment(catIndex, taskIndex, fileIndex) {
    setCategories(prev =>
      prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return {
          ...cat,
          tasks: (cat.tasks || []).map((t, ti) => {
            if (ti !== taskIndex) return t;
            return { ...t, attachments: (t.attachments || []).filter((_, fi) => fi !== fileIndex) };
          }),
        };
      })
    );
    markDirty();
  }

  // Update category label
  function updateCategoryLabel(catIndex, label) {
    setCategories(prev =>
      prev.map((cat, ci) =>
        ci === catIndex ? { ...cat, label } : cat
      )
    );
    markDirty();
  }

  // Update category time range
  function updateCategoryTime(catIndex, field, value) {
    setCategories(prev =>
      prev.map((cat, ci) =>
        ci === catIndex ? { ...cat, [field]: value } : cat
      )
    );
    markDirty();
  }

  // Stats
  const totalTasks = categories.reduce((sum, cat) => sum + (cat.tasks?.length || 0), 0);
  const doneTasks = categories.reduce(
    (sum, cat) => sum + (cat.tasks?.filter(t => t.done).length || 0),
    0
  );
  const pendingTasks = totalTasks - doneTasks;
  const progressPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  if (loading) {
    return (
      <div className="p-8 space-y-6 animate-pulse">
        <div className="h-20 bg-gray-100 rounded-2xl" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-28 bg-gray-100 rounded-2xl" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-48 bg-gray-100 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 max-w-[1400px] mx-auto">
      {/* ═══ HEADER ═══ */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900 tracking-tight flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
              <Calendar size={20} className="text-white" />
            </div>
            Director's Daily Plan
          </h1>
          <div className="flex items-center gap-2 mt-1 ml-[52px]">
            <span className="text-sm text-gray-500">Managing schedule for</span>
            {directors.length > 1 ? (
              <select
                value={selectedDirectorId || ''}
                onChange={async e => { await saveCurrentPlan(); setSelectedDirectorId(e.target.value); setDirty(false); }}
                className="text-sm font-semibold text-gray-800 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              >
                {(directors || []).map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name} {d.isSuperAdmin ? '(Super Admin)' : d.hierarchyLevel ? `(${d.hierarchyLevel})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-sm font-semibold text-gray-700">{directorName}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 mt-4 sm:mt-0">
          {/* Date Selector */}
          <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-xl p-1 shadow-sm">
            <button
              onClick={goToPrev}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              title="Previous day"
            >
              <ChevronLeft size={16} className="text-gray-600" />
            </button>
            <button
              onClick={goToToday}
              className="flex flex-col items-center px-4 py-1 rounded-lg hover:bg-indigo-50 transition-colors min-w-[140px]"
              title="Go to today"
            >
              <span className="text-sm font-bold text-gray-800">{format(selectedDate, 'MMMM d, yyyy')}</span>
              <span className="text-xs font-medium text-indigo-500">{getRelativeDayLabel(selectedDate)}</span>
            </button>
            <button
              onClick={goToNext}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              title="Next day"
            >
              <ChevronRight size={16} className="text-gray-600" />
            </button>
          </div>

          {/* Export Button */}
          <button onClick={() => setExportConfirm({})} className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-xl border border-indigo-200 transition-all">
            <Download size={16} /> Export
          </button>

          {/* Save Status */}
          {saveStatus === 'saving' && (
            <span className="text-xs text-gray-400 font-medium animate-pulse">Saving...</span>
          )}
          {saveStatus === 'saved' && (
            <span className="text-xs text-emerald-500 font-medium flex items-center gap-1">
              <Check size={12} /> Saved
            </span>
          )}

          {/* Save Button */}
          <button
            onClick={() => handleSave(false)}
            disabled={saving || !dirty}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-sm
              ${dirty
                ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-md'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
          >
            <Save size={16} />
            {saving ? 'Saving...' : 'Save Plan'}
          </button>
        </div>
      </div>

      {/* ═══ STAT CARDS ═══ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          {
            label: 'Total Tasks',
            value: totalTasks,
            gradient: 'from-indigo-500 to-indigo-600',
            icon: Calendar,
          },
          {
            label: 'Completed',
            value: doneTasks,
            gradient: 'from-emerald-500 to-emerald-600',
            icon: Calendar,
          },
          {
            label: 'Pending',
            value: pendingTasks,
            gradient: 'from-amber-500 to-amber-600',
            icon: Clock,
          },
          {
            label: 'Progress',
            value: `${progressPct}%`,
            gradient: 'from-purple-500 to-purple-600',
            icon: Calendar,
            isPct: true,
          },
        ].map((s, i) => (
          <div
            key={i}
            className="bg-white rounded-2xl p-5 border border-gray-100 shadow-sm hover:shadow-md transition-all"
          >
            <div className="flex items-center justify-between mb-3">
              <div
                className={`w-10 h-10 rounded-xl bg-gradient-to-br ${s.gradient} flex items-center justify-center shadow-sm`}
              >
                <s.icon size={18} className="text-white" />
              </div>
              {s.isPct && (
                <span
                  className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    progressPct >= 70
                      ? 'bg-emerald-50 text-emerald-600'
                      : progressPct >= 40
                      ? 'bg-amber-50 text-amber-600'
                      : 'bg-red-50 text-red-600'
                  }`}
                >
                  {progressPct >= 70
                    ? 'On Track'
                    : progressPct >= 40
                    ? 'In Progress'
                    : 'Needs Attention'}
                </span>
              )}
            </div>
            <div className="text-3xl font-extrabold text-gray-900 tracking-tight">
              {s.value}
            </div>
            <div className="text-xs text-gray-500 mt-1 font-medium">{s.label}</div>
          </div>
        ))}
      </div>

      {/* ═══ CUMULATIVE VIEW BANNER (unsaved today) ═══ */}
      {viewMode === 'cumulative' && categories.some(c => c._originDate && c._originDate !== dateStr) && (
        <div className="mb-6 flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-3">
          <AlertTriangle size={18} className="text-amber-500 flex-shrink-0" />
          <div className="flex-1">
            <span className="text-sm font-medium text-amber-800">
              Showing all ongoing tasks accumulated from previous days.
            </span>
            <span className="text-sm text-amber-600 ml-1">Click "Save Plan" to confirm today's plan.</span>
          </div>
          <button
            onClick={() => { markDirty(); handleSave(false); }}
            className="px-4 py-1.5 text-xs font-semibold bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors flex-shrink-0"
          >
            Save Plan
          </button>
        </div>
      )}

      {/* ═══ CATEGORY CARDS ═══ */}
      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="categories" direction="horizontal" type="CARD">
          {(provided) => (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8" ref={provided.innerRef} {...provided.droppableProps}>
        {(displayOrder || []).map((catIndex, displayIdx) => {
          const cat = categories[catIndex];
          if (!cat) return null;
          const catTotal = cat.tasks?.length || 0;
          const catDone = cat.tasks?.filter(t => t.done).length || 0;
          const catPct = catTotal > 0 ? Math.round((catDone / catTotal) * 100) : 0;
          const isNow = catIndex === nowCategoryIndex;

          return (
            <Draggable key={cat.id || `cat-${catIndex}`} draggableId={cat.id || `cat-${catIndex}`} index={displayIdx} isDragDisabled={isNow}>
              {(dragProvided, dragSnapshot) => (
            <div
              ref={dragProvided.innerRef}
              {...dragProvided.draggableProps}
              className={`rounded-2xl border shadow-sm hover:shadow-md transition-all relative overflow-hidden group ${catPct === 100 ? 'bg-emerald-50/50 border-emerald-200' : 'bg-white border-gray-100'} ${isNow ? 'border-emerald-400 ring-2 ring-emerald-200 shadow-emerald-100' : ''} ${dragSnapshot.isDragging ? 'shadow-xl rotate-1' : ''}`}
            >
              {/* Color accent bar */}
              <div
                className="h-1.5 rounded-t-2xl"
                style={{ background: cat.color || '#6366F1' }}
              />

              <div className="p-5">
                {/* Category header */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    {/* Drag handle */}
                    {!isNow && (
                      <div {...dragProvided.dragHandleProps} className="cursor-grab active:cursor-grabbing p-0.5 rounded text-gray-300 hover:text-gray-500 transition-colors" title="Drag to reorder">
                        <GripVertical size={16} />
                      </div>
                    )}
                    {isNow && <div {...dragProvided.dragHandleProps} />}
                    {/* NOW badge */}
                    {isNow && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500 text-white shadow-sm animate-pulse">NOW</span>
                    )}
                    {/* Icon with selector */}
                    <div className="relative">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center text-lg cursor-pointer hover:ring-2 hover:ring-indigo-300 transition-all"
                        style={{ background: (cat.color || '#6366F1') + '18', color: cat.color || '#6366F1' }}
                        onClick={() => setOpenIconSelector(openIconSelector === catIndex ? null : catIndex)}
                        title="Change icon"
                      >
                        {getIcon(cat.icon)}
                      </div>
                      {openIconSelector === catIndex && (
                        <div className="absolute top-12 left-0 z-50 bg-white border border-gray-200 rounded-xl shadow-xl p-3 w-[220px] grid grid-cols-5 gap-1.5">
                          {ICON_OPTIONS.map(iconName => (
                            <button
                              key={iconName}
                              onClick={() => {
                                setCategories(prev => prev.map((c, ci) => ci === catIndex ? { ...c, icon: iconName } : c));
                                markDirty();
                                setOpenIconSelector(null);
                              }}
                              className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all hover:bg-indigo-50 hover:text-indigo-600 ${cat.icon === iconName ? 'bg-indigo-100 text-indigo-600 ring-2 ring-indigo-300' : 'text-gray-500'}`}
                              title={iconName}
                            >
                              {getIcon(iconName, 16)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      <input
                        type="text"
                        value={cat.label}
                        onChange={e => updateCategoryLabel(catIndex, e.target.value)}
                        className="text-sm font-bold text-gray-900 bg-transparent border-none outline-none w-full hover:bg-gray-50 focus:bg-gray-50 rounded px-1 -ml-1 transition-colors"
                      />
                      {/* Origin date label for cards from previous days */}
                      {cat._originDate && cat._originDate !== dateStr && (
                        <span className="text-[10px] text-gray-400 font-medium ml-1">
                          From {format(new Date(cat._originDate + 'T00:00:00'), 'EEE, MMM d')}
                        </span>
                      )}
                      <div className="flex items-center gap-2 mt-1">
                        <Clock size={12} className="text-gray-400" />
                        <input
                          type="time"
                          value={cat.startTime || ''}
                          onChange={e =>
                            updateCategoryTime(catIndex, 'startTime', e.target.value)
                          }
                          className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-1.5 py-0.5 w-[90px] focus:outline-none focus:ring-1 focus:ring-indigo-300"
                        />
                        <span className="text-gray-400 text-xs">-</span>
                        <input
                          type="time"
                          value={cat.endTime || ''}
                          onChange={e =>
                            updateCategoryTime(catIndex, 'endTime', e.target.value)
                          }
                          className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-1.5 py-0.5 w-[90px] focus:outline-none focus:ring-1 focus:ring-indigo-300"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {/* Export card button */}
                    <button onClick={() => setExportConfirm({ catIndex })}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 transition-all opacity-0 group-hover:opacity-100" title="Export this card">
                      <Download size={14} />
                    </button>
                    {/* Delete category button */}
                    <button onClick={() => confirmDeleteCard(catIndex)}
                      className="p-1 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all">
                      <Trash2 size={14} />
                    </button>
                    <div className="text-right">
                      {catPct === 100 && catTotal > 0 && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full mb-1">
                          <Check size={10} /> Completed
                        </span>
                      )}
                      <div
                        className="text-xl font-extrabold"
                        style={{
                          color: catPct === 100 ? '#10B981' : cat.color || '#6366F1',
                        }}
                      >
                        {catPct}%
                      </div>
                      <div className="text-[11px] text-gray-400">
                        {catDone}/{catTotal} done
                      </div>
                    </div>
                  </div>
                </div>

                {/* Color selector (visible on hover) */}
                <div className="flex items-center gap-1.5 mb-3 opacity-0 group-hover:opacity-100 transition-all h-0 group-hover:h-auto group-hover:py-1 overflow-hidden">
                  {COLOR_OPTIONS.map(color => (
                    <button
                      key={color}
                      onClick={() => {
                        setCategories(prev => prev.map((c, ci) => ci === catIndex ? { ...c, color } : c));
                        markDirty();
                      }}
                      className={`w-5 h-5 rounded-full border-2 transition-all hover:scale-125 ${cat.color === color ? 'border-gray-800 scale-110' : 'border-transparent'}`}
                      style={{ background: color }}
                      title={color}
                    />
                  ))}
                </div>

                {/* Progress bar */}
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-4">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${catPct}%`,
                      background: `linear-gradient(90deg, ${cat.color || '#6366F1'}, ${
                        cat.color || '#6366F1'
                      }99)`,
                    }}
                  />
                </div>

                {/* Task list */}
                <Droppable droppableId={`tasks-${catIndex}`} type="TASK">
                  {(taskDropProvided, taskDropSnapshot) => (
                <div className={`space-y-2 mb-3 min-h-[20px] rounded-lg transition-colors ${taskDropSnapshot.isDraggingOver ? 'bg-indigo-50/50' : ''}`} ref={taskDropProvided.innerRef} {...taskDropProvided.droppableProps}>
                  {(cat.tasks || []).map((task, taskIndex) => {
                    const expandKey = `${catIndex}-${taskIndex}`;
                    const isExpanded = expandedTasks[expandKey];
                    const subDone = (task.subtasks || []).filter(s => s.done).length;
                    const subTotal = (task.subtasks || []).length;

                    return (
                      <Draggable key={task.id || `task-${catIndex}-${taskIndex}`} draggableId={task.id || `task-${catIndex}-${taskIndex}`} index={taskIndex}>
                        {(taskDragProvided, taskDragSnapshot) => (
                      <div ref={taskDragProvided.innerRef} {...taskDragProvided.draggableProps}
                        className={`rounded-xl border transition-all ${isExpanded ? 'border-indigo-200 shadow-sm' : 'border-transparent'} ${task.done ? 'bg-gray-50' : 'bg-white'} ${taskDragSnapshot.isDragging ? 'shadow-lg ring-2 ring-indigo-200' : ''}`}>
                        {/* Task header row */}
                        <div className="px-3 py-2 group">
                          <div className="flex items-center gap-2">
                            {/* Task drag handle */}
                            <div {...taskDragProvided.dragHandleProps} className="cursor-grab active:cursor-grabbing p-0.5 rounded text-gray-300 hover:text-gray-500 transition-colors flex-shrink-0">
                              <GripVertical size={14} />
                            </div>

                            {/* Expand toggle */}
                            <button onClick={() => toggleExpand(catIndex, taskIndex)} className="p-0.5 rounded text-gray-400 hover:text-indigo-500 flex-shrink-0">
                              <ChevronDownIcon size={14} className={`transition-transform duration-200 ${isExpanded ? '' : '-rotate-90'}`} />
                            </button>

                            {/* Checkbox */}
                            <button onClick={() => toggleTask(catIndex, taskIndex)}
                              className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all ${task.done ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300 hover:border-indigo-400'}`}>
                              {task.done && <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                            </button>

                            {/* Task text */}
                            <input type="text" value={task.text || task.title || ''} onChange={e => updateTaskText(catIndex, taskIndex, e.target.value)}
                              placeholder="Task name..."
                              className={`flex-1 text-sm bg-transparent border-none outline-none focus:ring-0 min-w-[80px] ${task.done ? 'line-through text-gray-400' : 'text-gray-700'}`} />

                            {/* Priority selector */}
                            <select
                              value={task.priority || 'medium'}
                              onChange={e => { updateTaskField(catIndex, taskIndex, 'priority', e.target.value); markDirty(); }}
                              className={`text-[10px] font-semibold rounded-full px-2 py-0.5 border cursor-pointer outline-none flex-shrink-0 ${getPriorityStyle(task.priority || 'medium').bg} ${getPriorityStyle(task.priority || 'medium').text} ${getPriorityStyle(task.priority || 'medium').border}`}
                            >
                              {PRIORITY_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                            </select>

                            {/* Deadline badge (compact) */}
                            {task.deadline && (() => {
                              const u = getDeadlineUrgency(task.deadline);
                              return u ? <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 ${u.color}`}>{u.label}</span> : null;
                            })()}

                            {/* Task origin date badge */}
                            {task._originDate && task._originDate !== dateStr && (
                              <span className="text-[9px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full flex-shrink-0">
                                {format(new Date(task._originDate + 'T00:00:00'), 'MMM d')}
                              </span>
                            )}

                            {/* View task button */}
                          <button onClick={() => setViewingTask({ catIndex, taskIndex, task, catLabel: cat.label })}
                            className="p-1 rounded-lg text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 transition-all flex-shrink-0" title="View task details">
                            <Eye size={14} />
                          </button>

                          {/* Subtask count badge */}
                          {subTotal > 0 && (
                            <span className="text-[10px] font-medium text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded flex-shrink-0">{subDone}/{subTotal}</span>
                          )}

                          {/* Delete */}
                          <button onClick={() => confirmDeleteTask(catIndex, taskIndex)}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-all flex-shrink-0" title="Remove task">
                            <X size={14} />
                          </button>
                        </div>

                          </div>
                        {/* Expanded detail panel */}
                        {isExpanded && (
                          <div className="px-4 pb-4 pt-3 space-y-3 border-t border-gray-100 ml-6 mr-3">
                            {/* Deadline + Assignee + Delete row */}
                            <div className="flex items-center gap-3 flex-wrap">
                              <div className="flex items-center gap-1.5">
                                <Clock size={11} className="text-gray-400" />
                                <span className="text-[10px] text-gray-400 font-medium">Deadline:</span>
                                <input
                                  type="datetime-local"
                                  value={task.deadline || ''}
                                  onChange={e => { updateTaskField(catIndex, taskIndex, 'deadline', e.target.value); markDirty(); }}
                                  className="text-[10px] text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                                />
                                {task.deadline && (
                                  <button onClick={() => { updateTaskField(catIndex, taskIndex, 'deadline', null); markDirty(); }}
                                    className="p-0.5 rounded text-gray-400 hover:text-red-500 transition-colors" title="Clear deadline">
                                    <X size={11} />
                                  </button>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-gray-400 font-medium">Assignee:</span>
                                <select
                                  value={task.assigneeId || ''}
                                  onChange={e => {
                                    const userId = e.target.value;
                                    const u = directors.find(x => x.id === userId);
                                    updateTaskField(catIndex, taskIndex, 'assigneeId', userId || null);
                                    updateTaskField(catIndex, taskIndex, 'assigneeName', u?.name || null);
                                    markDirty();
                                  }}
                                  className="text-[10px] text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 max-w-[150px] focus:outline-none focus:ring-1 focus:ring-indigo-300"
                                >
                                  <option value="">Select assignee</option>
                                  {(directors || []).map(d => <option key={d.id} value={d.id}>{d.name}{d.isSuperAdmin ? ' (Super Admin)' : d.hierarchyLevel ? ` (${d.hierarchyLevel})` : ''}</option>)}
                                </select>
                              </div>
                              <button onClick={() => confirmDeleteTask(catIndex, taskIndex)}
                                className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-red-500 hover:bg-red-50 border border-red-200 transition-colors">
                                <Trash2 size={11} /> Delete Task
                              </button>
                            </div>
                            {/* Description */}
                            <div>
                              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-1 mb-1">
                                <FileText size={10} /> Description
                              </label>
                              <textarea value={task.description || ''} onChange={e => updateTaskField(catIndex, taskIndex, 'description', e.target.value)}
                                placeholder="Add task description..." rows={2}
                                className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 resize-y placeholder-gray-400" />
                            </div>

                            {/* Link */}
                            <div>
                              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-1 mb-1">
                                <Link2 size={10} /> Important Link
                              </label>
                              <div className="flex items-center gap-1.5">
                                <input type="url" value={task.link || ''} onChange={e => updateTaskField(catIndex, taskIndex, 'link', e.target.value)}
                                  placeholder="https://..." className="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 placeholder-gray-400" />
                                {task.link && (
                                  <button onClick={() => copyLink(task.link, `task-${catIndex}-${taskIndex}`)}
                                    className="p-1.5 rounded-lg bg-gray-100 hover:bg-indigo-100 text-gray-500 hover:text-indigo-600 transition-colors" title="Copy link">
                                    {copiedLink === `task-${catIndex}-${taskIndex}` ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* File Attachments */}
                            <div>
                              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-1 mb-1">
                                <Paperclip size={10} /> Attachments {(task.attachments || []).length > 0 && `(${(task.attachments || []).length})`}
                              </label>
                              <div className="space-y-1 mb-2">
                                {(task.attachments || []).map((att, ai) => (
                                  <div key={ai} className="flex items-center gap-2 bg-gray-50 rounded-lg px-2 py-1.5 group/att">
                                    <Paperclip size={11} className="text-gray-400 flex-shrink-0" />
                                    <span className="text-xs text-gray-700 flex-1 truncate">{att.name}</span>
                                    <a href={`${window.location.protocol}//${window.location.hostname}:5000${att.url}`} target="_blank" rel="noopener noreferrer"
                                      className="text-[10px] text-indigo-500 hover:underline flex-shrink-0">Download</a>
                                    <button onClick={() => removeAttachment(catIndex, taskIndex, ai)}
                                      className="opacity-0 group-hover/att:opacity-100 p-0.5 text-gray-400 hover:text-red-500 transition-all"><X size={11} /></button>
                                  </div>
                                ))}
                              </div>
                              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg cursor-pointer transition-colors">
                                <Paperclip size={12} /> Upload File
                                <input type="file" className="hidden" onChange={e => { if (e.target.files[0]) handleFileUpload(catIndex, taskIndex, e.target.files[0]); e.target.value = ''; }}
                                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.png,.jpg,.jpeg,.gif,.webp" />
                              </label>
                            </div>

                            {/* Subtasks */}
                            <div>
                              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-1 mb-2">
                                <ListChecks size={10} /> Subtasks {subTotal > 0 && `(${subDone}/${subTotal})`}
                              </label>
                              <div className="space-y-1.5">
                                {(task.subtasks || []).map((sub, subIdx) => (
                                  <div key={sub.id || subIdx} className="bg-gray-50 rounded-lg p-2.5 group/sub">
                                    <div className="flex items-center gap-2">
                                      {/* Subtask checkbox */}
                                      <button onClick={() => toggleSubtask(catIndex, taskIndex, subIdx)}
                                        className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${sub.done ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300 hover:border-indigo-400'}`}>
                                        {sub.done && <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                                      </button>
                                      {/* Subtask title */}
                                      <input type="text" value={sub.title} onChange={e => updateSubtaskField(catIndex, taskIndex, subIdx, 'title', e.target.value)}
                                        className={`flex-1 text-xs bg-transparent border-none outline-none min-w-0 ${sub.done ? 'line-through text-gray-400' : 'text-gray-700'}`} />
                                      {/* Subtask timing */}
                                      <input type="time" value={sub.startTime || ''} onChange={e => updateSubtaskField(catIndex, taskIndex, subIdx, 'startTime', e.target.value)}
                                        className="text-[10px] text-gray-500 bg-white border border-gray-200 rounded px-1 py-0.5 w-[68px] focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                                      <span className="text-gray-300 text-[9px]">-</span>
                                      <input type="time" value={sub.endTime || ''} onChange={e => updateSubtaskField(catIndex, taskIndex, subIdx, 'endTime', e.target.value)}
                                        className="text-[10px] text-gray-500 bg-white border border-gray-200 rounded px-1 py-0.5 w-[68px] focus:outline-none focus:ring-1 focus:ring-indigo-300" />
                                      {/* Delete subtask */}
                                      <button onClick={() => deleteSubtask(catIndex, taskIndex, subIdx)}
                                        className="opacity-0 group-hover/sub:opacity-100 p-0.5 rounded text-gray-400 hover:text-red-500 transition-all flex-shrink-0">
                                        <X size={12} />
                                      </button>
                                    </div>
                                    {/* Subtask description */}
                                    <input type="text" value={sub.description || ''} onChange={e => updateSubtaskField(catIndex, taskIndex, subIdx, 'description', e.target.value)}
                                      placeholder="Add description..." className="w-full text-[11px] text-gray-500 bg-transparent border-none outline-none mt-1 ml-6 placeholder-gray-300" />
                                    {/* Subtask link */}
                                    <div className="flex items-center gap-1 mt-1 ml-6">
                                      <input type="url" value={sub.link || ''} onChange={e => updateSubtaskField(catIndex, taskIndex, subIdx, 'link', e.target.value)}
                                        placeholder="Paste link..." className="flex-1 text-[11px] text-indigo-600 bg-transparent border-none outline-none placeholder-gray-300" />
                                      {sub.link && (
                                        <button onClick={() => copyLink(sub.link, `sub-${catIndex}-${taskIndex}-${subIdx}`)}
                                          className="p-0.5 rounded text-gray-400 hover:text-indigo-600 transition-colors" title="Copy link">
                                          {copiedLink === `sub-${catIndex}-${taskIndex}-${subIdx}` ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                              {/* Add subtask input */}
                              <div className="flex items-center gap-1.5 mt-2">
                                <input type="text" placeholder="Add subtask..." value={newSubtaskInputs[expandKey] || ''}
                                  onChange={e => setNewSubtaskInputs(prev => ({ ...prev, [expandKey]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') addSubtask(catIndex, taskIndex); }}
                                  className="flex-1 text-xs bg-white border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 placeholder-gray-400" />
                                <button onClick={() => addSubtask(catIndex, taskIndex)}
                                  disabled={!(newSubtaskInputs[expandKey] || '').trim()}
                                  className={`p-1.5 rounded-lg transition-all ${(newSubtaskInputs[expandKey] || '').trim() ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}>
                                  <Plus size={13} />
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                        )}
                      </Draggable>
                    );
                  })}
                  {taskDropProvided.placeholder}

                  {catTotal === 0 && (
                    <div className="text-center py-4 text-xs text-gray-400">
                      No tasks yet. Add one below.
                    </div>
                  )}
                </div>
                  )}
                </Droppable>

                {/* Add task input */}
                <div className="flex items-center gap-2 mt-2">
                  <input
                    type="text"
                    placeholder="Add a task..."
                    value={newTaskInputs[catIndex] || ''}
                    onChange={e =>
                      setNewTaskInputs(prev => ({
                        ...prev,
                        [catIndex]: e.target.value,
                      }))
                    }
                    onKeyDown={e => {
                      if (e.key === 'Enter') addTask(catIndex);
                    }}
                    className="flex-1 text-sm bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 placeholder-gray-400"
                  />
                  <button
                    onClick={() => addTask(catIndex)}
                    disabled={!(newTaskInputs[catIndex] || '').trim()}
                    className={`p-2 rounded-xl transition-all ${
                      (newTaskInputs[catIndex] || '').trim()
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm'
                        : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    }`}
                    title="Add task"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            </div>
              )}
            </Draggable>
          );
        })}
        {provided.placeholder}

        {/* Add New Category card */}
        <div
          onClick={() => {
            const newCat = { id: Date.now().toString(), label: 'New Category', icon: 'Folder', color: COLOR_OPTIONS[categories.length % COLOR_OPTIONS.length], startTime: '09:00', endTime: '10:00', tasks: [] };
            setCategories(prev => [...prev, newCat]);
            markDirty();
          }}
          className="bg-white rounded-2xl p-5 border-2 border-dashed border-gray-300 hover:border-indigo-400 cursor-pointer flex items-center justify-center min-h-[200px] transition-all hover:bg-indigo-50/30 group">
          <div className="text-center">
            <Plus size={24} className="mx-auto text-gray-400 group-hover:text-indigo-500 mb-2" />
            <span className="text-sm font-semibold text-gray-500 group-hover:text-indigo-600">Add Category</span>
          </div>
        </div>

        {categories.length === 0 && (
          <div className="col-span-full bg-white rounded-2xl border border-gray-100 shadow-sm p-12 text-center">
            <Calendar size={40} className="text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500 font-medium">
              No plan created for this date yet.
            </p>
            <p className="text-xs text-gray-400 mt-1">
              The plan will be populated when the director's schedule is set up.
            </p>
          </div>
        )}
      </div>
          )}
        </Droppable>
      </DragDropContext>

      {/* ═══ NOTES SECTION ═══ */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 mb-8">
        <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
          <Calendar size={16} className="text-indigo-500" />
          Notes & Reminders
        </h3>
        <textarea
          value={notes}
          onChange={e => {
            setNotes(e.target.value);
            markDirty();
          }}
          placeholder="Add notes, reminders, or special instructions for the day..."
          rows={4}
          className="w-full text-sm bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 placeholder-gray-400 resize-y"
        />
      </div>

      {/* ═══ TASK VIEW MODAL ═══ */}
      {viewingTask && (() => {
        const { task, catLabel } = viewingTask;
        const pStyle = getPriorityStyle(task.priority || 'medium');
        const subDone = (task.subtasks || []).filter(s => s.done).length;
        const subTotal = (task.subtasks || []).length;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setViewingTask(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="p-5 border-b border-gray-100">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">{catLabel}</p>
                    <h3 className="text-base font-bold text-gray-900 mt-0.5">{task.text}</h3>
                  </div>
                  <button onClick={() => setViewingTask(null)} className="p-2 rounded-xl hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                    <X size={18} />
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className={`text-[10px] font-semibold rounded-full px-2.5 py-0.5 ${pStyle.bg} ${pStyle.text} ${pStyle.border} border`}>{pStyle.label}</span>
                  {task.done && <span className="text-[10px] font-semibold rounded-full px-2.5 py-0.5 bg-emerald-50 text-emerald-600 border border-emerald-200">Completed</span>}
                  {subTotal > 0 && <span className="text-[10px] font-medium text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded-full">{subDone}/{subTotal} subtasks</span>}
                  {task.deadline && (() => {
                    const u = getDeadlineUrgency(task.deadline);
                    return u ? <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border ${u.color}`}>{u.label}</span> : null;
                  })()}
                  {task.assigneeName && <span className="text-[10px] font-semibold rounded-full px-2.5 py-0.5 bg-blue-50 text-blue-600 border border-blue-200">{task.assigneeName}</span>}
                </div>
              </div>
              <div className="p-5 space-y-4">
                {task.deadline && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Deadline</p>
                    <p className="text-sm text-gray-700">{format(new Date(task.deadline), 'MMM d, yyyy h:mm a')}</p>
                  </div>
                )}
                {task.assigneeName && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Assignee</p>
                    <p className="text-sm text-gray-700">{task.assigneeName}</p>
                  </div>
                )}
                {task.description && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Description</p>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{task.description}</p>
                  </div>
                )}
                {task.link && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Link</p>
                    <a href={task.link} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-600 hover:underline break-all">{task.link}</a>
                  </div>
                )}
                {(task.attachments || []).length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1">Attachments</p>
                    <div className="space-y-1">
                      {(task.attachments || []).map((att, ai) => (
                        <div key={ai} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                          <Paperclip size={12} className="text-gray-400" />
                          <span className="text-xs text-gray-700 flex-1 truncate">{att.name}</span>
                          <a href={`${window.location.protocol}//${window.location.hostname}:5000${att.url}`} target="_blank" rel="noopener noreferrer"
                            className="text-[10px] text-indigo-500 hover:underline">Download</a>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {subTotal > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Subtasks ({subDone}/{subTotal})</p>
                    <div className="space-y-1.5">
                      {(task.subtasks || []).map((sub, si) => (
                        <div key={sub.id || si} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                          <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${sub.done ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300'}`}>
                            {sub.done && <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.5 6L5 8.5L9.5 3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                          </div>
                          <span className={`text-xs flex-1 ${sub.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>{sub.title}</span>
                          {sub.description && <span className="text-[10px] text-gray-400 truncate max-w-[120px]">{sub.description}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {!task.description && !task.link && !task.deadline && !task.assigneeName && subTotal === 0 && (task.attachments || []).length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">No additional details for this task.</p>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══ FLOATING SAVE INDICATOR ═══ */}
      {dirty && (
        <div className="fixed bottom-6 right-6 z-50">
          <button
            onClick={() => handleSave(false)}
            disabled={saving}
            className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-2xl shadow-lg hover:bg-indigo-700 transition-all hover:shadow-xl"
          >
            <Save size={18} />
            <span className="text-sm font-semibold">
              {saving ? 'Saving...' : 'Unsaved Changes - Save Plan'}
            </span>
          </button>
        </div>
      )}

      {/* ═══ DELETE CONFIRMATION MODAL ═══ */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden" onClick={e => e.stopPropagation()}
            style={{ animation: 'voicePanelSlideIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both' }}>
            <div className="p-5 text-center">
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
                <Trash2 size={22} className="text-red-500" />
              </div>
              <h3 className="text-base font-bold text-gray-900">
                {deleteConfirm.type === 'card' ? 'Delete Category Card?' : 'Delete Task?'}
              </h3>
              <p className="text-sm text-gray-500 mt-2">
                {deleteConfirm.type === 'card'
                  ? `"${deleteConfirm.catLabel}" has ${deleteConfirm.taskCount} task${deleteConfirm.taskCount !== 1 ? 's' : ''}. This will remove the card and all its tasks.`
                  : `Remove "${deleteConfirm.taskText}" from ${deleteConfirm.catLabel}?`}
              </p>
              <p className="text-xs text-gray-400 mt-1">You can undo this within 5 seconds (Ctrl+Z)</p>
            </div>
            <div className="flex border-t border-gray-100">
              <button onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button onClick={() => deleteConfirm.type === 'card' ? executeDeleteCard(deleteConfirm.catIndex) : executeDeleteTask(deleteConfirm.catIndex, deleteConfirm.taskIndex)}
                className="flex-1 py-3 text-sm font-bold text-red-600 hover:bg-red-50 transition-colors border-l border-gray-100">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ EXPORT CONFIRMATION MODAL ═══ */}
      {exportConfirm !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setExportConfirm(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden" onClick={e => e.stopPropagation()}
            style={{ animation: 'voicePanelSlideIn 200ms cubic-bezier(0.16, 1, 0.3, 1) both' }}>
            <div className="p-5 text-center">
              <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center mx-auto mb-3">
                <Download size={22} className="text-indigo-500" />
              </div>
              <h3 className="text-base font-bold text-gray-900">Export Director Plan</h3>
              <p className="text-sm text-gray-500 mt-2">
                {exportConfirm.catIndex !== undefined
                  ? `Export "${categories[exportConfirm.catIndex]?.label}" card to Excel`
                  : 'Choose what to export'}
              </p>
            </div>
            <div className="px-5 pb-5 space-y-2">
              {exportConfirm.catIndex !== undefined ? (
                <button onClick={() => exportToExcel(exportConfirm.catIndex)}
                  className="w-full py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl transition-colors">
                  Export This Card
                </button>
              ) : (
                <>
                  <button onClick={() => exportToExcel(null)}
                    className="w-full py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl transition-colors">
                    Export Full Plan
                  </button>
                </>
              )}
              <button onClick={() => setExportConfirm(null)}
                className="w-full py-2 text-sm font-medium text-gray-500 hover:bg-gray-50 rounded-xl transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
