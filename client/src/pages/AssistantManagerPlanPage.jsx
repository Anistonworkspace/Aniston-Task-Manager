import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Calendar, Save, Plus, X, Clock, ChevronLeft, ChevronRight, Trash2, Edit3, Hammer, Receipt, Package, ClipboardList, Scale, FlaskConical, Factory, Bot, Monitor, Palette, Folder, Star, Target, BookOpen, Phone, Mail, Coffee, Briefcase as BriefcaseIcon, Paintbrush } from 'lucide-react';
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

  const autoSaveTimer = useRef(null);

  const dateStr = format(selectedDate, 'yyyy-MM-dd');
  const displayDate = format(selectedDate, 'EEEE, MMMM d, yyyy');

  // Load plan for selected date
  const loadPlan = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get(`/director-plan/${dateStr}`);
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
  }, [dateStr]);

  useEffect(() => {
    loadPlan();
  }, [loadPlan]);

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
      await api.put(`/director-plan/${dateStr}`, { categories, notes });
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

  // Delete task
  function deleteTask(catIndex, taskIndex) {
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
          tasks: [...cat.tasks, { text, done: false, time: now }],
        };
      })
    );
    setNewTaskInputs(prev => ({ ...prev, [catIndex]: '' }));
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
          <p className="text-sm text-gray-500 mt-1 ml-[52px]">
            Managing schedule for <span className="font-semibold text-gray-700">{directorName}</span>
          </p>
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
        {categories.map((cat, catIndex) => {
          const catTotal = cat.tasks?.length || 0;
          const catDone = cat.tasks?.filter(t => t.done).length || 0;
          const catPct = catTotal > 0 ? Math.round((catDone / catTotal) * 100) : 0;

          return (
            <div
              key={cat.id || catIndex}
              className="bg-white rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-all relative overflow-hidden group"
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
                <div className="space-y-2 mb-3">
                  {(cat.tasks || []).map((task, taskIndex) => (
                    <div
                      key={taskIndex}
                      className={`flex items-center gap-3 group rounded-xl px-3 py-2.5 transition-all ${
                        task.done ? 'bg-gray-50' : 'bg-white hover:bg-gray-50'
                      }`}
                    >
                      {/* Checkbox */}
                      <button
                        onClick={() => toggleTask(catIndex, taskIndex)}
                        className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                          task.done
                            ? 'border-emerald-500 bg-emerald-500'
                            : 'border-gray-300 hover:border-indigo-400'
                        }`}
                      >
                        {task.done && (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 12 12"
                            fill="none"
                          >
                            <path
                              d="M2.5 6L5 8.5L9.5 3.5"
                              stroke="white"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </button>

                      {/* Editable text */}
                      <input
                        type="text"
                        value={task.text}
                        onChange={e =>
                          updateTaskText(catIndex, taskIndex, e.target.value)
                        }
                        className={`flex-1 text-sm bg-transparent border-none outline-none focus:ring-0 ${
                          task.done
                            ? 'line-through text-gray-400'
                            : 'text-gray-700'
                        }`}
                      />

                      {/* Time badge */}
                      {task.time && (
                        <span className="text-[10px] text-gray-400 font-mono flex-shrink-0">
                          {task.time}
                        </span>
                      )}

                      {/* Delete button */}
                      <button
                        onClick={() => deleteTask(catIndex, taskIndex)}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-all flex-shrink-0"
                        title="Remove task"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}

                  {catTotal === 0 && (
                    <div className="text-center py-4 text-xs text-gray-400">
                      No tasks yet. Add one below.
                    </div>
                  )}
                </div>

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
          );
        })}

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
