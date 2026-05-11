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
const DependencyRequest = require('./DependencyRequest');
const Automation = require('./Automation');
const Workspace = require('./Workspace');
const PermissionGrant = require('./PermissionGrant');
const AccessRequest = require('./AccessRequest');
const TaskWatcher = require('./TaskWatcher');
const Announcement = require('./Announcement');
const Label = require('./Label');
const TaskLabel = require('./TaskLabel');
const TaskReference = require('./TaskReference');
const TaskLink = require('./TaskLink');
const DueDateExtension = require('./DueDateExtension');
const HelpRequest = require('./HelpRequest');
const PromotionHistory = require('./PromotionHistory');
const HierarchyLevel = require('./HierarchyLevel');
const IntegrationConfig = require('./IntegrationConfig');
const TaskOwner = require('./TaskOwner');
const TaskAssignee = require('./TaskAssignee');
const TaskReminder = require('./TaskReminder');
const TaskApprovalFlow = require('./TaskApprovalFlow');
const RecurringTaskTemplate = require('./RecurringTaskTemplate');
const Note = require('./Note');
const Feedback = require('./Feedback');
const AIConfig = require('./AIConfig');
const AIProvider = require('./AIProvider');
const TranscriptionProvider = require('./TranscriptionProvider');
const TranscriptSegment = require('./TranscriptSegment');
const ApiKey = require('./ApiKey');
const Webhook = require('./Webhook');
const WebhookDelivery = require('./WebhookDelivery');
const TeamsNotificationLog = require('./TeamsNotificationLog');
const ManagerRelation = require('./ManagerRelation');
const BoardMember = require('./BoardMember');
const UserBoardOrder = require('./UserBoardOrder');
const UserWorkspaceOrder = require('./UserWorkspaceOrder');
const PushSubscription = require('./PushSubscription');
const SystemSetting = require('./SystemSetting');
const RefreshToken = require('./RefreshToken');
const PendingLoginToken = require('./PendingLoginToken');

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
  through: BoardMember,
  foreignKey: 'boardId',
  otherKey: 'userId',
  as: 'members',
  timestamps: true,
});
User.belongsToMany(Board, {
  through: BoardMember,
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
TaskDependency.belongsTo(User, { as: 'archiver', foreignKey: 'archivedBy', onDelete: 'SET NULL' });

Task.hasMany(TaskDependency, { as: 'dependencies', foreignKey: 'taskId' });
Task.hasMany(TaskDependency, { as: 'dependents', foreignKey: 'dependsOnTaskId' });

// ─── DependencyRequest associations ──────────────────────────
// New first-class "blocker work" record. Replaces the old behaviour where
// adding a dependency silently created a Task on the assignee's board.
// User FKs use SET NULL so historical rows survive user deletion (the UI
// renders "Assignee unavailable" / "Requester unavailable" in that case).
DependencyRequest.belongsTo(Task,      { as: 'parentTask',       foreignKey: 'parentTaskId',           onDelete: 'CASCADE' });
// Phase 13 — back-pointer to the materialized shadow Task created on
// first transition out of pending. SET NULL so the dep row survives a
// task delete; the dep stays as the system of record either way.
DependencyRequest.belongsTo(Task,      { as: 'linkedTask',       foreignKey: 'linkedTaskId',           onDelete: 'SET NULL' });
DependencyRequest.belongsTo(User,      { as: 'requestedBy',      foreignKey: 'requestedByUserId',      onDelete: 'SET NULL' });
DependencyRequest.belongsTo(User,      { as: 'assignedTo',       foreignKey: 'assignedToUserId',       onDelete: 'SET NULL' });
DependencyRequest.belongsTo(User,      { as: 'originalAssigner', foreignKey: 'originalAssignerUserId', onDelete: 'SET NULL' });
DependencyRequest.belongsTo(User,      { as: 'completedBy',      foreignKey: 'completedByUserId',      onDelete: 'SET NULL' });
DependencyRequest.belongsTo(User,      { as: 'archiver',         foreignKey: 'archivedBy',             onDelete: 'SET NULL' });
DependencyRequest.belongsTo(Board,     { as: 'board',            foreignKey: 'boardId',                onDelete: 'CASCADE' });
DependencyRequest.belongsTo(Workspace, { as: 'workspace',        foreignKey: 'workspaceId',            onDelete: 'SET NULL' });

Task.hasMany(DependencyRequest, { as: 'dependencyRequests', foreignKey: 'parentTaskId' });
User.hasMany(DependencyRequest, { as: 'assignedDependencyRequests',  foreignKey: 'assignedToUserId' });
User.hasMany(DependencyRequest, { as: 'requestedDependencyRequests', foreignKey: 'requestedByUserId' });

// ─── Task <-> User (multi-owner via TaskOwner) ──────────────
Task.belongsToMany(User, { through: TaskOwner, as: 'owners', foreignKey: 'taskId', otherKey: 'userId' });
User.belongsToMany(Task, { through: TaskOwner, as: 'ownedTasks', foreignKey: 'userId', otherKey: 'taskId' });

// ─── Task <-> User (assignees & supervisors via TaskAssignee) ──
Task.hasMany(TaskAssignee, { foreignKey: 'taskId', as: 'taskAssignees' });
TaskAssignee.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });
TaskAssignee.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
User.hasMany(TaskAssignee, { foreignKey: 'userId', as: 'taskAssignments' });

