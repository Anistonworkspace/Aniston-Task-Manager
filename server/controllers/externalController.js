const { User, Department, Task, Board, Subtask, WorkLog } = require('../models');
const { Op } = require('sequelize');

// Fields to NEVER expose to external consumers
const EXCLUDED_FIELDS = ['password', 'teamsAccessToken', 'teamsRefreshToken', 'teamsTokenExpiry'];

// ─── Helpers ──────────────────────────────────────────────────

function getWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun … 6=Sat
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMon);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return {
    start: monday.toISOString().slice(0, 10),
    end: sunday.toISOString().slice(0, 10),
    startDate: monday,
    endDate: sunday,
  };
}

function computeTaskStats(tasks) {
  const today = new Date().toISOString().slice(0, 10);
  const total = tasks.length;
  let pending = 0, inProgress = 0, done = 0, stuck = 0, review = 0, overdue = 0;

  for (const t of tasks) {
    const s = t.status;
    if (s === 'done') { done++; continue; }
    if (s === 'not_started' || s === 'ready_to_start') pending++;
    else if (s === 'working_on_it' || s === 'in_progress') inProgress++;
    else if (s === 'waiting_for_review' || s === 'review' || s === 'pending_deploy') review++;
    else if (s === 'stuck') stuck++;

    if (t.dueDate && t.dueDate < today) overdue++;
  }

  return {
    total,
    pending,
    inProgress,
    done,
    stuck,
    review,
    overdue,
    completionRate: total > 0 ? Math.round((done / total) * 100 * 10) / 10 : 0,
  };
}

function shapeTask(t, includeSubtasks = false) {
  const obj = {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    startDate: t.startDate,
    boardName: t.board?.name || null,
    boardId: t.boardId,
    progress: t.progress,
    estimatedHours: t.estimatedHours,
    actualHours: t.actualHours,
    tags: t.tags,
    createdAt: t.createdAt,
  };
  if (includeSubtasks && t.subtasks) {
    obj.subtasks = t.subtasks.map((s) => ({ id: s.id, title: s.title, status: s.status }));
  }
  return obj;
}

// ─── GET /api/external/employees ──────────────────────────────

const getAllEmployees = async (req, res) => {
  try {
    const {
      search,
      role,
      department,
      status = 'active',
      includeTasks = 'true',
      page = 1,
      limit = 50,
    } = req.query;

    const wantTasks = includeTasks !== 'false';
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    // Build where clause
    const where = {};
    if (status === 'active') { where.isActive = true; where.accountStatus = 'approved'; }
    else if (status === 'inactive') { where.isActive = false; }

    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (role) where.role = role;
    if (department) where.department = { [Op.iLike]: `%${department}%` };

    // Fetch users
    const { count, rows } = await User.findAndCountAll({
      where,
      attributes: { exclude: EXCLUDED_FIELDS },
      include: [
        { model: User, as: 'manager', attributes: ['id', 'name', 'email', 'role'], required: false },
        { model: Department, as: 'departmentRef', attributes: ['id', 'name', 'color'], required: false },
      ],
      order: [['name', 'ASC']],
      limit: limitNum,
      offset,
    });

    // Batch-fetch task data if requested
    let tasksByUser = {};
    let worklogsByUser = {};
    const week = getWeekRange();

    if (wantTasks && rows.length > 0) {
      const userIds = rows.map((u) => u.id);

      // All non-archived tasks for these users
      const allTasks = await Task.findAll({
        where: { assignedTo: { [Op.in]: userIds }, isArchived: false },
        include: [
          { model: Board, as: 'board', attributes: ['id', 'name'] },
          { model: Subtask, as: 'subtasks', attributes: ['id', 'title', 'status'], required: false },
        ],
        order: [['dueDate', 'ASC NULLS LAST'], ['createdAt', 'DESC']],
      });

      // Group tasks by assignedTo
      for (const t of allTasks) {
        const uid = t.assignedTo;
        if (!tasksByUser[uid]) tasksByUser[uid] = [];
        tasksByUser[uid].push(t);
      }

      // Worklogs for current week
      const allWorklogs = await WorkLog.findAll({
        where: {
          userId: { [Op.in]: userIds },
          date: { [Op.between]: [week.start, week.end] },
        },
        include: [{ model: Task, as: 'task', attributes: ['id', 'title'] }],
        order: [['date', 'DESC']],
      });

      for (const w of allWorklogs) {
        const uid = w.userId;
        if (!worklogsByUser[uid]) worklogsByUser[uid] = [];
        worklogsByUser[uid].push(w);
      }
    }

    // Shape response
    const employees = rows.map((user) => {
      const json = user.toJSON();
      const emp = {
        ...json,
        managerName: json.manager?.name || null,
        managerEmail: json.manager?.email || null,
        departmentName: json.departmentRef?.name || json.department || null,
        departmentColor: json.departmentRef?.color || null,
      };

      if (wantTasks) {
        const userTasks = tasksByUser[user.id] || [];
        emp.taskStats = computeTaskStats(userTasks);

        // Active tasks (not done)
        emp.activeTasks = userTasks
          .filter((t) => t.status !== 'done')
          .map((t) => shapeTask(t, true));

        // Weekly review
        const weekTasks = userTasks.filter((t) => {
          const up = new Date(t.updatedAt);
          return up >= week.startDate && up <= week.endDate;
        });
        const weekWorklogs = (worklogsByUser[user.id] || []).map((w) => ({
          date: w.date,
          content: w.content,
          taskTitle: w.task?.title || null,
        }));
        const weekSummary = computeTaskStats(weekTasks);

        emp.weeklyReview = {
          weekRange: { start: week.start, end: week.end },
          summary: { total: weekSummary.total, done: weekSummary.done, working: weekSummary.inProgress, stuck: weekSummary.stuck },
          tasks: weekTasks.map((t) => shapeTask(t, false)),
          worklogs: weekWorklogs,
        };
      }

      return emp;
    });

    res.json({
      success: true,
      data: {
        employees,
        pagination: { page: pageNum, limit: limitNum, total: count, totalPages: Math.ceil(count / limitNum) },
      },
    });
  } catch (error) {
    console.error('[External] getAllEmployees error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching employees.' });
  }
};

