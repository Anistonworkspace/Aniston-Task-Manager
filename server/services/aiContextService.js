/**
 * AI Context Builder Service
 *
 * Builds role-scoped, page-aware data context for the AI assistant.
 * Each page resolver fetches ONLY data the current user is allowed to see,
 * reusing the same RBAC patterns as the rest of the application.
 *
 * The returned context is a compact text summary — not raw JSON — so it
 * fits within token budgets while still giving the AI real, actionable data.
 */

const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const {
  User, Board, Task, Notification, Meeting, Department,
  DueDateExtension, HelpRequest, TaskAssignee, TaskOwner,
  TaskDependency, TimeBlock, PromotionHistory, HierarchyLevel,
  DirectorPlan, Activity,
} = require('../models');
const { getDescendantIds } = require('./hierarchyService');
const { buildPendingPriorityOrder } = require('../utils/taskPrioritization');

// ─── Helpers ──────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Get the IDs of users that the current user can "see" based on role.
 * Reuses the same hierarchy logic as taskPermissions / hierarchyService.
 */
async function getVisibleUserIds(user) {
  if (user.isSuperAdmin || user.role === 'admin') return null; // null = no filter (all)
  if (user.role === 'manager') {
    const descendantIds = await getDescendantIds(user.id);
    return [user.id, ...descendantIds];
  }
  if (user.role === 'assistant_manager') {
    const directReports = await User.findAll({
      where: { managerId: user.id, isActive: true },
      attributes: ['id'],
      raw: true,
    });
    return [user.id, ...directReports.map(u => u.id)];
  }
  return [user.id]; // member — self only
}

/**
 * Get board IDs the user can access (mirrors boardController.getBoards logic).
 */
async function getVisibleBoardIds(user) {
  if (user.isSuperAdmin || user.role === 'admin' || user.role === 'manager') return null; // all

  const visibleUserIds = await getVisibleUserIds(user);
  const boards = await Board.findAll({
    attributes: ['id'],
    where: {
      isArchived: false,
      [Op.or]: [
        { createdBy: { [Op.in]: visibleUserIds } },
        sequelize.literal(`"Board"."id" IN (SELECT "boardId" FROM "BoardMembers" WHERE "userId" IN (${visibleUserIds.map(id => `'${id}'`).join(',')}))`),
        sequelize.literal(`"Board"."id" IN (SELECT DISTINCT "boardId" FROM tasks WHERE "assignedTo" IN (${visibleUserIds.map(id => `'${id}'`).join(',')}) AND ("isArchived" = false OR "isArchived" IS NULL))`),
      ],
    },
    raw: true,
  });
  return boards.map(b => b.id);
}

/**
 * Build WHERE clause for tasks visible to this user.
 * Mirrors buildTaskVisibilityFilter from taskPermissions.js.
 */
function buildTaskWhere(user, visibleUserIds, extra = {}) {
  const base = { isArchived: false, ...extra };
  if (!visibleUserIds) return base; // admin/manager — no filter
  return {
    ...base,
    [Op.or]: [
      { assignedTo: { [Op.in]: visibleUserIds } },
      { createdBy: { [Op.in]: visibleUserIds } },
    ],
  };
}

// ─── Compact text formatters ──────────────────────────────────

function summarizeTasks(tasks, label) {
  if (!tasks.length) return `${label}: none.`;
  const statusCounts = {};
  const priorityCounts = {};
  let overdue = 0;
  const todayStr = today();
  tasks.forEach(t => {
    const s = t.status || 'unknown';
    const p = t.priority || 'medium';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
    priorityCounts[p] = (priorityCounts[p] || 0) + 1;
    if (t.dueDate && t.dueDate < todayStr && s !== 'done') overdue++;
  });
  const parts = [`${label}: ${tasks.length} total`];
  const statuses = Object.entries(statusCounts).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', ');
  parts.push(`  Status breakdown: ${statuses}`);
  const priorities = Object.entries(priorityCounts).map(([k, v]) => `${k}: ${v}`).join(', ');
  parts.push(`  Priority breakdown: ${priorities}`);
  if (overdue > 0) parts.push(`  Overdue: ${overdue}`);
  return parts.join('\n');
}

