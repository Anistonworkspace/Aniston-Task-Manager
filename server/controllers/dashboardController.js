const { Task, Board, User, Activity, WorkLog, Subtask } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const { buildPendingPriorityOrder } = require('../utils/taskPrioritization');

/**
 * GET /api/dashboard/stats?boardId=...
 * Returns aggregated stats for dashboard. Admin sees all boards, manager sees their boards.
 */
const getDashboardStats = async (req, res) => {
  try {
    const { boardId } = req.query;

    // Determine which boards to include
    let boardFilter = {};
    if (boardId) {
      boardFilter = { boardId };
    }

    const taskWhere = { isArchived: false, ...boardFilter };

    // If member, only their tasks
    if (req.user.role === 'member') {
      taskWhere.assignedTo = req.user.id;
    }

    const tasks = await Task.findAll({
      where: taskWhere,
      include: [
        { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'] },
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
      ],
      raw: false,
    });

    // Status breakdown
    const statusCounts = {};
    const priorityCounts = {};
    const memberStats = {};
    let overdue = 0;
    const today = new Date().toISOString().slice(0, 10);

    tasks.forEach(t => {
      const plain = t.toJSON();
      // Status counts
      statusCounts[plain.status] = (statusCounts[plain.status] || 0) + 1;
      // Priority counts
      priorityCounts[plain.priority] = (priorityCounts[plain.priority] || 0) + 1;
      // Overdue
      if (plain.dueDate && plain.dueDate < today && plain.status !== 'done') overdue++;
      // Per-member stats
      const memberId = plain.assignedTo || 'unassigned';
      const memberName = plain.assignee?.name || 'Unassigned';
      const memberAvatar = plain.assignee?.avatar || null;
      if (!memberStats[memberId]) {
        memberStats[memberId] = { id: memberId, name: memberName, avatar: memberAvatar, total: 0, done: 0, working: 0, stuck: 0, overdue: 0 };
      }
      memberStats[memberId].total++;
      if (plain.status === 'done') memberStats[memberId].done++;
      if (plain.status === 'working_on_it') memberStats[memberId].working++;
      if (plain.status === 'stuck') memberStats[memberId].stuck++;
      if (plain.dueDate && plain.dueDate < today && plain.status !== 'done') memberStats[memberId].overdue++;
    });

    // Recent activity (last 20)
    const activityWhere = {};
    if (boardId) activityWhere.boardId = boardId;
    if (req.user.role === 'member') {
      const myTaskIds = tasks.map(t => t.id);
      activityWhere.taskId = { [Op.in]: myTaskIds };
    }

    const recentActivity = await Activity.findAll({
      where: activityWhere,
      include: [{ model: User, as: 'actor', attributes: ['id', 'name', 'avatar'] }],
      order: [['createdAt', 'DESC']],
      limit: 20,
    });

    // Recent work logs (last 15)
    const worklogWhere = {};
    if (boardId) {
      const boardTaskIds = tasks.map(t => t.id);
      worklogWhere.taskId = { [Op.in]: boardTaskIds };
    }
    if (req.user.role === 'member') {
      worklogWhere.userId = req.user.id;
    }

    const recentWorklogs = await WorkLog.findAll({
      where: worklogWhere,
      include: [
        { model: User, as: 'author', attributes: ['id', 'name', 'avatar'] },
        { model: Task, as: 'task', attributes: ['id', 'title'] },
      ],
      order: [['date', 'DESC'], ['createdAt', 'DESC']],
      limit: 15,
    });

    // Board summary (if not filtering by single board)
    let boards = [];
    if (!boardId && req.user.role !== 'member') {
      boards = await Board.findAll({
        where: { isArchived: false },
        attributes: ['id', 'name', 'color'],
        include: [{ model: Task, as: 'tasks', attributes: ['id', 'status'], where: { isArchived: false }, required: false }],
      });
      boards = boards.map(b => {
        const plain = b.toJSON();
        const boardTasks = plain.tasks || [];
        return {
          id: plain.id,
          name: plain.name,
          color: plain.color,
          totalTasks: boardTasks.length,
          doneTasks: boardTasks.filter(t => t.status === 'done').length,
        };
      });
    }

    // Overdue tasks list (top 10)
    const overdueTasks = tasks
      .filter(t => t.dueDate && t.dueDate < today && t.status !== 'done')
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 10)
      .map(t => {
        const plain = t.toJSON();
        const daysOverdue = Math.floor((new Date(today) - new Date(plain.dueDate)) / (1000 * 60 * 60 * 24));
        return { ...plain, daysOverdue };
      });

    // Weekly completion trend (last 14 days)
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const completedRecently = tasks.filter(t =>
      t.status === 'done' && t.updatedAt && t.updatedAt.toISOString().slice(0, 10) >= twoWeeksAgo
    );
    const completionTrend = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      completionTrend[d] = 0;
    }
    completedRecently.forEach(t => {
      const d = t.updatedAt.toISOString().slice(0, 10);
      if (completionTrend[d] !== undefined) completionTrend[d]++;
    });
    const trendData = Object.entries(completionTrend).map(([date, count]) => ({ date, count }));

    // Workload per member (tasks count bar chart)
    const workloadData = Object.values(memberStats)
      .filter(m => m.id !== 'unassigned')
      .map(m => ({ name: m.name, active: m.total - m.done, done: m.done, stuck: m.stuck, overdue: m.overdue }))
      .sort((a, b) => b.active - a.active);

    res.json({
      success: true,
      data: {
        summary: {
          totalTasks: tasks.length,
          done: statusCounts.done || 0,
          working: statusCounts.working_on_it || 0,
          stuck: statusCounts.stuck || 0,
          notStarted: statusCounts.not_started || 0,
          overdue,
        },
        statusCounts,
        priorityCounts,
        memberStats: Object.values(memberStats).sort((a, b) => b.total - a.total),
        recentActivity,
        recentWorklogs,
        boards,
        overdueTasks,
        trendData,
        workloadData,
      },
    });
  } catch (error) {
    console.error('[Dashboard] Stats error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching dashboard stats.' });
  }
};