// ─── Task <-> TaskReminder ──────────────────────────────────
Task.hasMany(TaskReminder, { foreignKey: 'taskId', as: 'reminders', onDelete: 'CASCADE' });
TaskReminder.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });

// ─── Task <-> TaskApprovalFlow (normalized approval chain) ──
// `approvalFlows` is ordered by level ASC at query time. User FK is SET NULL
// so the row survives if an approver is later deleted; userName/role snapshots
// preserve the timeline display.
Task.hasMany(TaskApprovalFlow, { foreignKey: 'taskId', as: 'approvalFlows', onDelete: 'CASCADE' });
TaskApprovalFlow.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });
TaskApprovalFlow.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'SET NULL' });
User.hasMany(TaskApprovalFlow, { foreignKey: 'userId', as: 'approvalSteps' });

// ─── RecurringTaskTemplate associations ─────────────────────
// Templates own many generated Task instances. Instance.recurringTemplateId is
// SET NULL on template hard-delete so historical instances survive (we soft-
// archive by default — `archivedAt` on the template — but defense in depth).
RecurringTaskTemplate.belongsTo(Board, { foreignKey: 'boardId', as: 'board', onDelete: 'CASCADE' });
RecurringTaskTemplate.belongsTo(User, { foreignKey: 'assigneeId', as: 'assignee', onDelete: 'CASCADE' });
RecurringTaskTemplate.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'CASCADE' });
RecurringTaskTemplate.hasMany(Task, { foreignKey: 'recurringTemplateId', as: 'instances' });

Board.hasMany(RecurringTaskTemplate, { foreignKey: 'boardId', as: 'recurringTemplates' });
User.hasMany(RecurringTaskTemplate, { foreignKey: 'assigneeId', as: 'assignedRecurringTemplates' });
User.hasMany(RecurringTaskTemplate, { foreignKey: 'createdBy', as: 'createdRecurringTemplates' });

Task.belongsTo(RecurringTaskTemplate, { foreignKey: 'recurringTemplateId', as: 'recurringTemplate', onDelete: 'SET NULL' });

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
  DependencyRequest,
  Automation,
  Workspace,
  PermissionGrant,
  AccessRequest,
  TaskWatcher,
  Announcement,
  Label,
  TaskLabel,
  TaskReference,
  TaskLink,
  DueDateExtension,
  HelpRequest,
  PromotionHistory,
  HierarchyLevel,
  IntegrationConfig,
  TaskOwner,
  TaskAssignee,
  TaskReminder,
  TaskApprovalFlow,
  RecurringTaskTemplate,
  Note,
  Feedback,
  AIConfig,
  AIProvider,
  TranscriptionProvider,
  TranscriptSegment,
  ApiKey,
  Webhook,
  WebhookDelivery,
  TeamsNotificationLog,
  ManagerRelation,
  BoardMember,
  UserBoardOrder,
  UserWorkspaceOrder,
  PushSubscription,
  SystemSetting,
  RefreshToken,
  PendingLoginToken,
};