// ─── GET /api/external/employees/:id ──────────────────────────

const getEmployeeById = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findByPk(id, {
      attributes: { exclude: EXCLUDED_FIELDS },
      include: [
        { model: User, as: 'manager', attributes: ['id', 'name', 'email', 'role'], required: false },
        { model: Department, as: 'departmentRef', attributes: ['id', 'name', 'color'], required: false },
      ],
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Employee not found.' });
    }

    const json = user.toJSON();
    const employee = {
      ...json,
      managerName: json.manager?.name || null,
      managerEmail: json.manager?.email || null,
      departmentName: json.departmentRef?.name || json.department || null,
      departmentColor: json.departmentRef?.color || null,
    };

    // Fetch all tasks for this employee
    const tasks = await Task.findAll({
      where: { assignedTo: id, isArchived: false },
      include: [
        { model: Board, as: 'board', attributes: ['id', 'name'] },
        { model: Subtask, as: 'subtasks', attributes: ['id', 'title', 'status'], required: false },
      ],
      order: [['dueDate', 'ASC NULLS LAST'], ['createdAt', 'DESC']],
    });

    employee.taskStats = computeTaskStats(tasks);

    // Active tasks with subtasks
    employee.activeTasks = tasks
      .filter((t) => t.status !== 'done')
      .map((t) => shapeTask(t, true));

    // Weekly review
    const week = getWeekRange();
    const weekTasks = tasks.filter((t) => {
      const up = new Date(t.updatedAt);
      return up >= week.startDate && up <= week.endDate;
    });

    // Recent worklogs (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentWorklogs = await WorkLog.findAll({
      where: {
        userId: id,
        date: { [Op.gte]: sevenDaysAgo.toISOString().slice(0, 10) },
      },
      include: [{ model: Task, as: 'task', attributes: ['id', 'title'] }],
      order: [['date', 'DESC']],
    });

    employee.weeklyReview = {
      weekRange: { start: week.start, end: week.end },
      summary: {
        total: computeTaskStats(weekTasks).total,
        done: computeTaskStats(weekTasks).done,
        working: computeTaskStats(weekTasks).inProgress,
        stuck: computeTaskStats(weekTasks).stuck,
      },
      tasks: weekTasks.map((t) => shapeTask(t, true)),
      worklogs: recentWorklogs.map((w) => ({
        date: w.date,
        content: w.content,
        taskTitle: w.task?.title || null,
      })),
    };

    // Completion trend (last 14 days)
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const doneTasks = tasks.filter((t) => {
      if (t.status !== 'done') return false;
      const up = new Date(t.updatedAt);
      return up >= fourteenDaysAgo;
    });
    const trendMap = {};
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      trendMap[d.toISOString().slice(0, 10)] = 0;
    }
    for (const t of doneTasks) {
      const dateKey = new Date(t.updatedAt).toISOString().slice(0, 10);
      if (trendMap[dateKey] !== undefined) trendMap[dateKey]++;
    }
    employee.completionTrend = Object.entries(trendMap)
      .map(([date, completedCount]) => ({ date, completedCount }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ success: true, data: { employee } });
  } catch (error) {
    console.error('[External] getEmployeeById error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching employee.' });
  }
};

module.exports = { getAllEmployees, getEmployeeById };