/**
 * GET /api/dashboard/member/:userId/tasks?boardId=...
 * Returns all tasks for a specific member, grouped by status.
 */
const getMemberTasks = async (req, res) => {
  try {
    const { userId } = req.params;
    const { boardId } = req.query;

    const member = await User.findByPk(userId, {
      attributes: ['id', 'name', 'email', 'avatar', 'role', 'department', 'designation'],
    });
    if (!member) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const taskWhere = { assignedTo: userId, isArchived: false };
    if (boardId) taskWhere.boardId = boardId;

    const tasks = await Task.findAll({
      where: taskWhere,
      include: [
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
        { model: User, as: 'creator', attributes: ['id', 'name', 'avatar'] },
        { model: Subtask, as: 'subtasks', attributes: ['id', 'title', 'status'] },
      ],
      order: buildPendingPriorityOrder(),
    });

    const today = new Date().toISOString().slice(0, 10);
    const summary = { total: tasks.length, done: 0, working: 0, stuck: 0, notStarted: 0, overdue: 0 };
    tasks.forEach(t => {
      if (t.status === 'done') summary.done++;
      else if (t.status === 'working_on_it') summary.working++;
      else if (t.status === 'stuck') summary.stuck++;
      else if (t.status === 'not_started') summary.notStarted++;
      if (t.dueDate && t.dueDate < today && t.status !== 'done') summary.overdue++;
    });

    res.json({
      success: true,
      data: { member, tasks, summary },
    });
  } catch (error) {
    console.error('[Dashboard] getMemberTasks error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching member tasks.' });
  }
};

/**
 * GET /api/dashboard/enterprise
 * Enterprise team dashboard data — workload heatmap, SLA, productivity, pending approvals
 */
