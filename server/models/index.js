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
const StatusTemplate = require('./StatusTemplate');
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
// Doc Editor Phase B — collaborative document model + periodic version snapshots.
const Doc = require('./Doc');
const DocVersion = require('./DocVersion');
// Doc Editor Phase D Slice 1 — @-mentions per doc (notifications + back-refs).
const DocMention = require('./DocMention');
// Doc Editor Phase D Slice 2 — task chips per doc (back-refs only).
const DocTaskReference = require('./DocTaskReference');
// Doc Editor Phase F — threaded comments anchored to selection text.
const DocComment = require('./DocComment');
// feat/docs-personal-notion Phase 2 — explicit per-user access grants.
// Replaces the workspace/board/role membership fallback as the source of
// truth for "can this user see this doc".
const DocAccess = require('./DocAccess');
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
// Workflow Canvas Phase W1 — visual node-graph automation. Coexists with
// the legacy `Automation` table; both engines fire on the same triggers.
const Workflow = require('./Workflow');
const WorkflowNode = require('./WorkflowNode');
const WorkflowEdge = require('./WorkflowEdge');
const WorkflowRun = require('./WorkflowRun');
const WorkflowWait = require('./WorkflowWait');
// Forms Phase F1 — workspace-scoped data collection forms + submissions.
// Public submissions hit /api/forms/public/:slug/submit (unauthenticated).
const Form = require('./Form');
const FormSubmission = require('./FormSubmission');
// Tier-1 administered DB backup catalog — metadata for every dump file under
// DB_BACKUP_DIR. Source of truth for the /api/admin/backups/* endpoints.
const BackupRecord = require('./BackupRecord');
// Separate catalog for uploaded-FILES backups (tar.gz of the uploads/ dir).
// Kept independent from BackupRecord so the two subsystems never interfere.
const FileBackupRecord = require('./FileBackupRecord');

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

// ─── TimeBlock <-> creator (delegation audit) ────────────────
TimeBlock.belongsTo(User, {
  foreignKey: 'createdById',
  as: 'createdBy',
  onDelete: 'SET NULL',
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
  StatusTemplate,
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
  Doc,
  DocVersion,
  DocMention,
  DocTaskReference,
  DocComment,
  DocAccess,
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
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  WorkflowRun,
  WorkflowWait,
  Form,
  FormSubmission,
  BackupRecord,
  FileBackupRecord,
};

// ─── BackupRecord <-> User (creator) ────────────────────────
// createdBy is null for scheduled / pre_restore runs; SET NULL on user delete
// so historical backup metadata survives an admin offboarding.
BackupRecord.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'SET NULL' });

// ─── FileBackupRecord <-> User (creator) ────────────────────
// Same SET NULL rationale as BackupRecord above.
FileBackupRecord.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'SET NULL' });

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

// ─── StatusTemplate <-> Board / User (creator) ───────────────
// Phase 2 — board-scoped reusable status tile groups. Cascade on board delete
// so removing a board cleans up its template library. Cascade on user delete
// matches the rest of the project (Labels, Boards, etc.) — deactivating a
// creator wipes their authored templates. Tasks created from a template are
// self-contained (statusConfig holds a snapshot of the template's statuses
// at create time) so deletion never breaks historical task rendering.
StatusTemplate.belongsTo(Board, { foreignKey: 'boardId', as: 'board', onDelete: 'CASCADE' });
StatusTemplate.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'CASCADE' });
Board.hasMany(StatusTemplate, { foreignKey: 'boardId', as: 'statusTemplates' });