// ─── RefreshToken <-> User ───────────────────────────────────────────
// CASCADE on delete: deactivating/removing a user wipes their refresh tokens
// so a deactivated account cannot be re-activated by replaying old tokens.
RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'refreshTokens' });

// ─── PendingLoginToken <-> User ──────────────────────────────────────
// Short-lived one-shot confirmation tokens for the "another session is
// active, force logout?" flow. CASCADE on delete so account deletion
// wipes any in-flight pending tokens.
PendingLoginToken.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
User.hasMany(PendingLoginToken, { foreignKey: 'userId', as: 'pendingLoginTokens' });

// ─── PushSubscription <-> User ───────────────────────────────
PushSubscription.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
User.hasMany(PushSubscription, { foreignKey: 'userId', as: 'pushSubscriptions' });

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

// ─── User <-> User (manager mapping — primary manager) ───────
User.belongsTo(User, { foreignKey: 'managerId', as: 'manager', onDelete: 'SET NULL' });
User.hasMany(User, { foreignKey: 'managerId', as: 'teamMembers' });

// ─── ManagerRelation (multi-manager junction table) ──────────
ManagerRelation.belongsTo(User, { foreignKey: 'employeeId', as: 'employee', onDelete: 'CASCADE' });
ManagerRelation.belongsTo(User, { foreignKey: 'managerId', as: 'manager', onDelete: 'CASCADE' });
User.hasMany(ManagerRelation, { foreignKey: 'employeeId', as: 'managerRelations' });
User.hasMany(ManagerRelation, { foreignKey: 'managerId', as: 'subordinateRelations' });

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

// ─── Task <-> TaskReference (1-to-many) ──────────────────────
// Each task may carry multiple free-form reference entries (ticket IDs,
// invoice numbers, doc IDs). CASCADE on delete so archiving a task wipes
// its references; the assoc alias `references` matches the API field name.
Task.hasMany(TaskReference, { foreignKey: 'taskId', as: 'references', onDelete: 'CASCADE' });
TaskReference.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });
TaskReference.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'SET NULL' });

// ─── Task <-> TaskLink (1-to-many) ───────────────────────────
// Multiple external URLs per task (Drive files, ticket links, websites).
// Aliased `taskLinks` on the Task side to avoid collision with any other
// `links` field reserved for ad-hoc client metadata in the future.
Task.hasMany(TaskLink, { foreignKey: 'taskId', as: 'taskLinks', onDelete: 'CASCADE' });
TaskLink.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });
TaskLink.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'SET NULL' });

// ─── DueDateExtension <-> Task/User ─────────────────────────
DueDateExtension.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });
DueDateExtension.belongsTo(User, { foreignKey: 'requestedBy', as: 'requester', onDelete: 'CASCADE' });
DueDateExtension.belongsTo(User, { foreignKey: 'reviewedBy', as: 'reviewer', onDelete: 'SET NULL' });
Task.hasMany(DueDateExtension, { foreignKey: 'taskId', as: 'extensionRequests' });

// ─── HelpRequest <-> Task/User ──────────────────────────────
HelpRequest.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });
HelpRequest.belongsTo(User, { foreignKey: 'requestedBy', as: 'requester', onDelete: 'CASCADE' });
HelpRequest.belongsTo(User, { foreignKey: 'requestedTo', as: 'helper', onDelete: 'CASCADE' });
HelpRequest.belongsTo(User, { foreignKey: 'archivedBy', as: 'archiver', onDelete: 'SET NULL' });
Task.hasMany(HelpRequest, { foreignKey: 'taskId', as: 'helpRequests' });
User.hasMany(HelpRequest, { foreignKey: 'requestedTo', as: 'helpRequestsReceived' });