function taskLine(t) {
  const due = t.dueDate ? ` (due ${t.dueDate})` : '';
  const assignee = t.assignee?.name || t.assignedToName || '';
  return `- "${t.title}" [${t.status}/${t.priority}]${due}${assignee ? ` → ${assignee}` : ''}`;
}

// ─── Page Resolvers ───────────────────────────────────────────

async function resolveHome(user, _params) {
  const visibleUserIds = await getVisibleUserIds(user);
  const todayStr = today();

  // Personal tasks
  const myTasks = await Task.findAll({
    where: { isArchived: false, assignedTo: user.id },
    attributes: ['id', 'title', 'status', 'priority', 'progress', 'dueDate', 'updatedAt', 'createdAt'],
    order: buildPendingPriorityOrder(),
    limit: 50,
    raw: true,
  });

  const myOverdue = myTasks.filter(t => t.dueDate && t.dueDate < todayStr && t.status !== 'done');
  const myDueToday = myTasks.filter(t => t.dueDate && t.dueDate.startsWith(todayStr) && t.status !== 'done');
  const myInProgress = myTasks.filter(t => t.status === 'working_on_it');
  const myStuck = myTasks.filter(t => t.status === 'stuck');

  const lines = [
    `Your tasks: ${myTasks.length} total, ${myTasks.filter(t => t.status === 'done').length} done, ${myInProgress.length} in progress, ${myStuck.length} stuck, ${myOverdue.length} overdue, ${myDueToday.length} due today.`,
  ];

  if (myOverdue.length > 0) {
    lines.push(`Your overdue tasks:\n${myOverdue.slice(0, 5).map(taskLine).join('\n')}`);
  }
  if (myDueToday.length > 0) {
    lines.push(`Due today:\n${myDueToday.slice(0, 5).map(taskLine).join('\n')}`);
  }

  // Team context for managers
  if (visibleUserIds === null || (visibleUserIds && visibleUserIds.length > 1)) {
    const teamFilter = visibleUserIds ? { assignedTo: { [Op.in]: visibleUserIds } } : {};
    const teamOverdue = await Task.count({
      where: { isArchived: false, status: { [Op.ne]: 'done' }, dueDate: { [Op.lt]: todayStr }, ...teamFilter },
    });
    const teamStuck = await Task.count({
      where: { isArchived: false, status: 'stuck', ...teamFilter },
    });
    const teamTotal = await Task.count({
      where: { isArchived: false, ...teamFilter },
    });
    lines.push(`Team overview: ${teamTotal} total tasks, ${teamOverdue} overdue, ${teamStuck} stuck.`);
  }

  // Unread notifications
  const unread = await Notification.count({ where: { userId: user.id, isRead: false } });
  if (unread > 0) lines.push(`You have ${unread} unread notifications.`);

  return lines.join('\n');
}

