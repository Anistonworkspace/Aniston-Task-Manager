const { sequelize } = require('../config/db');
const User = require('./User');
const Board = require('./Board');
const Task = require('./Task');
const Comment = require('./Comment');
const Notification = require('./Notification');
const FileAttachment = require('./FileAttachment');
const Subtask = require('./Subtask');
const WorkLog = require('./WorkLog');
const Activity = require('./Activity');
const TimeBlock = require('./TimeBlock');
const Department = require('./Department');
const Meeting = require('./Meeting');
const TaskDependency = require('./TaskDependency');
const Automation = require('./Automation');
const Workspace = require('./Workspace');
const PermissionGrant = require('./PermissionGrant');
const AccessRequest = require('./AccessRequest');
const TaskWatcher = require('./TaskWatcher');
const Announcement = require('./Announcement');
const Label = require('./Label');
const TaskLabel = require('./TaskLabel');
const DueDateExtension = require('./DueDateExtension');
const HelpRequest = require('./HelpRequest');
const PromotionHistory = require('./PromotionHistory');
const HierarchyLevel = require('./HierarchyLevel');

// ─── Board <-> User (creator) ────────────────────────────────
Board.belongsTo(User, {
  foreignKey: 'createdBy',
  as: 'creator',
  onDelete: 'CASCADE',
});
User.hasMany(Board, {
  foreignKey: 'createdBy',
  as: 'createdBoards',
});

// ─── Board <-> User (many-to-many members via BoardMember) ──
Board.belongsToMany(User, {
  through: 'BoardMembers',
  foreignKey: 'boardId',
  otherKey: 'userId',
  as: 'members',
  timestamps: true,
});
User.belongsToMany(Board, {
  through: 'BoardMembers',
  foreignKey: 'userId',
  otherKey: 'boardId',
  as: 'memberBoards',
  timestamps: true,
});

// ─── Task <-> Board ──────────────────────────────────────────
Task.belongsTo(Board, {
  foreignKey: 'boardId',
  as: 'board',
  onDelete: 'CASCADE',
});
Board.hasMany(Task, {
  foreignKey: 'boardId',
  as: 'tasks',
});

// ─── Task <-> User (assignee) ────────────────────────────────
Task.belongsTo(User, {
  foreignKey: 'assignedTo',
  as: 'assignee',
  onDelete: 'SET NULL',
});
User.hasMany(Task, {
  foreignKey: 'assignedTo',
  as: 'assignedTasks',
});

// ─── Task <-> User (creator) ────────────────────────────────
Task.belongsTo(User, {
  foreignKey: 'createdBy',
  as: 'creator',
  onDelete: 'CASCADE',
});
User.hasMany(Task, {
  foreignKey: 'createdBy',
  as: 'createdTasks',
});

// ─── Comment <-> Task ────────────────────────────────────────
Comment.belongsTo(Task, {
  foreignKey: 'taskId',
  as: 'task',
  onDelete: 'CASCADE',
});
Task.hasMany(Comment, {
  foreignKey: 'taskId',
  as: 'comments',
});

// ─── Comment <-> User ────────────────────────────────────────
Comment.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user',
  onDelete: 'CASCADE',
});
User.hasMany(Comment, {
  foreignKey: 'userId',
  as: 'comments',
});

// ─── Notification <-> User ───────────────────────────────────
Notification.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user',
  onDelete: 'CASCADE',
});
User.hasMany(Notification, {
  foreignKey: 'userId',
  as: 'notifications',
});

// ─── FileAttachment <-> Task ─────────────────────────────────
FileAttachment.belongsTo(Task, {
  foreignKey: 'taskId',
  as: 'task',
  onDelete: 'CASCADE',
});
Task.hasMany(FileAttachment, {
  foreignKey: 'taskId',
  as: 'files',
});

// ─── FileAttachment <-> User ─────────────────────────────────
FileAttachment.belongsTo(User, {
  foreignKey: 'uploadedBy',
  as: 'uploader',
  onDelete: 'CASCADE',
});
User.hasMany(FileAttachment, {
  foreignKey: 'uploadedBy',
  as: 'uploadedFiles',
});

// ─── Subtask <-> Task ──────────────────────────────────────
Subtask.belongsTo(Task, {
  foreignKey: 'taskId',
  as: 'task',
  onDelete: 'CASCADE',
});
Task.hasMany(Subtask, {
  foreignKey: 'taskId',
  as: 'subtasks',
});

// ─── Subtask <-> User (creator) ────────────────────────────
Subtask.belongsTo(User, {
  foreignKey: 'createdBy',
  as: 'creator',
  onDelete: 'CASCADE',
});

// ─── Subtask <-> User (assignee) ───────────────────────────
Subtask.belongsTo(User, {
  foreignKey: 'assignedTo',
  as: 'assignee',
  onDelete: 'SET NULL',
});