// ─── PromotionHistory <-> User ──────────────────────────────
PromotionHistory.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
PromotionHistory.belongsTo(User, { foreignKey: 'promotedBy', as: 'promoter', onDelete: 'CASCADE' });
User.hasMany(PromotionHistory, { foreignKey: 'userId', as: 'promotions' });

// ─── IntegrationConfig <-> User (configuredBy) ──────────────
IntegrationConfig.belongsTo(User, { foreignKey: 'configuredBy', as: 'configurer', onDelete: 'SET NULL' });

// ─── AIConfig <-> User (configuredBy) ───────────────────────
AIConfig.belongsTo(User, { foreignKey: 'configuredBy', as: 'configurer', onDelete: 'SET NULL' });

// ─── SystemSetting <-> User (updatedBy) ─────────────────────
SystemSetting.belongsTo(User, { foreignKey: 'updatedBy', as: 'updater', onDelete: 'SET NULL' });

// ─── AIProvider <-> User (configuredBy) ─────────────────────
AIProvider.belongsTo(User, { foreignKey: 'configuredBy', as: 'configurer', onDelete: 'SET NULL' });

// ─── TranscriptionProvider <-> User (configuredBy) ──────────
TranscriptionProvider.belongsTo(User, { foreignKey: 'configuredBy', as: 'configurer', onDelete: 'SET NULL' });

// ─── TranscriptSegment <-> Note ─────────────────────────────
TranscriptSegment.belongsTo(Note, { foreignKey: 'noteId', as: 'note', onDelete: 'CASCADE' });
Note.hasMany(TranscriptSegment, { foreignKey: 'noteId', as: 'segments', onDelete: 'CASCADE' });

// ─── Note <-> User ──────────────────────────────────────────
Note.belongsTo(User, { foreignKey: 'userId', as: 'author', onDelete: 'CASCADE' });
User.hasMany(Note, { foreignKey: 'userId', as: 'notes' });

// ─── Feedback <-> User ──────────────────────────────────────
Feedback.belongsTo(User, { foreignKey: 'userId', as: 'submitter', onDelete: 'CASCADE' });
User.hasMany(Feedback, { foreignKey: 'userId', as: 'feedbacks' });

// ─── ApiKey <-> User (creator) ──────────────────────────────
ApiKey.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'CASCADE' });
User.hasMany(ApiKey, { foreignKey: 'createdBy', as: 'apiKeys' });

// ─── Webhook <-> ApiKey / User / Deliveries ─────────────────
// Outbound webhooks let an external app subscribe to events (task.created /
// updated / deleted). Each webhook is bound to an ApiKey so revoking the key
// also revokes the webhook. Deliveries are kept for retry + audit visibility.
Webhook.belongsTo(ApiKey, { foreignKey: 'apiKeyId', as: 'apiKey', onDelete: 'CASCADE' });
ApiKey.hasMany(Webhook, { foreignKey: 'apiKeyId', as: 'webhooks' });
Webhook.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'CASCADE' });
Webhook.hasMany(WebhookDelivery, { foreignKey: 'webhookId', as: 'deliveries', onDelete: 'CASCADE' });
WebhookDelivery.belongsTo(Webhook, { foreignKey: 'webhookId', as: 'webhook', onDelete: 'CASCADE' });

// ─── TeamsNotificationLog <-> User/Task ────────────────────
TeamsNotificationLog.belongsTo(User, { foreignKey: 'user_id', as: 'user', onDelete: 'CASCADE' });
TeamsNotificationLog.belongsTo(Task, { foreignKey: 'task_id', as: 'task', onDelete: 'SET NULL' });
User.hasMany(TeamsNotificationLog, { foreignKey: 'user_id', as: 'teamsNotifications' });
Task.hasMany(TeamsNotificationLog, { foreignKey: 'task_id', as: 'teamsNotifications' });