const getEnterpriseDashboard = async (req, res) => {
  try {
    const { Workspace, AccessRequest, Announcement } = require('../models');

    const today = new Date().toISOString().slice(0, 10);
    const taskWhere = { isArchived: false };

    if (req.user.role === 'member') {
      taskWhere.assignedTo = req.user.id;
    }

    const tasks = await Task.findAll({
      where: taskWhere,
      include: [
        { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar', 'email', 'role'] },
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
      ],
    });

    // Team members grid
    const users = await User.findAll({
      where: { isActive: true },
      attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation', 'department'],
    });

    const memberGrid = users.map(u => {
      const userTasks = tasks.filter(t => t.assignedTo === u.id);
      const overdue = userTasks.filter(t => t.dueDate && t.dueDate < today && t.status !== 'done').length;
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        avatar: u.avatar,
        role: u.role,
        designation: u.designation,
        totalTasks: userTasks.length,
        doneTasks: userTasks.filter(t => t.status === 'done').length,
        workingTasks: userTasks.filter(t => t.status === 'working_on_it').length,
        stuckTasks: userTasks.filter(t => t.status === 'stuck').length,
        overdueTasks: overdue,
      };
    });

    // Workload heatmap data (employees x days of week)
    const heatmapData = [];
    const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    for (const u of users.filter(u => u.role !== 'admin')) {
      const row = { userId: u.id, name: u.name, days: {} };
      for (const day of weekDays) {
        // Count tasks with due dates on each weekday in next 2 weeks
        row.days[day] = Math.floor(Math.random() * 5); // Placeholder - will calculate from real data
      }

      // Calculate from actual tasks
      const userTasks = tasks.filter(t => t.assignedTo === u.id && t.dueDate);
      for (const t of userTasks) {
        const d = new Date(t.dueDate);
        const dayOfWeek = d.getDay();
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const dayName = dayNames[dayOfWeek];
        if (weekDays.includes(dayName)) {
          row.days[dayName] = (row.days[dayName] || 0) + 1;
        }
      }
      heatmapData.push(row);
    }

    // SLA / Deadline breach stats
    const overdueTasks = tasks.filter(t => t.dueDate && t.dueDate < today && t.status !== 'done');
    const dueSoon = tasks.filter(t => {
      if (!t.dueDate || t.status === 'done') return false;
      const diff = (new Date(t.dueDate) - new Date(today)) / (1000 * 60 * 60 * 24);
      return diff >= 0 && diff <= 3;
    });

    const slaStats = {
      totalOverdue: overdueTasks.length,
      dueSoon: dueSoon.length,
      breachRate: tasks.length > 0 ? Math.round((overdueTasks.length / tasks.length) * 100) : 0,
      overdueTasks: overdueTasks.slice(0, 10).map(t => ({
        id: t.id,
        title: t.title,
        dueDate: t.dueDate,
        assignee: t.assignee,
        board: t.board,
        daysOverdue: Math.floor((new Date(today) - new Date(t.dueDate)) / (1000 * 60 * 60 * 24)),
      })),
    };

    // Productivity summary
    const totalDone = tasks.filter(t => t.status === 'done').length;
    const completionRate = tasks.length > 0 ? Math.round((totalDone / tasks.length) * 100) : 0;

    // Average time to complete (approx from done tasks with start/due dates)
    let avgDays = 0;
    const doneTasks = tasks.filter(t => t.status === 'done' && t.startDate && t.dueDate);
    if (doneTasks.length > 0) {
      const totalDays = doneTasks.reduce((sum, t) => {
        return sum + Math.max(0, (new Date(t.dueDate) - new Date(t.startDate)) / (1000 * 60 * 60 * 24));
      }, 0);
      avgDays = Math.round(totalDays / doneTasks.length);
    }

    // Pending approvals count
    const pendingApprovals = tasks.filter(t => t.approvalStatus === 'pending_approval').length;

    // Escalated tasks
    const escalatedTasks = tasks.filter(t => t.escalationLevel).map(t => ({
      id: t.id,
      title: t.title,
      escalationLevel: t.escalationLevel,
      assignee: t.assignee,
      board: t.board,
    }));

    // Risk labels (delayed tasks)
    const riskTasks = tasks
      .filter(t => {
        if (t.status === 'done' || !t.dueDate) return false;
        const diff = (new Date(t.dueDate) - new Date(today)) / (1000 * 60 * 60 * 24);
        return diff < 0 || (diff <= 1 && t.status === 'not_started');
      })
      .map(t => ({
        id: t.id,
        title: t.title,
        dueDate: t.dueDate,
        status: t.status,
        risk: t.dueDate < today ? 'critical' : 'high',
        assignee: t.assignee,
        board: t.board,
      }));

    // Workspaces summary
    let workspaces = [];
    try {
      workspaces = await Workspace.findAll({
        where: { isActive: true },
        include: [
          { model: Board, as: 'boards', attributes: ['id', 'name'], where: { isArchived: false }, required: false },
          { model: User, as: 'workspaceMembers', attributes: ['id', 'name'] },
        ],
      });
    } catch (e) { /* workspaces may not exist yet */ }

    // Announcements
    let announcements = [];
    try {
      announcements = await Announcement.findAll({
        where: { isActive: true },
        include: [{ model: User, as: 'author', attributes: ['id', 'name', 'avatar'] }],
        order: [['isPinned', 'DESC'], ['createdAt', 'DESC']],
        limit: 10,
      });
    } catch (e) { /* announcements may not exist yet */ }

    // Pending access requests count
    let pendingAccessRequests = 0;
    try {
      pendingAccessRequests = await AccessRequest.count({ where: { status: 'pending' } });
    } catch (e) { /* */ }

    // Priority distribution
    const priorityCounts = {};
    tasks.forEach(t => {
      priorityCounts[t.priority] = (priorityCounts[t.priority] || 0) + 1;
    });

    // Status counts
    const statusCounts = {};
    tasks.forEach(t => {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    });

    res.json({
      success: true,
      data: {
        summary: {
          totalTasks: tasks.length,
          done: totalDone,
          working: statusCounts.working_on_it || 0,
          stuck: statusCounts.stuck || 0,
          notStarted: statusCounts.not_started || 0,
          overdue: overdueTasks.length,
          completionRate,
          avgCompletionDays: avgDays,
          pendingApprovals,
          pendingAccessRequests,
        },
        statusCounts,
        priorityCounts,
        memberGrid,
        heatmapData,
        slaStats,
        escalatedTasks,
        riskTasks,
        workspaces: workspaces.map(w => ({
          id: w.id,
          name: w.name,
          color: w.color,
          boardCount: w.boards?.length || 0,
          memberCount: w.workspaceMembers?.length || 0,
        })),
        announcements,
      },
    });
  } catch (error) {
    console.error('[Dashboard] Enterprise error:', error);
    res.status(500).json({ success: false, message: 'Failed to load enterprise dashboard.' });
  }
};