async function resolveBoards(user, params) {
  const boardId = params.boardId;
  console.log('[AIContext:Boards] boardId:', boardId, '| user:', user.name, '| role:', user.role);

  if (boardId) {
    // Specific board detail
    const board = await Board.findByPk(boardId, {
      attributes: ['id', 'name', 'description', 'color'],
      include: [
        { model: User, as: 'members', attributes: ['id', 'name'], through: { attributes: [] } },
      ],
    });
    console.log('[AIContext:Boards] Board found:', board ? board.name : 'NULL');
    if (!board) return 'Board not found or you do not have access.';

    const visibleUserIds = await getVisibleUserIds(user);
    console.log('[AIContext:Boards] visibleUserIds:', visibleUserIds === null ? 'ALL (admin)' : visibleUserIds.length);
    const taskWhere = buildTaskWhere(user, visibleUserIds, { boardId });

    const tasks = await Task.findAll({
      where: taskWhere,
      attributes: ['id', 'title', 'status', 'priority', 'progress', 'dueDate', 'assignedTo', 'updatedAt', 'createdAt'],
      include: [{ model: User, as: 'assignee', attributes: ['name'] }],
      order: buildPendingPriorityOrder(),
      limit: 200,
      raw: false,
    });

    console.log('[AIContext:Boards] Tasks found:', tasks.length);

    const todayStr = today();

    // Count statuses DYNAMICALLY — do NOT hardcode status values.
    // Status can be 'done', 'Done', 'working_on_it', 'Working on it', 'In Progress', custom, etc.
    const statusCounts = {};
    const priorityCounts = {};
    let overdueCount = 0;
    const doneKeywords = ['done', 'completed', 'finished'];

    tasks.forEach(t => {
      const status = t.status || 'unknown';
      statusCounts[status] = (statusCounts[status] || 0) + 1;

      const priority = t.priority || 'medium';
      priorityCounts[priority] = (priorityCounts[priority] || 0) + 1;

      // Check overdue: task has dueDate before today and status is NOT a done-like status
      const isDone = doneKeywords.some(kw => status.toLowerCase().includes(kw));
      if (t.dueDate && t.dueDate < todayStr && !isDone) overdueCount++;
    });

    // Calculate "done" count by matching any done-like status
    const doneCount = Object.entries(statusCounts)
      .filter(([s]) => doneKeywords.some(kw => s.toLowerCase().includes(kw)))
      .reduce((sum, [, c]) => sum + c, 0);

    // Build the EXACT METRICS block — this is what the AI reads for numeric questions
    const lines = [
      `BOARD METRICS (exact, live from database):`,
      `  Board name: ${board.name}`,
      `  Board ID: ${boardId}`,
      `  Total tasks: ${tasks.length}`,
      `  Done tasks: ${doneCount}`,
      `  Overdue tasks: ${overdueCount}`,
      `  Status breakdown:`,
    ];

    // List every status with its exact count
    Object.entries(statusCounts).forEach(([status, count]) => {
      lines.push(`    ${status}: ${count}`);
    });

    lines.push(`  Priority breakdown:`);
    Object.entries(priorityCounts).forEach(([priority, count]) => {
      lines.push(`    ${priority}: ${count}`);
    });

    lines.push(`  Members: ${board.members?.map(m => m.name).join(', ') || 'none'}`);

    // List all tasks with details so the AI can answer task-specific questions
    if (tasks.length > 0) {
      lines.push(`\n  All tasks on this board:`);
      tasks.slice(0, 50).forEach(t => {
        const due = t.dueDate ? ` (due ${t.dueDate})` : '';
        const assignee = t.assignee?.name || '';
        const isDone = doneKeywords.some(kw => (t.status || '').toLowerCase().includes(kw));
        const overdue = (t.dueDate && t.dueDate < todayStr && !isDone) ? ' [OVERDUE]' : '';
        lines.push(`    - "${t.title}" | status: ${t.status} | priority: ${t.priority}${due}${assignee ? ` | owner: ${assignee}` : ''}${overdue}`);
      });
    }

    const result = lines.join('\n');
    console.log('[AIContext:Boards] Context result length:', result.length, '| doneCount:', doneCount, '| total:', tasks.length);
    return result;
  }

  // Board list page
  const visibleBoardIds = await getVisibleBoardIds(user);
  const boardWhere = { isArchived: false };
  if (visibleBoardIds) boardWhere.id = { [Op.in]: visibleBoardIds };

  const boards = await Board.findAll({
    where: boardWhere,
    attributes: ['id', 'name', 'color'],
    include: [{ model: Task, as: 'tasks', attributes: ['id', 'status'], where: { isArchived: false }, required: false }],
    order: [['createdAt', 'DESC']],
    limit: 20,
  });

  const lines = [`You can access ${boards.length} board(s).`];
  boards.forEach(b => {
    const plain = b.toJSON();
    const taskCount = plain.tasks?.length || 0;
    const doneCount = plain.tasks?.filter(t => t.status === 'done').length || 0;
    lines.push(`- "${plain.name}" — ${taskCount} tasks (${doneCount} done)`);
  });

  return lines.join('\n');
}