// ─── WorkLog <-> Task ──────────────────────────────────────
WorkLog.belongsTo(Task, {
  foreignKey: 'taskId',
  as: 'task',
  onDelete: 'CASCADE',
});
Task.hasMany(WorkLog, {
  foreignKey: 'taskId',
  as: 'worklogs',
});

// ─── WorkLog <-> User (author) ─────────────────────────────
WorkLog.belongsTo(User, {
  foreignKey: 'userId',
  as: 'author',
  onDelete: 'CASCADE',
});
User.hasMany(WorkLog, {
  foreignKey: 'userId',
  as: 'worklogs',
});

// ─── Activity <-> User (actor) ──────────────────────────────
Activity.belongsTo(User, {
  foreignKey: 'userId',
  as: 'actor',
  onDelete: 'CASCADE',
});
User.hasMany(Activity, {
  foreignKey: 'userId',
  as: 'activities',
});

// ─── Activity <-> Task ──────────────────────────────────────
Activity.belongsTo(Task, {
  foreignKey: 'taskId',
  as: 'task',
  onDelete: 'SET NULL',
});

// ─── Activity <-> Board ─────────────────────────────────────
Activity.belongsTo(Board, {
  foreignKey: 'boardId',
  as: 'board',
  onDelete: 'SET NULL',
});

// ─── TimeBlock <-> User ──────────────────────────────────────
TimeBlock.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user',
  onDelete: 'CASCADE',
});
User.hasMany(TimeBlock, {
  foreignKey: 'userId',
  as: 'timeBlocks',
});

// ─── TimeBlock <-> Task ──────────────────────────────────────
TimeBlock.belongsTo(Task, {
  foreignKey: 'taskId',
  as: 'task',
  onDelete: 'SET NULL',
});

// ─── TimeBlock <-> Board ─────────────────────────────────────
TimeBlock.belongsTo(Board, {
  foreignKey: 'boardId',
  as: 'board',
  onDelete: 'SET NULL',
});

// ─── Department <-> User (head) ─────────────────────────────
Department.belongsTo(User, {
  foreignKey: 'head',
  as: 'headUser',
  onDelete: 'SET NULL',
});

// ─── Department <-> User (members) ──────────────────────────
Department.hasMany(User, {
  foreignKey: 'departmentId',
  as: 'members',
});
User.belongsTo(Department, {
  foreignKey: 'departmentId',
  as: 'departmentRef',
  onDelete: 'SET NULL',
});

// ─── Meeting <-> User (organizer) ────────────────────────────
Meeting.belongsTo(User, {
  foreignKey: 'createdBy',
  as: 'organizer',
  onDelete: 'CASCADE',
});
User.hasMany(Meeting, {
  foreignKey: 'createdBy',
  as: 'organizedMeetings',
});

// ─── Meeting <-> Task ────────────────────────────────────────
Meeting.belongsTo(Task, {
  foreignKey: 'taskId',
  as: 'task',
  onDelete: 'SET NULL',
});

// ─── Meeting <-> Board ───────────────────────────────────────
Meeting.belongsTo(Board, {
  foreignKey: 'boardId',
  as: 'board',
  onDelete: 'SET NULL',
});

// ─── TaskDependency associations ─────────────────────────────
TaskDependency.belongsTo(Task, { as: 'task', foreignKey: 'taskId', onDelete: 'CASCADE' });
TaskDependency.belongsTo(Task, { as: 'dependsOnTask', foreignKey: 'dependsOnTaskId', onDelete: 'CASCADE' });
TaskDependency.belongsTo(User, { as: 'autoAssignTo', foreignKey: 'autoAssignToUserId', onDelete: 'SET NULL' });
TaskDependency.belongsTo(User, { as: 'createdBy', foreignKey: 'createdById', onDelete: 'CASCADE' });

Task.hasMany(TaskDependency, { as: 'dependencies', foreignKey: 'taskId' });
Task.hasMany(TaskDependency, { as: 'dependents', foreignKey: 'dependsOnTaskId' });

// ─── Task <-> User (scheduledBy) ─────────────────────────────
Task.belongsTo(User, { as: 'scheduler', foreignKey: 'scheduledBy', onDelete: 'SET NULL' });

module.exports = {
  sequelize,
  User,
  Board,
  Task,
  Comment,
  Notification,
  FileAttachment,
  Subtask,
  WorkLog,
  Activity,
  TimeBlock,
  Department,
  Meeting,
  TaskDependency,
  Automation,
  Workspace,
  PermissionGrant,
  AccessRequest,
  TaskWatcher,
  Announcement,
  Label,
  TaskLabel,
  DueDateExtension,
  HelpRequest,
  PromotionHistory,
  HierarchyLevel,
};