/**
 * GET /api/dashboard/super
 * Super Dashboard — all tasks across all boards with filtering.
 * Admin/Manager see all; Members see only their tasks.
 */
const getSuperDashboard = async (req, res) => {
  try {
    const { status, priority, assignedTo, dateFilter, search, page = 1, limit = 50 } = req.query;
    const user = req.user;

    // Build task where clause
    const taskWhere = { isArchived: false };

    // RBAC: members only see their tasks
    if (user.role === 'member') {
      taskWhere.assignedTo = user.id;
    }

    // Filters
    if (status) {
      taskWhere.status = { [Op.in]: status.split(',') };
    }
    if (priority) {
      taskWhere.priority = { [Op.in]: priority.split(',') };
    }
    if (assignedTo === 'unassigned') {
      taskWhere.assignedTo = null;
    } else if (assignedTo && assignedTo !== 'all') {
      taskWhere.assignedTo = assignedTo;
    }
    if (search) {
      taskWhere[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
      ];
    }
    if (dateFilter) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
      const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + 7);
      switch (dateFilter) {
        case 'overdue':
          taskWhere.dueDate = { [Op.lt]: today };
          taskWhere.status = { [Op.ne]: 'done' };
          break;
        case 'today':
          taskWhere.dueDate = { [Op.gte]: today, [Op.lt]: tomorrow };
          break;
        case 'this_week':
          taskWhere.dueDate = { [Op.gte]: today, [Op.lt]: weekEnd };
          break;
      }
    }

    // Fetch all tasks matching filters (for summary stats)
    const allTasks = await Task.findAll({
      where: taskWhere,
      attributes: ['id', 'status', 'priority', 'dueDate', 'assignedTo'],
      include: [{ model: Board, as: 'board', attributes: ['id'], where: { isArchived: false }, required: false }],
    });

    // Summary stats
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const summary = {
      totalTasks: allTasks.length,
      done: allTasks.filter(t => t.status === 'done').length,
      working: allTasks.filter(t => t.status === 'working_on_it').length,
      stuck: allTasks.filter(t => t.status === 'stuck').length,
      notStarted: allTasks.filter(t => t.status === 'not_started').length,
      overdue: allTasks.filter(t => t.dueDate && new Date(t.dueDate) < todayStart && t.status !== 'done').length,
      review: allTasks.filter(t => t.status === 'review').length,
    };

    // Status & priority counts
    const statusCounts = {};
    const priorityCounts = {};
    allTasks.forEach(t => {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
      priorityCounts[t.priority] = (priorityCounts[t.priority] || 0) + 1;
    });

    // Member stats
    const memberMap = {};
    allTasks.forEach(t => {
      if (!t.assignedTo) return;
      if (!memberMap[t.assignedTo]) memberMap[t.assignedTo] = { total: 0, done: 0, working: 0, stuck: 0, overdue: 0 };
      memberMap[t.assignedTo].total++;
      if (t.status === 'done') memberMap[t.assignedTo].done++;
      if (t.status === 'working_on_it') memberMap[t.assignedTo].working++;
      if (t.status === 'stuck') memberMap[t.assignedTo].stuck++;
      if (t.dueDate && new Date(t.dueDate) < todayStart && t.status !== 'done') memberMap[t.assignedTo].overdue++;
    });

    const memberIds = Object.keys(memberMap);
    const memberUsers = memberIds.length > 0
      ? await User.findAll({ where: { id: { [Op.in]: memberIds } }, attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation'] })
      : [];
    const memberStats = memberUsers.map(u => ({
      id: u.id, name: u.name, email: u.email, avatar: u.avatar, role: u.role, designation: u.designation,
      ...memberMap[u.id],
    }));

    // Paginated task list with full details
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const tasks = await Task.findAll({
      where: taskWhere,
      include: [
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'], where: { isArchived: false } },
        { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar'] },
      ],
      order: buildPendingPriorityOrder(),
      limit: parseInt(limit),
      offset,
    });

    res.json({
      success: true,
      data: {
        tasks,
        summary,
        statusCounts,
        priorityCounts,
        memberStats,
        pagination: { page: parseInt(page), limit: parseInt(limit), total: allTasks.length },
      },
    });
  } catch (error) {
    console.error('[Dashboard] Super dashboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to load super dashboard.' });
  }
};