// ─── Doc Editor (Phase B) ────────────────────────────────────
// Doc belongs to one workspace and one author. Versions hang off the doc
// with CASCADE so archiving/deleting a doc cleans up snapshots too.
// onDelete kept as CASCADE to mirror the actual FK constraint installed in
// server.js (Phase 2 deliberately does NOT alter the constraint; deleting a
// workspace is so rare that the FK behavior change can wait for Phase 3).
Doc.belongsTo(Workspace, { foreignKey: 'workspaceId', as: 'workspace', onDelete: 'CASCADE' });
Doc.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'SET NULL' });
Doc.belongsTo(User, { foreignKey: 'lastEditedBy', as: 'lastEditor', onDelete: 'SET NULL' });
// feat/docs-personal-notion Phase 2 — canonical owner. The list endpoint
// joins on this to surface "My docs" without going through workspace.
Doc.belongsTo(User, { foreignKey: 'ownerUserId', as: 'owner', onDelete: 'SET NULL' });
User.hasMany(Doc, { foreignKey: 'ownerUserId', as: 'ownedDocs' });
// Used by the global /archive page to render "archived by X" attribution.
// Mirrors the pattern on HelpRequest / TaskDependency / DependencyRequest.
Doc.belongsTo(User, { foreignKey: 'archivedBy', as: 'archiver', onDelete: 'SET NULL' });
Workspace.hasMany(Doc, { foreignKey: 'workspaceId', as: 'docs' });
Doc.hasMany(DocVersion, { foreignKey: 'docId', as: 'versions', onDelete: 'CASCADE' });
DocVersion.belongsTo(Doc, { foreignKey: 'docId', as: 'doc', onDelete: 'CASCADE' });
DocVersion.belongsTo(User, { foreignKey: 'savedBy', as: 'author', onDelete: 'SET NULL' });

// ─── Doc Editor Phase D Slice 1 — @-mentions ─────────────────
// Each doc tracks an explicit list of users it currently mentions, separate
// from the contentJson body. The body stays the source of truth for what
// the doc says; this table is the index for notifications + back-refs.
Doc.hasMany(DocMention, { foreignKey: 'docId', as: 'mentions', onDelete: 'CASCADE' });
DocMention.belongsTo(Doc, { foreignKey: 'docId', as: 'doc', onDelete: 'CASCADE' });
DocMention.belongsTo(User, { foreignKey: 'mentionedUserId', as: 'mentionedUser', onDelete: 'CASCADE' });
DocMention.belongsTo(User, { foreignKey: 'mentionedByUserId', as: 'mentionedBy', onDelete: 'SET NULL' });
User.hasMany(DocMention, { foreignKey: 'mentionedUserId', as: 'docMentions' });

// ─── Doc Editor Phase D Slice 2 — task chips ────────────────
// Tasks referenced inside a doc body via the task-chip extension. One row
// per (doc, task). Used for bidirectional links — Task.docReferences gives
// a task its "referenced in N docs" backlink.
Doc.hasMany(DocTaskReference, { foreignKey: 'docId', as: 'taskReferences', onDelete: 'CASCADE' });
DocTaskReference.belongsTo(Doc, { foreignKey: 'docId', as: 'doc', onDelete: 'CASCADE' });
DocTaskReference.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'CASCADE' });
DocTaskReference.belongsTo(User, { foreignKey: 'addedByUserId', as: 'addedBy', onDelete: 'SET NULL' });
Task.hasMany(DocTaskReference, { foreignKey: 'taskId', as: 'docReferences' });

// ─── Doc Editor Phase F — threaded selection-anchored comments ──
// Threads: top-level comments (parentId NULL) + child replies. The
// self-referential FK cascades so deleting a parent wipes orphan replies.
// Author / resolver FKs use SET NULL so historical comments survive user
// deletion; the UI renders the missing actor as "Unknown user."
Doc.hasMany(DocComment, { foreignKey: 'docId', as: 'comments', onDelete: 'CASCADE' });
DocComment.belongsTo(Doc, { foreignKey: 'docId', as: 'doc', onDelete: 'CASCADE' });
DocComment.belongsTo(User, { foreignKey: 'authorId', as: 'author', onDelete: 'SET NULL' });
DocComment.belongsTo(User, { foreignKey: 'resolvedBy', as: 'resolver', onDelete: 'SET NULL' });
DocComment.hasMany(DocComment, { foreignKey: 'parentId', as: 'replies', onDelete: 'CASCADE' });
DocComment.belongsTo(DocComment, { foreignKey: 'parentId', as: 'parent', onDelete: 'CASCADE' });
User.hasMany(DocComment, { foreignKey: 'authorId', as: 'authoredDocComments' });