// ─── Automation <-> Board/User ───────────────────────────────
Automation.belongsTo(Board, { foreignKey: 'boardId', as: 'board', onDelete: 'CASCADE' });
Automation.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'CASCADE' });

// ─── Workspace <-> User (creator) ────────────────────────────
Workspace.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'CASCADE' });
User.hasMany(Workspace, { foreignKey: 'createdBy', as: 'createdWorkspaces' });

// ─── Workspace <-> Board ─────────────────────────────────────
Board.belongsTo(Workspace, { foreignKey: 'workspaceId', as: 'workspace', onDelete: 'SET NULL' });
Workspace.hasMany(Board, { foreignKey: 'workspaceId', as: 'boards' });

// ─── Workspace <-> User (members) ────────────────────────────
User.belongsTo(Workspace, { foreignKey: 'workspaceId', as: 'workspaceRef', onDelete: 'SET NULL' });
Workspace.hasMany(User, { foreignKey: 'workspaceId', as: 'workspaceMembers' });

// ─── User <-> User (manager mapping) ─────────────────────────
User.belongsTo(User, { foreignKey: 'managerId', as: 'manager', onDelete: 'SET NULL' });
User.hasMany(User, { foreignKey: 'managerId', as: 'teamMembers' });

// ─── PermissionGrant <-> User ────────────────────────────────
PermissionGrant.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
PermissionGrant.belongsTo(User, { foreignKey: 'grantedBy', as: 'granter', onDelete: 'CASCADE' });
User.hasMany(PermissionGrant, { foreignKey: 'userId', as: 'permissions' });

// ─── AccessRequest <-> User ─────────────────────────────────
AccessRequest.belongsTo(User, { foreignKey: 'userId', as: 'requester', onDelete: 'CASCADE' });
AccessRequest.belongsTo(User, { foreignKey: 'reviewedBy', as: 'reviewer', onDelete: 'SET NULL' });
User.hasMany(AccessRequest, { foreignKey: 'userId', as: 'accessRequests' });

// ─── TaskWatcher <-> User/Task ──────────────────────────────
TaskWatcher.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
TaskWatcher.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });
User.hasMany(TaskWatcher, { foreignKey: 'userId', as: 'watchedTasks' });
Task.hasMany(TaskWatcher, { foreignKey: 'taskId', as: 'watchers' });

// ─── Announcement <-> User/Workspace ─────────────────────────
Announcement.belongsTo(User, { foreignKey: 'createdBy', as: 'author', onDelete: 'CASCADE' });
Announcement.belongsTo(Workspace, { foreignKey: 'workspaceId', as: 'workspace', onDelete: 'SET NULL' });
User.hasMany(Announcement, { foreignKey: 'createdBy', as: 'announcements' });
Workspace.hasMany(Announcement, { foreignKey: 'workspaceId', as: 'announcements' });

// ─── Label <-> Board/User ────────────────────────────────────
Label.belongsTo(Board, { foreignKey: 'boardId', as: 'board', onDelete: 'CASCADE' });
Label.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'CASCADE' });
Board.hasMany(Label, { foreignKey: 'boardId', as: 'labels' });

// ─── Task <-> Label (many-to-many via TaskLabel) ─────────────
Task.belongsToMany(Label, { through: TaskLabel, foreignKey: 'taskId', otherKey: 'labelId', as: 'labels' });
Label.belongsToMany(Task, { through: TaskLabel, foreignKey: 'labelId', otherKey: 'taskId', as: 'tasks' });

// ─── DueDateExtension <-> Task/User ─────────────────────────
DueDateExtension.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });
DueDateExtension.belongsTo(User, { foreignKey: 'requestedBy', as: 'requester', onDelete: 'CASCADE' });
DueDateExtension.belongsTo(User, { foreignKey: 'reviewedBy', as: 'reviewer', onDelete: 'SET NULL' });
Task.hasMany(DueDateExtension, { foreignKey: 'taskId', as: 'extensionRequests' });

// ─── HelpRequest <-> Task/User ──────────────────────────────
HelpRequest.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });
HelpRequest.belongsTo(User, { foreignKey: 'requestedBy', as: 'requester', onDelete: 'CASCADE' });
HelpRequest.belongsTo(User, { foreignKey: 'requestedTo', as: 'helper', onDelete: 'CASCADE' });
Task.hasMany(HelpRequest, { foreignKey: 'taskId', as: 'helpRequests' });
User.hasMany(HelpRequest, { foreignKey: 'requestedTo', as: 'helpRequestsReceived' });

// ─── PromotionHistory <-> User ──────────────────────────────
PromotionHistory.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
PromotionHistory.belongsTo(User, { foreignKey: 'promotedBy', as: 'promoter', onDelete: 'CASCADE' });
User.hasMany(PromotionHistory, { foreignKey: 'userId', as: 'promotions' });
