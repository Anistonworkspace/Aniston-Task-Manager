const { Task, Board, User, Department, TimeBlock } = require('../models');
const { Op } = require('sequelize');

/**
 * GET /api/dashboard/director
 * Aggregated director overview: org stats, department breakdown, team snapshot, today's blocks
 */
const getDirectorDashboard = async (req, res) => {
  try {
    // Authorization: director/vp/ceo hierarchy or admin role
    const allowed = ['director', 'vp', 'ceo'];
    if (!allowed.includes(req.user.hierarchyLevel) && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Director-level access required.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const todayStart = new Date(today + 'T00:00:00.000Z');
    const todayEnd = new Date(today + 'T23:59:59.999Z');

    // 1. All active, non-archived tasks
    const allTasks = await Task.findAll({
      where: { isArchived: false },
      include: [
        { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar', 'department', 'departmentId', 'designation'] },
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
      ],
      attributes: ['id', 'title', 'status', 'priority', 'dueDate', 'updatedAt', 'assignedTo', 'boardId', 'progress'],
    });

    // 2. Org stats
    const totalTasks = allTasks.length;
    const completedTasks = allTasks.filter(t => t.status === 'done').length;
    const completedToday = allTasks.filter(t => t.status === 'done' && t.updatedAt >= todayStart && t.updatedAt <= todayEnd).length;
    const workingTasks = allTasks.filter(t => t.status === 'working_on_it').length;
    const stuckTasks = allTasks.filter(t => t.status === 'stuck').length;
    const pendingTasks = totalTasks - completedTasks;
    const overdueTasks = allTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date() && t.status !== 'done').length;
    const overallPct = totalTasks ? Math.round((completedTasks / totalTasks) * 100) : 0;

    // 3. Department breakdown
    const departments = await Department.findAll({
      where: { isActive: true },
      attributes: ['id', 'name', 'color'],
      include: [{ model: User, as: 'members', attributes: ['id', 'name'] }],
    });

    const deptBreakdown = departments.map(dept => {
      const deptUserIds = dept.members ? dept.members.map(u => u.id) : [];
      const deptTasks = allTasks.filter(t => deptUserIds.includes(t.assignedTo));
      const deptDone = deptTasks.filter(t => t.status === 'done').length;
      const deptWorking = deptTasks.filter(t => t.status === 'working_on_it').length;
      const deptStuck = deptTasks.filter(t => t.status === 'stuck').length;
      return {
        id: dept.id,
        name: dept.name,
        color: dept.color || '#6B7280',
        memberCount: deptUserIds.length,
        taskCount: deptTasks.length,
        completedCount: deptDone,
        workingCount: deptWorking,
        stuckCount: deptStuck,
        pct: deptTasks.length ? Math.round((deptDone / deptTasks.length) * 100) : 0,
      };
    }).filter(d => d.memberCount > 0 || d.taskCount > 0);

    // 4. Team snapshot — each active user with their task breakdown
    const activeUsers = await User.findAll({
      where: { isActive: true },
      attributes: ['id', 'name', 'avatar', 'department', 'designation', 'departmentId', 'hierarchyLevel', 'role'],
      order: [['name', 'ASC']],
    });

    const teamSnapshot = activeUsers.map(u => {
      const userTasks = allTasks.filter(t => t.assignedTo === u.id);
      const done = userTasks.filter(t => t.status === 'done').length;
      const working = userTasks.filter(t => t.status === 'working_on_it').length;
      const stuck = userTasks.filter(t => t.status === 'stuck').length;
      const currentTask = userTasks.find(t => t.status === 'working_on_it') || userTasks.find(t => t.status !== 'done');
      return {
        id: u.id,
        name: u.name,
        avatar: u.avatar,
        department: u.department,
        designation: u.designation,
        role: u.role,
        hierarchyLevel: u.hierarchyLevel,
        tasksTotal: userTasks.length,
        tasksDone: done,
        tasksWorking: working,
        tasksStuck: stuck,
        pct: userTasks.length ? Math.round((done / userTasks.length) * 100) : 0,
        currentTask: currentTask ? { id: currentTask.id, title: currentTask.title, status: currentTask.status, boardName: currentTask.board?.name } : null,
      };
    });

    // 5. Director's time blocks for today
    const todayBlocks = await TimeBlock.findAll({
      where: { userId: req.user.id, date: today },
      include: [
        { model: Task, as: 'task', attributes: ['id', 'title', 'status', 'priority'] },
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
      ],
      order: [['startTime', 'ASC']],
    });

    // 6. Board summary
    const boards = await Board.findAll({
      where: { isArchived: false },
      attributes: ['id', 'name', 'color'],
    });
    const boardSummary = boards.map(b => {
      const bTasks = allTasks.filter(t => t.boardId === b.id);
      const bDone = bTasks.filter(t => t.status === 'done').length;
      return {
        id: b.id, name: b.name, color: b.color,
        taskCount: bTasks.length, completedCount: bDone,
        pct: bTasks.length ? Math.round((bDone / bTasks.length) * 100) : 0,
      };
    }).filter(b => b.taskCount > 0);

    res.json({
      success: true,
      data: {
        orgStats: { totalTasks, completedTasks, completedToday, workingTasks, stuckTasks, pendingTasks, overdueTasks, overallPct },
        departments: deptBreakdown,
        teamSnapshot,
        todayBlocks: todayBlocks.map(b => b.toJSON()),
        boards: boardSummary,
      },
    });
  } catch (error) {
    console.error('[DirectorDashboard] Error:', error);
    res.status(500).json({ success: false, message: 'Server error loading director dashboard.' });
  }
};

module.exports = { getDirectorDashboard };