// ─── Doc Editor feat/docs-personal-notion Phase 2 — DocAccess ────
// Explicit per-user grants. Reads cascade with the doc; user delete cleans
// up their own grant rows. Resolver in services/docAccessService.js. The
// reverse User → DocAccess hasMany powers "list docs visible to me" via
// SQL joins (no per-row N+1).
Doc.hasMany(DocAccess, { foreignKey: 'docId', as: 'accessGrants', onDelete: 'CASCADE' });
DocAccess.belongsTo(Doc, { foreignKey: 'docId', as: 'doc', onDelete: 'CASCADE' });
DocAccess.belongsTo(User, { foreignKey: 'userId', as: 'user', onDelete: 'CASCADE' });
DocAccess.belongsTo(User, { foreignKey: 'grantedByUserId', as: 'grantedBy', onDelete: 'SET NULL' });
User.hasMany(DocAccess, { foreignKey: 'userId', as: 'docAccessGrants' });

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

// ─── Workflow Canvas (Phase W1) ─────────────────────────────
// Workflows live in a workspace, optionally scoped to a board. Nodes +
// edges hang off the workflow with CASCADE so deleting the workflow
// wipes its canvas state. Runs are an append-only audit log; they too
// cascade-delete with the workflow (drop the workflow, drop the audit).
// The legacy Automation table is untouched — both engines coexist.
Workflow.belongsTo(Workspace, { foreignKey: 'workspaceId', as: 'workspace', onDelete: 'CASCADE' });
Workflow.belongsTo(Board, { foreignKey: 'boardId', as: 'board', onDelete: 'CASCADE' });
Workflow.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'SET NULL' });
Workspace.hasMany(Workflow, { foreignKey: 'workspaceId', as: 'workflows' });
Board.hasMany(Workflow, { foreignKey: 'boardId', as: 'workflows' });

Workflow.hasMany(WorkflowNode, { foreignKey: 'workflowId', as: 'nodes', onDelete: 'CASCADE' });
WorkflowNode.belongsTo(Workflow, { foreignKey: 'workflowId', as: 'workflow', onDelete: 'CASCADE' });

Workflow.hasMany(WorkflowEdge, { foreignKey: 'workflowId', as: 'edges', onDelete: 'CASCADE' });
WorkflowEdge.belongsTo(Workflow, { foreignKey: 'workflowId', as: 'workflow', onDelete: 'CASCADE' });
WorkflowEdge.belongsTo(WorkflowNode, { foreignKey: 'sourceNodeId', as: 'sourceNode', onDelete: 'CASCADE' });
WorkflowEdge.belongsTo(WorkflowNode, { foreignKey: 'targetNodeId', as: 'targetNode', onDelete: 'CASCADE' });

Workflow.hasMany(WorkflowRun, { foreignKey: 'workflowId', as: 'runs', onDelete: 'CASCADE' });
WorkflowRun.belongsTo(Workflow, { foreignKey: 'workflowId', as: 'workflow', onDelete: 'CASCADE' });

// W3 — workflow waits. CASCADE so deleting a workflow also drops pending
// resumes; otherwise the cron job would try to resume into a missing graph.
Workflow.hasMany(WorkflowWait, { foreignKey: 'workflowId', as: 'waits', onDelete: 'CASCADE' });
WorkflowWait.belongsTo(Workflow, { foreignKey: 'workflowId', as: 'workflow', onDelete: 'CASCADE' });
WorkflowWait.belongsTo(WorkflowNode, { foreignKey: 'fromNodeId', as: 'fromNode', onDelete: 'CASCADE' });

// ─── Form <-> Workspace / Board / User / Submissions ─────────────────
Form.belongsTo(Workspace, { foreignKey: 'workspaceId', as: 'workspace', onDelete: 'CASCADE' });
Form.belongsTo(Board, { foreignKey: 'targetBoardId', as: 'targetBoard', onDelete: 'SET NULL' });
Form.belongsTo(User, { foreignKey: 'createdBy', as: 'creator', onDelete: 'SET NULL' });
Form.hasMany(FormSubmission, { foreignKey: 'formId', as: 'submissions', onDelete: 'CASCADE' });
FormSubmission.belongsTo(Form, { foreignKey: 'formId', as: 'form', onDelete: 'CASCADE' });
FormSubmission.belongsTo(User, { foreignKey: 'submittedByUserId', as: 'submittedBy', onDelete: 'SET NULL' });
FormSubmission.belongsTo(Task, { foreignKey: 'taskId', as: 'task', onDelete: 'SET NULL' });