/**
 * GET /api/dashboard/role?scope=member|manager|admin&status=...&priority=...&assignedTo=...&dateFilter=...&search=...&page=...&limit=...
 * Role-scoped dashboard: member sees own tasks, manager sees team, admin sees all.
 */
const getRoleDashboard = async (req, res) => {
  try {
    const { scope, status, priority, assignedTo, dateFilter, search, page = 1, limit = 50 } = req.query;
    const user = req.user;

    // Guard: enforce scope permissions
    const effectiveScope = user.role === 'member' ? 'member'
      : user.role === 'manager' ? (scope === 'admin' ? 'manager' : (scope || 'manager'))
      : (scope || 'admin');

    // Build task filter
    const taskWhere = { isArchived: false };

    // Scope-based filtering
    let teamMemberIds = [];
    if (effectiveScope === 'member') {
      taskWhere.assignedTo = user.id;
    } else if (effectiveScope === 'manager') {
      const teamMembers = await User.findAll({ where: { managerId: user.id, isActive: true }, attributes: ['id'] });
      teamMemberIds = teamMembers.map(m => m.id);
      taskWhere[Op.or] = [
        { assignedTo: { [Op.in]: [...teamMemberIds, user.id] } },
        { createdBy: user.id },
      ];
    }
    // admin scope: no task filter — sees all

    // Apply filters (same as getSuperDashboard)
    if (status) taskWhere.status = { [Op.in]: status.split(',') };
    if (priority) taskWhere.priority = { [Op.in]: priority.split(',') };
    if (assignedTo === 'unassigned') {
      taskWhere.assignedTo = null;
    } else if (assignedTo && assignedTo !== 'all') {
      taskWhere.assignedTo = assignedTo;
    }
    if (search) {
      const searchCondition = [
        { title: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } },
      ];
      if (taskWhere[Op.or]) {
        // Manager scope already has Op.or for team filter — wrap both in Op.and
        const existingOr = taskWhere[Op.or];
        delete taskWhere[Op.or];
        taskWhere[Op.and] = [
          { [Op.or]: existingOr },
          { [Op.or]: searchCondition },
        ];
      } else {
        taskWhere[Op.or] = searchCondition;
      }
    }
    if (dateFilter) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
      const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + 7);
      if (dateFilter === 'overdue') { taskWhere.dueDate = { [Op.lt]: today }; taskWhere.status = { [Op.ne]: 'done' }; }
      else if (dateFilter === 'today') { taskWhere.dueDate = { [Op.gte]: today, [Op.lt]: tomorrow }; }
      else if (dateFilter === 'this_week') { taskWhere.dueDate = { [Op.gte]: today, [Op.lt]: weekEnd }; }
    }

    // Fetch all matching tasks for stats
    const allTasks = await Task.findAll({
      where: taskWhere,
      attributes: ['id', 'status', 'priority', 'dueDate', 'assignedTo'],
      include: [{ model: Board, as: 'board', attributes: ['id'], where: { isArchived: false }, required: false }],
    });

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const summary = {
      totalTasks: allTasks.length,
      done: allTasks.filter(t => t.status === 'done').length,
      working: allTasks.filter(t => t.status === 'working_on_it').length,
      stuck: allTasks.filter(t => t.status === 'stuck').length,
      notStarted: allTasks.filter(t => t.status === 'not_started').length,
      overdue: allTasks.filter(t => t.dueDate && new Date(t.dueDate) < todayStart && t.status !== 'done').length,
      review: allTasks.filter(t => t.status === 'review').length,
    };

    const statusCounts = {};
    const priorityCounts = {};
    allTasks.forEach(t => {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
      priorityCounts[t.priority] = (priorityCounts[t.priority] || 0) + 1;
    });

    // Member stats
    const memberMap = {};
    allTasks.forEach(t => {
      if (!t.assignedTo) return;
      if (!memberMap[t.assignedTo]) memberMap[t.assignedTo] = { total: 0, done: 0, working: 0, stuck: 0, overdue: 0 };
      memberMap[t.assignedTo].total++;
      if (t.status === 'done') memberMap[t.assignedTo].done++;
      if (t.status === 'working_on_it') memberMap[t.assignedTo].working++;
      if (t.status === 'stuck') memberMap[t.assignedTo].stuck++;
      if (t.dueDate && new Date(t.dueDate) < todayStart && t.status !== 'done') memberMap[t.assignedTo].overdue++;
    });
    const memberIds = Object.keys(memberMap);
    const memberUsers = memberIds.length > 0
      ? await User.findAll({ where: { id: { [Op.in]: memberIds } }, attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation'] })
      : [];
    const memberStats = memberUsers.map(u => ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar, role: u.role, designation: u.designation, ...memberMap[u.id] }));

    // Team members list (for manager's person dropdown)
    let teamMembers = [];
    if (effectiveScope === 'manager') {
      teamMembers = await User.findAll({
        where: { managerId: user.id, isActive: true },
        attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation'],
      });
    }

    // Paginated task list
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const tasks = await Task.findAll({
      where: taskWhere,
      include: [
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'], where: { isArchived: false }, required: false },
        { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
      ],
      order: buildPendingPriorityOrder(),
      limit: parseInt(limit),
      offset,
    });

    res.json({
      success: true,
      data: {
        tasks, summary, statusCounts, priorityCounts, memberStats, teamMembers,
        scope: effectiveScope,
        pagination: { page: parseInt(page), limit: parseInt(limit), total: allTasks.length },
      },
    });
  } catch (error) {
    console.error('[Dashboard] Role dashboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to load dashboard.' });
  }
};

module.exports = { getDashboardStats, getMemberTasks, getEnterpriseDashboard, getSuperDashboard, getRoleDashboard };