async function resolveDashboard(user, params) {
  const visibleUserIds = await getVisibleUserIds(user);
  const todayStr = today();

  const taskWhere = buildTaskWhere(user, visibleUserIds);

  const tasks = await Task.findAll({
    where: taskWhere,
    attributes: ['id', 'status', 'priority', 'dueDate', 'assignedTo', 'updatedAt'],
    include: [{ model: User, as: 'assignee', attributes: ['id', 'name'] }],
    limit: 500,
    raw: false,
  });

  const statusCounts = {};
  const priorityCounts = {};
  let overdue = 0;
  let dueThisWeek = 0;
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);

  tasks.forEach(t => {
    statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    priorityCounts[t.priority] = (priorityCounts[t.priority] || 0) + 1;
    if (t.dueDate && t.dueDate < todayStr && t.status !== 'done') overdue++;
    if (t.dueDate && t.dueDate >= todayStr && t.dueDate <= weekEndStr && t.status !== 'done') dueThisWeek++;
  });

  const lines = [
    `Dashboard summary (${visibleUserIds ? 'your scope' : 'all'})`,
    `Total tasks: ${tasks.length}`,
    `Status: ${Object.entries(statusCounts).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', ')}`,
    `Priority: ${Object.entries(priorityCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
    `Overdue: ${overdue}`,
    `Due this week: ${dueThisWeek}`,
  ];

  // Per-member workload (for managers+)
  if (visibleUserIds === null || (visibleUserIds && visibleUserIds.length > 1)) {
    const memberMap = {};
    tasks.forEach(t => {
      const name = t.assignee?.name || 'Unassigned';
      if (!memberMap[name]) memberMap[name] = { total: 0, done: 0, overdue: 0, stuck: 0 };
      memberMap[name].total++;
      if (t.status === 'done') memberMap[name].done++;
      if (t.status === 'stuck') memberMap[name].stuck++;
      if (t.dueDate && t.dueDate < todayStr && t.status !== 'done') memberMap[name].overdue++;
    });
    const workload = Object.entries(memberMap)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 10)
      .map(([name, s]) => `  ${name}: ${s.total} tasks, ${s.done} done, ${s.overdue} overdue, ${s.stuck} stuck`);
    if (workload.length) lines.push(`Team workload:\n${workload.join('\n')}`);
  }

  // Completion trend (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const recentlyDone = tasks.filter(t => t.status === 'done' && t.updatedAt && t.updatedAt.toISOString().slice(0, 10) >= weekAgo).length;
  lines.push(`Completed in last 7 days: ${recentlyDone}`);

  return lines.join('\n');
}

async function resolveMyWork(user, _params) {
  const todayStr = today();
  const tasks = await Task.findAll({
    where: { assignedTo: user.id, isArchived: false },
    attributes: ['id', 'title', 'status', 'priority', 'progress', 'dueDate', 'boardId', 'updatedAt', 'createdAt'],
    include: [{ model: Board, as: 'board', attributes: ['name'] }],
    order: buildPendingPriorityOrder(),
    limit: 60,
    raw: false,
  });

  const overdue = tasks.filter(t => t.dueDate && t.dueDate < todayStr && t.status !== 'done');
  const dueToday = tasks.filter(t => t.dueDate && t.dueDate.startsWith(todayStr) && t.status !== 'done');
  const thisWeek = tasks.filter(t => {
    if (!t.dueDate || t.status === 'done') return false;
    const d = t.dueDate;
    const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    return d > todayStr && d <= weekEnd;
  });
  const done = tasks.filter(t => t.status === 'done');

  const lines = [
    `Your work: ${tasks.length} tasks total`,
    `  Done: ${done.length}, Overdue: ${overdue.length}, Due today: ${dueToday.length}, Due this week: ${thisWeek.length}`,
  ];

  if (overdue.length > 0) {
    lines.push(`Overdue:\n${overdue.slice(0, 8).map(t => `- "${t.title}" [${t.priority}] due ${t.dueDate} (${t.board?.name || '?'})`).join('\n')}`);
  }
  if (dueToday.length > 0) {
    lines.push(`Due today:\n${dueToday.slice(0, 5).map(t => `- "${t.title}" [${t.priority}] (${t.board?.name || '?'})`).join('\n')}`);
  }
  if (thisWeek.length > 0) {
    lines.push(`Due this week:\n${thisWeek.slice(0, 5).map(t => `- "${t.title}" due ${t.dueDate} (${t.board?.name || '?'})`).join('\n')}`);
  }

  return lines.join('\n');
}

async function resolveOrgChart(user, params) {
  const visibleUserIds = await getVisibleUserIds(user);

  // Fetch users visible to this person
  const userWhere = { isActive: true };
  if (visibleUserIds) userWhere.id = { [Op.in]: visibleUserIds };

  const users = await User.findAll({
    where: userWhere,
    attributes: ['id', 'name', 'role', 'designation', 'title', 'hierarchyLevel', 'managerId', 'department'],
    order: [['name', 'ASC']],
    limit: 100,
    raw: true,
  });

  // Current user's position
  const me = users.find(u => u.id === user.id);
  const myManager = me?.managerId ? users.find(u => u.id === me.managerId) : null;
  const myReports = users.filter(u => u.managerId === user.id);

  const lines = [
    `Org chart (${visibleUserIds ? 'your visible scope' : 'full organization'})`,
    `Total visible people: ${users.length}`,
    `Your position: ${me?.designation || me?.title || me?.role || 'N/A'}${me?.hierarchyLevel ? ` (${me.hierarchyLevel})` : ''}`,
  ];

  if (myManager) {
    lines.push(`Your manager: ${myManager.name} (${myManager.designation || myManager.role})`);
  }
  if (myReports.length > 0) {
    lines.push(`Your direct reports (${myReports.length}): ${myReports.map(u => u.name).join(', ')}`);
  }

  // If a specific employee is selected
  if (params.selectedUserId && params.selectedUserId !== user.id) {
    const selected = users.find(u => u.id === params.selectedUserId);
    if (selected) {
      const theirReports = users.filter(u => u.managerId === selected.id);
      const theirManager = selected.managerId ? users.find(u => u.id === selected.managerId) : null;
      lines.push(`\nSelected employee: ${selected.name}`);
      lines.push(`  Role: ${selected.designation || selected.role}, Department: ${selected.department || 'N/A'}`);
      if (theirManager) lines.push(`  Reports to: ${theirManager.name}`);
      if (theirReports.length) lines.push(`  Direct reports: ${theirReports.map(u => u.name).join(', ')}`);
    } else {
      lines.push('Selected employee: not visible in your scope.');
    }
  }

  // Role distribution
  const roleCounts = {};
  users.forEach(u => { roleCounts[u.role] = (roleCounts[u.role] || 0) + 1; });
  lines.push(`Role distribution: ${Object.entries(roleCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}`);

  // Department distribution
  const deptCounts = {};
  users.forEach(u => { deptCounts[u.department || 'Unassigned'] = (deptCounts[u.department || 'Unassigned'] || 0) + 1; });
  lines.push(`Departments: ${Object.entries(deptCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}`);

  return lines.join('\n');
}

async function resolveTasksWorkflows(user, _params) {
  const lines = [];

  // Pending approvals for this user
  const pendingApprovals = await Task.count({
    where: { approvalStatus: 'pending', isArchived: false, assignedTo: user.id },
  });
  lines.push(`Pending approvals on your tasks: ${pendingApprovals}`);

  // Due date extension requests
  if (['admin', 'manager', 'assistant_manager'].includes(user.role) || user.isSuperAdmin) {
    const pendingExtensions = await DueDateExtension.count({
      where: { status: 'pending' },
    });
    lines.push(`Pending due date extension requests (to review): ${pendingExtensions}`);
  }
  const myExtensions = await DueDateExtension.count({
    where: { requestedBy: user.id, status: 'pending' },
  });
  if (myExtensions > 0) lines.push(`Your pending extension requests: ${myExtensions}`);

  // Help requests
  const helpReceived = await HelpRequest.count({
    where: { requestedTo: user.id, status: 'pending' },
  });
  if (helpReceived > 0) lines.push(`Help requests awaiting your response: ${helpReceived}`);

  const helpSent = await HelpRequest.count({
    where: { requestedBy: user.id, status: 'pending' },
  });
  if (helpSent > 0) lines.push(`Your pending help requests: ${helpSent}`);

  // Dependencies — tasks blocked by others
  const myTaskIds = (await Task.findAll({
    where: { assignedTo: user.id, isArchived: false },
    attributes: ['id'],
    raw: true,
  })).map(t => t.id);

  if (myTaskIds.length > 0) {
    const blockedCount = await TaskDependency.count({
      where: { taskId: { [Op.in]: myTaskIds }, dependencyType: 'blocks' },
    });
    if (blockedCount > 0) lines.push(`Tasks of yours that are blocked by dependencies: ${blockedCount}`);
  }

  return lines.join('\n') || 'No pending approvals, extensions, or help requests.';
}

async function resolveTimePlan(user, params) {
  const dateStr = params.selectedDate || today();

  // Personal time blocks
  const myBlocks = await TimeBlock.findAll({
    where: { userId: user.id, date: dateStr },
    attributes: ['startTime', 'endTime', 'description'],
    include: [{ model: Task, as: 'task', attributes: ['title'], required: false }],
    order: [['startTime', 'ASC']],
    raw: false,
  });

  const lines = [`Time plan for ${dateStr}`];
  if (myBlocks.length === 0) {
    lines.push('You have no time blocks scheduled for this date.');
  } else {
    lines.push(`Your schedule (${myBlocks.length} blocks):`);
    myBlocks.forEach(b => {
      const taskName = b.task?.title ? ` [${b.task.title}]` : '';
      lines.push(`  ${b.startTime}–${b.endTime}: ${b.description || 'No description'}${taskName}`);
    });
  }

  // Team view for managers
  if (['admin', 'manager', 'assistant_manager'].includes(user.role) || user.isSuperAdmin) {
    const visibleUserIds = await getVisibleUserIds(user);
    const teamWhere = { date: dateStr };
    if (visibleUserIds) {
      teamWhere.userId = { [Op.in]: visibleUserIds.filter(id => id !== user.id) };
    } else {
      teamWhere.userId = { [Op.ne]: user.id };
    }

    const teamBlocks = await TimeBlock.findAll({
      where: teamWhere,
      attributes: ['userId', 'startTime', 'endTime'],
      include: [{ model: User, as: 'user', attributes: ['name'] }],
      order: [['startTime', 'ASC']],
      limit: 50,
      raw: false,
    });

    if (teamBlocks.length > 0) {
      const byPerson = {};
      teamBlocks.forEach(b => {
        const name = b.user?.name || 'Unknown';
        if (!byPerson[name]) byPerson[name] = 0;
        byPerson[name]++;
      });
      lines.push(`\nTeam schedule for ${dateStr}:`);
      Object.entries(byPerson).forEach(([name, count]) => {
        lines.push(`  ${name}: ${count} time blocks`);
      });
    }
  }

  return lines.join('\n');
}

async function resolveMeetings(user, _params) {
  const todayStr = today();

  // Upcoming meetings where user is organizer or participant
  const meetings = await Meeting.findAll({
    where: {
      status: 'scheduled',
      date: { [Op.gte]: todayStr },
      [Op.or]: [
        { createdBy: user.id },
        sequelize.literal(`"Meeting"."participants" @> '[{"id": "${user.id}"}]'::jsonb`),
      ],
    },
    attributes: ['id', 'title', 'date', 'startTime', 'endTime', 'type', 'createdBy'],
    include: [{ model: User, as: 'organizer', attributes: ['name'] }],
    order: [['date', 'ASC'], ['startTime', 'ASC']],
    limit: 15,
    raw: false,
  });

  const lines = [`Upcoming meetings: ${meetings.length}`];
  meetings.forEach(m => {
    const isOrganizer = m.createdBy === user.id;
    lines.push(`- "${m.title}" on ${m.date} at ${m.startTime || '?'}–${m.endTime || '?'} (${m.type})${isOrganizer ? ' [you organize]' : ` [by ${m.organizer?.name}]`}`);
  });

  return lines.join('\n') || 'No upcoming meetings.';
}

async function resolveUsers(user, _params) {
  if (!['admin', 'manager', 'assistant_manager'].includes(user.role) && !user.isSuperAdmin) {
    return 'You do not have access to user management.';
  }

  const visibleUserIds = await getVisibleUserIds(user);
  const userWhere = { isActive: true };
  if (visibleUserIds) userWhere.id = { [Op.in]: visibleUserIds };

  const users = await User.findAll({
    where: userWhere,
    attributes: ['id', 'name', 'role', 'department', 'designation'],
    order: [['name', 'ASC']],
    limit: 100,
    raw: true,
  });

  const lines = [`User management — ${users.length} active users in your scope`];
  const roleCounts = {};
  const deptCounts = {};
  users.forEach(u => {
    roleCounts[u.role] = (roleCounts[u.role] || 0) + 1;
    deptCounts[u.department || 'Unassigned'] = (deptCounts[u.department || 'Unassigned'] || 0) + 1;
  });
  lines.push(`By role: ${Object.entries(roleCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  lines.push(`By department: ${Object.entries(deptCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}`);

  return lines.join('\n');
}

async function resolveDirectorPlan(user, params) {
  const dateStr = params.selectedDate || today();

  const plan = await DirectorPlan.findOne({
    where: { directorId: user.id, date: dateStr },
  });

  if (!plan) {
    return `Director plan for ${dateStr}: no plan created yet.`;
  }

  const categories = plan.categories || [];
  const lines = [`Director plan for ${dateStr}: ${categories.length} categories`];
  categories.forEach(cat => {
    const taskCount = Array.isArray(cat.tasks) ? cat.tasks.length : 0;
    lines.push(`- ${cat.name || cat.key || 'Category'}: ${taskCount} tasks`);
  });
  if (plan.notes) lines.push(`Notes: ${plan.notes}`);

  return lines.join('\n');
}

async function resolveProfile(user, _params) {
  return [
    `Your profile:`,
    `  Name: ${user.name}`,
    `  Email: ${user.email}`,
    `  Role: ${user.role}`,
    `  Department: ${user.department || 'Not set'}`,
    `  Designation: ${user.designation || 'Not set'}`,
  ].join('\n');
}

async function resolveNotes(user, _params) {
  const { Note } = require('../models');
  const count = await Note.count({ where: { userId: user.id } });
  return `You have ${count} note(s).`;
}

async function resolveIntegrations(user, _params) {
  if (user.role !== 'admin' && !user.isSuperAdmin) {
    return 'You need admin access to manage integrations.';
  }
  const { AIProvider } = require('../models');
  const providers = await AIProvider.findAll({ where: { isActive: true }, attributes: ['provider', 'displayName', 'isDefault', 'lastTestedAt'], raw: true });
  const lines = [`AI Providers: ${providers.length} active`];
  providers.forEach(p => {
    lines.push(`- ${p.displayName || p.provider}${p.isDefault ? ' (default)' : ''}${p.lastTestedAt ? ` — last tested ${new Date(p.lastTestedAt).toISOString().slice(0, 10)}` : ' — never tested'}`);
  });
  return lines.join('\n');
}

// ─── Route → Resolver map ─────────────────────────────────────

const ROUTE_RESOLVERS = {
  '/':                 resolveHome,
  '/my-work':          resolveMyWork,
  '/boards':           resolveBoards,
  '/dashboard':        resolveDashboard,
  '/admin-dashboard':  resolveDashboard,
  '/manager-dashboard': resolveDashboard,
  '/member-dashboard': resolveDashboard,
  '/director-dashboard': resolveDashboard,
  '/org-chart':        resolveOrgChart,
  '/time-plan':        resolveTimePlan,
  '/meetings':         resolveMeetings,
  '/tasks':            resolveTasksWorkflows,
  '/cross-team':       resolveTasksWorkflows,
  '/users':            resolveUsers,
  '/director-plan':    resolveDirectorPlan,
  '/profile':          resolveProfile,
  '/notes':            resolveNotes,
  '/integrations':     resolveIntegrations,
  '/reviews':          resolveMyWork, // reuse personal tasks view
  '/timeline':         resolveBoards, // timeline is board-scoped
  '/archive':          resolveBoards,
};

/**
 * Match a pathname to the best resolver.
 * Handles parameterized routes like /boards/:id and /boards/:id/dashboard.
 */
function matchResolver(pathname) {
  // Exact match first
  if (ROUTE_RESOLVERS[pathname]) {
    return { resolver: ROUTE_RESOLVERS[pathname], params: {} };
  }

  // /boards/:id/dashboard
  const boardDashMatch = pathname.match(/^\/boards\/([a-f0-9-]+)\/dashboard$/i);
  if (boardDashMatch) {
    return { resolver: resolveDashboard, params: { boardId: boardDashMatch[1] } };
  }

  // /boards/:id
  const boardMatch = pathname.match(/^\/boards\/([a-f0-9-]+)$/i);
  if (boardMatch) {
    return { resolver: resolveBoards, params: { boardId: boardMatch[1] } };
  }

  // Fallback — no page-specific data
  return null;
}

// ─── Main entry point ─────────────────────────────────────────

/**
 * Build AI context for the current user and page.
 *
 * @param {object} user - The authenticated user (from req.user)
 * @param {string} route - Current page route (pathname)
 * @param {object} [pageState] - Optional frontend page state (boardId, filters, etc.)
 * @returns {Promise<string>} Compact text context for the AI system prompt
 */
async function buildAIContext(user, route, pageState = {}) {
  const match = matchResolver(route || '/');
  console.log('[AIContext] Route:', route, '| Matched:', !!match, '| boardId from match:', match?.params?.boardId || 'none');

  // Merge route-extracted params with frontend-provided state
  const params = { ...(match?.params || {}), ...pageState };
  console.log('[AIContext] Merged params:', JSON.stringify({ boardId: params.boardId, route: params.route }));

  let dataContext = '';
  if (match) {
    try {
      dataContext = await match.resolver(user, params);
      console.log('[AIContext] Resolver returned', dataContext?.length || 0, 'chars');
    } catch (err) {
      console.error(`[AIContext] Error resolving context for ${route}:`, err.message, err.stack);
      dataContext = '(Could not load page data — generic help is still available.)';
    }
  } else {
    dataContext = '(No specific page data available for this route.)';
  }

  return dataContext;
}

module.exports = { buildAIContext };
