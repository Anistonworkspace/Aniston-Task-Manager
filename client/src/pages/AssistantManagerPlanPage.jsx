import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Calendar, Save, Plus, X, Clock, ChevronLeft, ChevronRight, ChevronDown as ChevronDownIcon, Trash2, Edit3, Hammer, Receipt, Package, ClipboardList, Scale, FlaskConical, Factory, Bot, Monitor, Palette, Folder, Star, Target, BookOpen, Phone, Mail, Coffee, Briefcase as BriefcaseIcon, Paintbrush, Link2, Copy, Check, ListChecks, FileText, Paperclip, Download, Eye, GripVertical } from 'lucide-react';
import { DragDropContext, Droppable, Draggable } from 'react-beautiful-dnd';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { useToast } from '../components/common/Toast';
import useSocket from '../hooks/useSocket';
import { format, addDays, subDays } from 'date-fns';

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

export default function AssistantManagerPlanPage() {
  const { isAssistantManager, isSuperAdmin } = useAuth();
  const toast = useToast();

  const [selectedDate, setSelectedDate] = useState(new Date());
  const [categories, setCategories] = useState([]);
  const [notes, setNotes] = useState('');
  const [directorName, setDirectorName] = useState('');
  const [loading, setLoading] = useState(true);
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
  const [users, setUsers] = useState([]);

  const autoSaveTimer = useRef(null);

  const dateStr = format(selectedDate, 'yyyy-MM-dd');
  const displayDate = format(selectedDate, 'EEEE, MMMM d, yyyy');

  // Load available directors on mount
  useEffect(() => {
    api.get('/director-plan/directors').then(res => {
      const dirs = res.data?.data || [];
      setDirectors(dirs);
      if (dirs.length > 0 && !selectedDirectorId) {
        setSelectedDirectorId(dirs[0].id);
      }
    }).catch((e) => { console.error('Failed to load directors:', e); });
  }, []);

  // Load users for assignee selector
  useEffect(() => {
    api.get('/auth/users').then(res => {
      setUsers(res.data?.data || res.data || []);
    }).catch(() => {});
  }, []);

  // Load plan for selected date + director
  const loadPlan = useCallback(async () => {
    try {
      setLoading(true);
      const dirParam = selectedDirectorId ? `?directorId=${selectedDirectorId}` : '';
      const res = await api.get(`/director-plan/${dateStr}${dirParam}`);
      const plan = res.data?.data || res.data;
      setCategories(plan.categories || []);
      setNotes(plan.notes || '');
      setDirectorName(plan.directorName || 'Director');
      setDirty(false);
    } catch (err) {
      console.error('Failed to load director plan:', err);
      toast?.error?.('Failed to load plan');
    } finally {
      setLoading(false);
    }
  }, [dateStr, selectedDirectorId]);

  useEffect(() => {
    if (selectedDirectorId) loadPlan();
  }, [loadPlan]);

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

  // Auto-save after 30 seconds of inactivity
  useEffect(() => {
    if (!dirty) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      handleSave(true);
    }, 30000);
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
      await api.put(`/director-plan/${dateStr}`, { categories, notes, directorId: selectedDirectorId });
      setDirty(false);
      if (!isAutoSave) {
        toast?.success?.('Plan saved successfully');
      }
    } catch (err) {
      console.error('Failed to save plan:', err);
      toast?.error?.('Failed to save plan');
    } finally {
      setSaving(false);
    }
  }

  // Date navigation
  function goToPrev() {
    setSelectedDate(prev => subDays(prev, 1));
  }
  function goToNext() {
    setSelectedDate(prev => addDays(prev, 1));
  }
  function goToToday() {
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
          tasks: cat.tasks.map((t, ti) =>
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
          tasks: cat.tasks.map((t, ti) =>
            ti === taskIndex ? { ...t, text } : t
          ),
        };
      })
    );
    markDirty();
  }

  // Delete task (with confirmation)
  function deleteTask(catIndex, taskIndex) {
    if (!window.confirm('Are you sure you want to remove this task?')) return;
    setCategories(prev =>
      prev.map((cat, ci) => {
        if (ci !== catIndex) return cat;
        return {
          ...cat,
          tasks: cat.tasks.filter((_, ti) => ti !== taskIndex),
        };
      })
    );
    markDirty();
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
          tasks: [...cat.tasks, {
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
        return { ...cat, tasks: cat.tasks.map((t, ti) => ti === taskIndex ? { ...t, [field]: value } : t) };
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
          tasks: cat.tasks.map((t, ti) => {
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
          tasks: cat.tasks.map((t, ti) => {
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
          tasks: cat.tasks.map((t, ti) => {
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
          tasks: cat.tasks.map((t, ti) => {
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
              tasks: cat.tasks.map((t, ti) => {
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
          tasks: cat.tasks.map((t, ti) => {
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
                onChange={e => { setSelectedDirectorId(e.target.value); setDirty(false); }}
                className="text-sm font-semibold text-gray-800 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              >
                {directors.map(d => (
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
          {/* Date Navigation */}
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
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 hover:bg-indigo-50 transition-colors"
            >
              Today
            </button>
            <button
              onClick={goToNext}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              title="Next day"
            >
              <ChevronRight size={16} className="text-gray-600" />
            </button>
          </div>

          {/* Date Display */}
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-2 shadow-sm">
            <span className="text-sm font-semibold text-gray-700">{displayDate}</span>
          </div>

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

      {/* ═══ CATEGORY CARDS ═══ */}
      <DragDropContext onDragEnd={onDragEnd}>
        <Droppable droppableId="categories" direction="horizontal" type="CARD">
          {(provided) => (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8" ref={provided.innerRef} {...provided.droppableProps}>
        {displayOrder.map((catIndex, displayIdx) => {
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
              className={`bg-white rounded-2xl border shadow-sm hover:shadow-md transition-all relative overflow-hidden group ${isNow ? 'border-emerald-400 ring-2 ring-emerald-200 shadow-emerald-100' : 'border-gray-100'} ${dragSnapshot.isDragging ? 'shadow-xl rotate-1' : ''}`}
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
                    {/* Delete category button */}
                    <button onClick={() => { setCategories(prev => prev.filter((_, i) => i !== catIndex)); markDirty(); }}
                      className="p-1 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all">
                      <Trash2 size={14} />
                    </button>
                    <div className="text-right">
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
                        <div className="flex items-center gap-2 px-3 py-2.5 group">
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
                          <input type="text" value={task.text} onChange={e => updateTaskText(catIndex, taskIndex, e.target.value)}
                            className={`flex-1 text-sm bg-transparent border-none outline-none focus:ring-0 min-w-0 ${task.done ? 'line-through text-gray-400' : 'text-gray-700'}`} />

                          {/* Priority selector */}
                          <select
                            value={task.priority || 'medium'}
                            onChange={e => { updateTaskField(catIndex, taskIndex, 'priority', e.target.value); markDirty(); }}
                            className={`text-[10px] font-semibold rounded-full px-2 py-0.5 border cursor-pointer outline-none flex-shrink-0 ${getPriorityStyle(task.priority || 'medium').bg} ${getPriorityStyle(task.priority || 'medium').text} ${getPriorityStyle(task.priority || 'medium').border}`}
                          >
                            {PRIORITY_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                          </select>

                          {/* Deadline */}
                          <input
                            type="datetime-local"
                            value={task.deadline || ''}
                            onChange={e => updateTaskField(catIndex, taskIndex, 'deadline', e.target.value)}
                            className="text-[10px] text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-1.5 py-0.5 w-[140px] focus:outline-none focus:ring-1 focus:ring-indigo-300 flex-shrink-0"
                          />
                          {task.deadline && (() => {
                            const u = getDeadlineUrgency(task.deadline);
                            return u ? <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border flex-shrink-0 ${u.color}`}>{u.label}</span> : null;
                          })()}
                          {task.deadline && (
                            <button onClick={() => updateTaskField(catIndex, taskIndex, 'deadline', null)}
                              className="p-0.5 rounded text-gray-400 hover:text-red-500 transition-colors flex-shrink-0" title="Clear deadline">
                              <X size={12} />
                            </button>
                          )}

                          {/* Assignee */}
                          <select
                            value={task.assigneeId || ''}
                            onChange={e => {
                              const userId = e.target.value;
                              const user = users.find(u => u.id === userId);
                              updateTaskField(catIndex, taskIndex, 'assigneeId', userId || null);
                              updateTaskField(catIndex, taskIndex, 'assigneeName', user?.name || null);
                            }}
                            className="text-[10px] text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-1.5 py-0.5 max-w-[100px] focus:outline-none focus:ring-1 focus:ring-indigo-300 flex-shrink-0"
                          >
                            <option value="">Unassigned</option>
                            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                          </select>

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
                          <button onClick={() => deleteTask(catIndex, taskIndex)}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-all flex-shrink-0" title="Remove task">
                            <X size={14} />
                          </button>
                        </div>

                        {/* Expanded detail panel */}
                        {isExpanded && (
                          <div className="px-4 pb-4 pt-1 space-y-3 border-t border-gray-100 ml-6 mr-3">
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
                      {task.attachments.map((att, ai) => (
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
                      {task.subtasks.map((sub, si) => (
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
    </div>
  );
}
