# Aniston Project Hub

Monday.com-style task management platform with RBAC, real-time updates, team dashboards, meetings, departments, and time planning.

## Quick Start

```bash
# Prerequisites: Docker (for PostgreSQL), Node.js 18+
# PostgreSQL runs in Docker on localhost:5432 (db: aniston_project_hub, user: postgres, pass: postgres)

npm run install:all       # Install server + client deps
cd server && node seed-users.js  # Seed test users
npm run dev               # Starts both server (5000) and client (3000)
```

**Test accounts:** admin@aniston.com / Admin@1234, manager@aniston.com / Manager@1234, john@aniston.com / John@1234, sara@aniston.com / Sara@1234

## Tech Stack

- **Frontend:** React 18, Vite (port 3000), TailwindCSS, Recharts, lucide-react, date-fns, @hello-pangea/dnd, Socket.io client, framer-motion, exceljs, file-saver
- **Backend:** Express.js (port 5000), Sequelize ORM, PostgreSQL 16 (Docker), JWT auth, Socket.io, Multer, pdfkit, helmet, morgan, express-rate-limit, express-validator, xss, web-push, winston, node-cron
- **DB:** PostgreSQL with UUID primary keys, JSONB columns, ENUM types

## Architecture

```
client/src/
├── components/
│   ├── auth/             # Login, Register, ForgotPassword, ResetPassword
│   ├── board/            # BoardCard, TaskGroup, TaskRow, StatusCell, PersonCell, DateCell, PriorityCell, BoardSettingsModal, CreateBoardModal, AdvancedFilters, AddColumnModal, AutomationsPanel, BulkActionBar, CSVImportModal, CalendarView, KanbanView, CheckboxCell, ColumnHeaderMenu, ColumnInfoTooltip, CreateWorkspaceModal, DueDateExtensionModal, HelpRequestModal, LabelCell, LinkCell, NumberCell, ProgressCell, SortDropdown, TextCell, TimelineView
│   ├── task/             # TaskModal, TaskComments, TaskFiles, SubtaskList, ActivityFeed, WorkLogSection, ApprovalSection, ConflictWarning, DelegateTaskModal, DueDateExtensionModal, HelpRequestModal, RecurrenceSection, WatcherSection
│   ├── layout/           # Layout, Sidebar (dark theme), Header
│   ├── common/           # Modal, Button, Avatar, LoadingSpinner, DropdownMenu, NotificationsPanel, GlobalSearch, AIAssistant, ErrorBoundary, FeedbackWidget, GrammarSuggestion, KeyboardShortcuts, OnboardingTour, PageTransition, PortalDropdown, ProfileModal, SOPViewer, Skeleton, Toast, ToolsFAB, UpdatePrompt, VoiceNotes
│   ├── dashboard/        # MemberDrillDown, RoleDashboard
│   ├── department/       # DepartmentModal
│   ├── dependencies/     # DependencyBadge, DependencySelector, TeamsIntegrationSettings, TeamPlannerModal, WorkspaceAssignModal, WorkspaceSetupModal
│   ├── meeting/          # MeetingModal
│   ├── user/             # CreateUserModal, EditUserModal, ResetPasswordModal
│   └── timeplan/         # DayTimeline, TimeBlockForm
├── context/AuthContext.jsx   # Auth state + role helpers (isAdmin, isManager, isMember, canManage)
├── hooks/                # useSocket.js, useGrammarCorrection.js
├── pages/                # 28 page components (see Pages & Routes table)
├── services/
│   ├── api.js            # Axios with JWT interceptor, base: /api
│   ├── socket.js         # Socket.io client (connect, disconnect, subscribe, joinBoard, leaveBoard)
│   └── pushNotifications.js # Web push subscription management
├── utils/constants.js    # STATUS_CONFIG, PRIORITY_CONFIG, BOARD_DEFAULTS
└── App.jsx               # Routes with ProtectedRoute, ManagerRoute, AdminRoute wrappers

server/
├── config/db.js          # Sequelize connection
├── models/               # 36 model files (see Database Models table)
│   └── index.js          # All associations defined here
├── controllers/          # 30+ controller files (one per resource)
├── middleware/
│   ├── auth.js           # authenticate, adminOnly, managerOrAdmin
│   ├── upload.js         # Multer config (25MB max, images + docs)
│   ├── permissions.js    # hasPermission(resourceType, requiredLevel) — PermissionGrant-based access
│   ├── taskPermissions.js # attachTaskPermissions — 4-level role hierarchy (admin/manager/assistant_manager/member)
│   └── apiKeyAuth.js     # apiKeyOrJwt — API key or JWT authentication for external integrations
├── routes/               # 39 route files
├── services/
│   ├── socketService.js  # Socket.io init, emitToBoard, emitToUser
│   ├── activityService.js # Fire-and-forget logActivity()
│   ├── teamsWebhook.js   # Microsoft Teams webhook notifications
│   ├── aiService.js      # AI provider abstraction (OpenAI/Ollama/DeepSeek)
│   ├── automationService.js # Automation rule evaluation engine
│   ├── assignmentNotificationService.js # Assignment-specific notifications
│   ├── calendarService.js # Calendar event management
│   ├── conflictDetectionService.js # Schedule conflict detection
│   ├── deadlineNotificationService.js # Director plan deadline checks
│   ├── dependencyService.js # Dependency resolution and auto-unblocking
│   ├── notificationService.js # General notification dispatch
│   ├── pushService.js    # Web push (VAPID) notification sending
│   ├── reminderService.js # Reminder processing for deadlineReminderJob
│   ├── teamsCalendarService.js # Teams calendar event sync
│   ├── teamsGraphClient.js # Microsoft Graph API client
│   ├── teamsNotificationService.js # Teams-specific notification sending
│   └── teamsUserSync.js  # M365 user sync logic
├── jobs/
│   ├── reminderJob.js    # Hourly overdue/due-soon checks, daily 3-day warning
│   ├── recurringTaskJob.js # Hourly: creates recurring task instances
│   ├── deadlineReminderJob.js # Every 15 min: processes pending deadline reminders
│   └── priorityEscalationJob.js # Daily midnight: auto-escalates tasks at ≥80% progress to critical
├── server.js             # Entry point — mounts all routes under /api/*
└── seed-users.js         # Seeds 4 test users
```

## Pages & Routes

| Route | Page | Access | Description |
|-------|------|--------|-------------|
| `/login` | Login | Public | Login page (redirects if already logged in) |
| `/forgot-password` | ForgotPassword | Public | Token-based password reset request |
| `/reset-password` | ResetPassword | Public | Password reset with token |
| `/` | HomePage | All | Greeting, quick actions, My Tasks table, recent boards, notification feed |
| `/my-work` | MyWorkPage | All | Personal task view with Table & Calendar tabs, grouped by due date |
| `/boards` | BoardsPage | All | Board library with grid/list view, search, create board |
| `/boards/:id` | BoardPage | All | Board with task groups, drag-drop, filters, search, settings |
| `/boards/:id/dashboard` | DashboardPage | Manager+ | Board-specific analytics |
| `/dashboard` | DashboardPage | Manager+ | Global analytics, stat cards, charts, team overview, member drill-down |
| `/member-dashboard` | MemberDashboardPage | All | Member-specific dashboard view |
| `/manager-dashboard` | ManagerDashboardPage | Manager+ | Manager-specific dashboard with team insights |
| `/admin-dashboard` | AdminDashboardPage | Admin | Admin-level system dashboard |
| `/director-dashboard` | DirectorDashboardPage | Manager+ | Director-level dashboard with high-level stats |
| `/director-plan` | AssistantManagerPlanPage | Manager+ | Daily planner with drag-drop task categories, deadline urgency, Excel export |
| `/timeline` | TimelinePage | All | Gantt chart view with zoom controls |
| `/time-plan` | TimePlanPage | All | Daily time planner (personal + team view for managers) |
| `/reviews` | ReviewPage | All | Weekly review with PDF/CSV export |
| `/profile` | ProfilePage | All | Avatar upload, edit name/department/designation, change password |
| `/meetings` | MeetingsPage | All | Meeting scheduling, accept/decline, stats, date-grouped list |
| `/integrations` | IntegrationsPage | Manager+ | Premium integrations hub (Teams, Slack, Google, Jira) |
| `/archive` | ArchivedPage | Manager+ | View/restore/permanently delete archived boards |
| `/users` | UserManagementPage | Manager+ | Users tab + Departments tab, create/edit/deactivate users, CRUD departments |
| `/admin-settings` | AdminSettingsPage | Admin | System-wide admin settings |
| `/access-requests` | AccessRequestPage | Manager+ | Review/approve/reject access requests |
| `/org-chart` | OrgChartPage | All | Visual org hierarchy tree with promotion history |
| `/cross-team` | CrossTeamTasksPage | All | Cross-team task visibility |
| `/tasks` | TasksPage | All | Global tasks view |
| `/notes` | NotesPage | All | Personal/shared notes |
| `/feedback` | FeedbackPage | Admin | View/manage user feedback submissions |

## API Routes

All routes prefixed with `/api/`:

| Endpoint | Description |
|----------|-------------|
| `/auth` | Login, register, forgot/reset password, profile (GET/PUT), avatar upload, list users |
| `/boards` | CRUD, board members (add/remove), group reorder, export/import, templates |
| `/tasks` | CRUD with RBAC, reorder (drag-drop), bulk update, duplicate, archive. Supports `assignedTo=me` for cross-board fetch |
| `/subtasks` | CRUD within tasks |
| `/worklogs` | Daily work updates per task |
| `/comments` | Task comments with @mentions |
| `/files` | File uploads (Multer, 25MB max), download (rate limited) |
| `/notifications` | List (paginated), mark read, unread count |
| `/activities` | Activity audit log with filters |
| `/dashboard` | Stats, member task breakdown, completion trends, workload charts |
| `/users` | Admin user management: create, update, reset password, toggle status |
| `/timeplans` | Time blocks: CRUD, my blocks, team view, employee view |
| `/reviews` | Weekly review data, PDF download, CSV download |
| `/search` | Global search across tasks and boards (RBAC-aware, rate limited) |
| `/departments` | CRUD departments, assign users |
| `/meetings` | CRUD meetings, my meetings, team meetings, accept/decline |
| `/webhooks` | Microsoft Teams / n8n integration webhooks |
| `/teams` | Microsoft Teams OAuth (auth, callback, status, disconnect, sync-task) |
| `/automations` | CRUD automation rules per board (trigger → action) |
| `/workspaces` | Workspace CRUD, member management |
| `/permissions` | PermissionGrant management |
| `/access-requests` | Access request flow (request/approve/reject) |
| `/task-extras` | Task watchers, approval workflow, recurrence |
| `/announcements` | Team/board announcements CRUD |
| `/labels` | Label CRUD per board |
| `/extensions` | Due date extension requests and approvals |
| `/help-requests` | Help request system (request/respond) |
| `/promotions` | Promotion history records |
| `/hierarchy-levels` | Custom org hierarchy level management |
| `/director-plan` | Director/assistant-manager daily plan CRUD |
| `/archive` | Archive page operations (view/restore archived boards) |
| `/push` | Web push notification subscriptions (VAPID) |
| `/integrations` | Integration configuration (Teams, SSO) |
| `/notes` | Personal notes CRUD |
| `/feedback` | In-app feedback submissions and admin review |
| `/ai` | AI assistant chat, grammar correction, config management |
| `/api-keys` | API key generation/management for external integrations |
| `/external` | HRMS/external employee API (API key authenticated, rate limited) |
| Dependencies | Task dependency get/create/remove, delegate task (mounted at `/api`) |
| `/health` | Health check |

## Role-Based Access Control (RBAC)

**4 roles:** admin, manager, assistant_manager, member. Role hierarchy levels: admin(4) > manager(3) > assistant_manager(2) > member(1). Additionally, `isSuperAdmin` flag grants elevated access.

### Admin (e.g., admin@aniston.com)
**Full system access — the boss who manages everything.**

| Area | Capabilities |
|------|-------------|
| **Users** | Create/edit/deactivate any user, reset passwords, change roles |
| **Departments** | Create/edit/delete departments, assign department heads |
| **Boards** | Create/edit/delete any board, manage members, configure columns/groups |
| **Tasks** | Create/assign tasks to ANY employee, set priority/dates, archive tasks |
| **Assignment** | Assign tasks to employees from the Owner column or TaskModal |
| **Dashboard** | View all boards' stats, team overview, member drill-down, admin dashboard |
| **Meetings** | Schedule meetings/reminders with any employee, cancel/edit any meeting |
| **Reviews** | View all employee reviews, download PDF/CSV |
| **Time Plan** | View any employee's time plan |
| **Admin Settings** | System-wide configuration, AI config, API keys, feedback review |
| **Approvals** | Approve/reject due date extensions, help requests, access requests |

### Manager (e.g., manager@aniston.com)
**Team lead — manages boards, assigns work, tracks progress.**

| Area | Capabilities |
|------|-------------|
| **Users** | Create member accounts, view all users |
| **Departments** | Create/edit departments |
| **Boards** | Create/edit boards, manage members, configure settings |
| **Tasks** | Create/assign tasks, set priority/dates, drag-drop reorder, archive tasks |
| **Assignment** | Assign tasks to employees from Owner column or TaskModal |
| **Dashboard** | View stats for their boards, team overview, member drill-down, manager dashboard |
| **Meetings** | Schedule meetings/reminders, edit/cancel own meetings |
| **Reviews** | View team reviews |
| **Time Plan** | View team time plans |
| **Director Plan** | Daily planner with task categories and deadline tracking |
| **Approvals** | Approve/reject due date extensions and help requests |

### Assistant Manager
**Mid-level role — partial management access, team coordination.**

| Area | Capabilities |
|------|-------------|
| **Tasks** | Board-level access, can manage tasks within assigned boards |
| **Dashboard** | Access to director dashboard and director plan |
| **Time Plan** | View team time plans |
| **Boards** | Partial access based on PermissionGrant records |

### Member / Employee (e.g., john@aniston.com, sara@aniston.com)
**Individual contributor — works on assigned tasks, gives updates.**

| Area | Capabilities |
|------|-------------|
| **Tasks** | View only tasks assigned to them, update status, create self-assigned tasks |
| **Status Updates** | Change task status (Not Started → Working → Stuck → Done → Review) |
| **Subtasks** | Add/update subtasks on their tasks |
| **Work Logs** | Write daily updates on tasks ("What I worked on today") |
| **Comments** | Add comments, upload files on their tasks |
| **My Work** | See all assigned tasks grouped by due date (Table + Calendar view) |
| **Home** | See "My Tasks" dashboard with status/priority/due dates |
| **Meetings** | View meetings they're invited to, accept/decline |
| **Time Plan** | Plan their own daily schedule with time blocks |
| **Reviews** | View/download their own weekly review |
| **Profile** | Edit name, department, designation, avatar, change password |
| **Notes** | Create and manage personal notes |
| **Feedback** | Submit feedback via in-app widget |

## How to Assign Work to an Employee

### Method 1: From the Board (Inline)
1. Login as admin or manager
2. Go to any board (e.g., "Test Board")
3. Click **"+ New task"** to create a task, or click an existing task row
4. Click the **Owner column** (person icon) on the task row
5. A searchable dropdown shows ALL employees — select one
6. The employee will see this task on their Home page and My Work page

### Method 2: From the Task Modal (Detailed)
1. Click on any task to open the Task Modal (right panel)
2. Click the **Owner** field → dropdown shows all users
3. Select the employee
4. Set status, priority, due date, start date
5. Add description, subtasks, tags as needed
6. The employee receives a notification

### Method 3: Quick Task Creation
1. In any board group, click **"+ Add task"** at the bottom
2. Type the task name and press Enter
3. Then click the Owner column to assign it

## Completed Features

### Phase 1 — Core Features
1. **RBAC** — Admin/Manager/Assistant Manager/Member roles at route + controller level
2. **Subtasks** — Checklist items within tasks with status & assignee
3. **Daily Work Updates** — Per-task daily worklogs, grouped by date, RBAC-restricted
4. **Activity Feed** — Auto-logged actions with relative timestamps
5. **Enhanced Dashboard** — Stat cards, pie/bar charts, team overview, board summaries, activity feed

### Phase 2 — Production Features
6. **User Management** — Create/edit/deactivate users, reset passwords, designations
7. **Enhanced Task Assignment** — Members self-assign tasks, priority labels (Urgent/High/Medium/Low)
8. **Dashboard Member Drill-Down** — Click member → see detailed task breakdown with inline management
9. **Employee Time Planning** — Daily time planner with hourly blocks, team view for managers
10. **Review Sheet Download** — Weekly review with task summary, PDF/CSV export
11. **Board Settings/Customization** — 5-tab modal: General, Columns, Groups, Members, Danger Zone
12. **Drag & Drop Reordering** — @hello-pangea/dnd for task reordering within/across groups
13. **Search & Filters** — Global Ctrl+K search + board-level multi-select status/priority/person filters

### Phase 3 — Premium Features
14. **Sidebar Premium Redesign** — Pure black/dark zinc theme, emerald logo, left accent borders
15. **User Profile & Account Settings** — Avatar upload, edit personal info, password change
16. **Department Management** — CRUD departments with color/head, department tab in Team page, dropdown in user forms
17. **Meeting/Reminder Scheduling** — Schedule meetings with participants, accept/decline, link to tasks/boards, notifications
18. **PersonCell Enhancement** — Searchable user dropdown with roles, shows ALL users (not just board members)
19. **Employee Home Dashboard** — "My Tasks" table on homepage showing assigned tasks across all boards

### Phase 4 — Task Dependencies, Auto-Assignment & Teams Integration
20. **Task Dependencies** — TaskDependency model (blocks/required_for/related), circular check, DependencySelector UI, DependencyBadge
21. **Auto-Assignment Chain** — When blocker task completes → dependent tasks auto-unblock → auto-assign to designated user → notifications
22. **Task Delegation** — Employee delegates task to teammate with handoff notes, DelegateTaskModal UI
23. **Task Scheduling** — plannedStartTime/endTime, estimatedHours/actualHours fields on tasks and subtasks
24. **Microsoft Teams Calendar** — OAuth flow, Graph API calendar sync (create/update/delete events), TeamsIntegrationSettings in Profile
25. **Due Date Reminders** — Cron job: hourly overdue + due-soon checks, daily 3-day warning, auto-notify assignee + manager
26. **Enhanced My Work** — Stats cards, Overdue/Today/This Week/Upcoming/Completed grouping, delegate button per task, auto-assigned indicators

### Phase 5 — Teams Integration, Kanban & User Sync
27. **Integrations Page** — Premium integrations hub with Teams connect/disconnect, user sync, future integrations (Slack, Google, Jira)
28. **Kanban Board View** — monday.com-style drag-drop Kanban with collapsible columns, priority stripes, assignee filter, add-task per column
29. **M365 User Sync** — Pull all Microsoft 365 users into Aniston Hub via "Sync Users Now" button

### Phase 6 — Premium UI Overhaul + Advanced Features
30. **Real-Time Refresh** — Socket.io connected to all pages (Sidebar, BoardPage, HomePage, MyWork, Dashboard, Meetings). Live task/board updates across tabs.
31. **Time Planner Redesign** — Weekly Mon-Fri grid view, template system (save/apply weekly plans), fixed team view with mini bar charts
32. **Kanban Premium Polish** — Collapse/expand columns, priority color stripes, hover lift effects, drag animations, assignee filter chips, inline add-task
33. **Cross-Board Dependencies** — Link tasks across different boards, board picker in DependencySelector, board name/color shown on deps, remove deps inline
34. **Task Duplication** — POST /api/tasks/:id/duplicate, copies task + subtasks, Copy button in TaskModal
35. **Dashboard Upgrade** — Completion trend area chart (14 days), team workload stacked bar chart, overdue tasks widget with days-overdue count
36. **Toast Notifications** — Global toast system (success/error/warning/info), real-time socket events trigger toasts
37. **Skeleton Loaders** — Shimmer loading states for BoardPage and DashboardPage (replaces spinners)
38. **Keyboard Shortcuts** — ? key opens shortcuts modal, HelpCircle button wired, Ctrl+K search

### Phase 7 — monday.com Parity Features
39. **Automations Engine** — "When X happens, do Y" rules per board (status change → notify, assign, change priority, move group). AutomationsPanel UI with create/toggle/delete.
40. **Board Templates** — 5 pre-built templates (Software Sprint, Marketing Campaign, HR Onboarding, CRM Pipeline, Project Tracker) with groups + columns. Template selector in CreateBoardModal.
41. **Bulk Actions UI** — Floating toolbar when tasks selected (change status/priority/assignee, archive, delete). BulkActionBar component.
42. **Board Calendar View** — Month calendar tab on BoardPage showing tasks by due date with status colors.
43. **Archive Page** — View/restore/permanently delete archived boards. Sidebar link for managers.
44. **@Mentions in Comments** — Detects @name in comments, notifies mentioned users with 'mention' notification type.
45. **Dark Mode** — Full dark theme toggle (Moon/Sun in header), ThemeContext with localStorage, CSS class-based dark overrides.
46. **Board Export/Import** — CSV export (GET /boards/:id/export), JSON task import (POST /boards/:id/import).
47. **Forgot Password** — Token-based reset flow (POST /auth/forgot-password, POST /auth/reset-password), ForgotPassword + ResetPassword pages, "Forgot password?" link on Login.

### Phase 8 — Workspace, Permissions & Enterprise Features
48. **Workspace Model** — Group boards into workspaces with color, icon, members
49. **Permission System** — PermissionGrant model, AccessRequest flow, hasPermission middleware
50. **Enterprise Team Dashboard** — 13+ widgets: stat cards, workload heatmap, SLA monitor, team grid, announcements
51. **Org Chart** — Visual hierarchy tree, promotion history, manager assignment
52. **Task Watchers** — Watch/unwatch tasks, get notifications on changes
53. **Recurring Tasks** — Recurrence JSONB field, cron job creates recurring tasks hourly
54. **Approval Workflow** — approvalStatus, approvalChain JSONB, submit/approve/reject/changes_requested
55. **Undo/Redo System** — UndoContext with 50-action history, Ctrl+Z/Y keyboard shortcuts, toast with undo button

### Phase 9 — Monday.com Task Planner & Work Management UI
56. **Editable Column Headers** — Double-click any column header to rename, saves per board
57. **Custom Columns (Add/Remove)** — "+" button adds columns: Text, Number, Date, Status, Person, Priority, Label, Progress, Checkbox, Link, File, Time Tracking
58. **Task Completion Percentage** — ProgressCell with color-gradient progress bar (red→orange→yellow→green)
59. **Labels/Tags System** — LabelCell with multi-select, create custom labels with colors, search, per-board labels
60. **CSV Import with Merge** — Upload CSV, preview with column mapping, auto-detect fields, merge (never replace), database lock indicator
61. **CSV Export** — Export all tasks or filtered selection to CSV
62. **No-Delete Protection** — Tasks can only be archived, never deleted. Delete key shows "use archive instead" message
63. **Due Date Extension Approval** — Request extension with reason, manager approve/reject/suggest date, auto-update on approval
64. **Help Request System** — Request help from manager/admin, urgency levels, preferred time, integrates with Teams calendar
65. **Manager Hierarchy & Promotions** — Reports-to field, hierarchy levels (member→lead→manager→director→VP→CEO), promotion history
66. **Sort System** — Sort by any column (name, status, priority, date, progress, etc.), ascending/descending toggle
67. **Hide/Show Columns** — Toggle column visibility, persists in localStorage
68. **Smooth Animations** — CSS cubic-bezier transitions on all interactive elements, page transitions, dropdown animations, hover effects
69. **Enhanced Monday.com UI** — Clean sidebar with sections (Management, Admin), user footer, emerald accents, rounded corners, shadow hierarchy

### Phase 10 — AI, External APIs & Enterprise Extras
70. **AI Assistant** — AI chat endpoint (`/api/ai/chat`), grammar correction (`/api/ai/grammar`), admin-configurable provider (OpenAI/Ollama/DeepSeek), AIConfig model, AIAssistant component, GrammarSuggestion component, useGrammarCorrection hook
71. **Web Push Notifications** — VAPID-based web push via `web-push` package, PushSubscription storage, pushService, push route, client pushNotifications service
72. **External/HRMS API** — `/api/external/employees` endpoints with API key authentication (`apiKeyAuth.js`), ApiKey model with hashed keys, rate limited
73. **Notes System** — Note model, `/api/notes` CRUD, NotesPage for personal notes
74. **Feedback Widget** — Feedback model, `/api/feedback` endpoint, FeedbackWidget common component, FeedbackPage (admin-only) for review
75. **SOP Viewer** — SOPViewer component with sopContent utility
76. **Onboarding Tour** — OnboardingTour component for new user guidance
77. **Voice Notes** — VoiceNotes component for audio note capture
78. **Assistant Manager Role** — 4th role (`assistant_manager`) in User ENUM, taskPermissions middleware with 4-level hierarchy, AssistantManagerPlanPage
79. **Super Admin Flag** — `isSuperAdmin` boolean on User model for elevated access
80. **Priority Escalation** — Cron job auto-escalates tasks with ≥80% progress to critical priority daily
81. **Conflict Detection** — conflictDetectionService for schedule conflicts, ConflictWarning component in TaskModal
82. **Director Plan** — DirectorPlan model with 10 default task categories, daily planner with drag-drop, deadline urgency indicators, Excel export (exceljs/file-saver)
83. **Multi-Assignee Support** — TaskAssignee junction table with assignee/supervisor roles, TaskOwner model for primary ownership
84. **Task Reminders** — TaskReminder model with 2-day and 2-hour pre-deadline notifications, deadlineReminderJob processes every 15 minutes
85. **Teams Notification Log** — TeamsNotificationLog model for tracking Teams notification sends with retry support
86. **Integration Config** — IntegrationConfig model for managing provider settings (Teams, SSO), admin configuration UI
87. **Custom Hierarchy Levels** — HierarchyLevel model for defining custom org levels beyond built-in ENUM
88. **API Key Management** — ApiKey model with SHA-256 hashed keys, `/api/api-keys` CRUD, prefix-based identification

### Core Platform Features (Built from Start)
- JWT Authentication (login/register)
- Board CRUD with member management
- Task CRUD with status/priority/assignee/dates/tags
- Comments on tasks
- File attachments (upload/download, 25MB max)
- In-app notifications (real-time via Socket.io)
- Timeline/Gantt view
- Multiple views: Board, Table (My Work), Calendar (My Work), Timeline
- Microsoft Teams webhook integration
- n8n automation webhooks

## Database Models (36)

| Model | Table | Key Fields |
|-------|-------|------------|
| User | users | name, email, password, role (admin/manager/assistant_manager/member), department, designation, departmentId, avatar, isActive, managerId, hierarchyLevel, title, isSuperAdmin, accountStatus, hasLocalPassword, passwordResetToken, teamsUserId, teamsAccessToken, teamsNotificationsEnabled |
| Board | boards | name, description, color, columns (JSONB), groups (JSONB), customColumns (JSONB), isArchived, workspaceId, createdBy |
| Task | tasks | title, description, status, priority, groupId, dueDate, startDate, position, tags (JSONB), customFields (JSONB), progress, isArchived, archivedAt, archivedBy, labels (JSONB), boardId, assignedTo, createdBy, approvalStatus, approvalChain (JSONB), recurrence (JSONB), lastRecurrenceAt, escalationLevel, plannedStartTime, plannedEndTime, estimatedHours, actualHours, autoAssigned, teamsEventId |
| Subtask | subtasks | title, status, position, taskId, assignedTo, createdBy |
| Comment | comments | content, attachments (JSONB), taskId, userId |
| FileAttachment | file_attachments | filename, originalName, mimetype, size, url, taskId, uploadedBy |
| Notification | notifications | type, message, entityType, entityId, isRead, userId |
| Activity | activities | action, description, entityType, entityId, meta (JSONB), taskId, boardId, userId |
| WorkLog | worklogs | content, date, taskId, userId |
| TimeBlock | time_blocks | date, startTime, endTime, description, taskId, userId, boardId |
| Department | departments | name, description, color, head, isActive |
| Meeting | meetings | title, description, date, startTime, endTime, location, type, status, participants (JSONB), boardId, taskId, createdBy |
| Label | labels | name, color, boardId, createdBy |
| TaskLabel | task_labels | taskId, labelId (junction table) |
| TaskDependency | task_dependencies | taskId, dependsOnTaskId, dependencyType (blocks/required_for/related), autoAssignOnComplete, autoAssignToUserId, createdById, isArchived |
| TaskAssignee | task_assignees | taskId, userId, role (assignee/supervisor), assignedAt |
| TaskOwner | task_owners | taskId, userId, isPrimary |
| TaskWatcher | task_watchers | userId, taskId |
| TaskReminder | task_reminders | taskId, reminderType (2_day/2_hour), scheduledFor, sentAt, cancelled |
| DueDateExtension | due_date_extensions | taskId, requestedBy, currentDueDate, proposedDueDate, reason, status, reviewedBy, reviewNote |
| HelpRequest | help_requests | taskId, requestedBy, requestedTo, description, urgency, status, meetingLink, meetingScheduledAt |
| PromotionHistory | promotion_history | userId, previousRole, newRole, previousTitle, newTitle, promotedBy, notes, effectiveDate |
| Workspace | workspaces | name, description, color, icon, isDefault, isActive, createdBy |
| Automation | automations | name, boardId, trigger, triggerValue, action, actionConfig (JSONB), isActive, createdBy |
| DirectorPlan | director_plans | date, directorId, categories (JSONB), notes, createdBy. Unique on (date, directorId) |
| AIConfig | ai_configs | provider (default 'deepseek'), apiKey, model, baseUrl, isActive, lastTestedAt, configuredBy |
| AccessRequest | access_requests | userId, resourceType, resourceId, requestType (view/edit/assign/admin), reason, status (pending/approved/rejected/expired), reviewedBy, reviewNote, isTemporary |
| Announcement | announcements | title, content, type (info/warning/success/urgent), isPinned, isActive, workspaceId, createdBy |
| ApiKey | api_keys | name, keyHash (SHA-256), keyPrefix, expiresAt, lastUsedAt, isActive, createdBy |
| Feedback | feedback | category, rating (1-5), message, page, status, adminNotes, userId |
| HierarchyLevel | hierarchy_levels | name, label, order, color, icon, description, isActive |
| IntegrationConfig | integration_configs | provider (unique), clientId, clientSecret, tenantId, redirectUri, ssoRedirectUri, ssoEnabled, isActive, configuredBy |
| Note | notes | title, content, duration, type (default 'voice_note'), userId |
| TeamsNotificationLog | teams_notification_log | eventId, taskId, userId, notificationType, cardPayload (JSONB), status, sentAt, errorMessage, retryCount. Uses INTEGER autoincrement PK |

## Key Patterns

- **Activity logging:** Fire-and-forget via `activityService.js` — never blocks API responses. Call `logActivity({action, description, entityType, entityId, taskId, boardId, userId, meta})`
- **DB schema changes:** Use manual ALTER TABLE SQL to add columns/tables. Sequelize `sync({alter: true})` has bugs with REFERENCES. Wrap `sync()` in try-catch so server starts even on sync errors.
- **API response format:** `{ success: true, data: { ... } }` — client interceptor auto-unwraps
- **Socket.io:** JWT auth on handshake, rooms per board (`board:<id>`) and user (`user:<id>`). Events: task updates, typing indicators, notifications.
- **Constants:** Status values: `not_started`, `working_on_it`, `stuck`, `done`, `review`. Priority: `low`, `medium`, `high`, `critical`.
- **Sidebar theme:** Pure black zinc-based (bg: #18181b, hover: #27272a, active: #3f3f46), emerald logo gradient, left accent borders on active items.
- **Rate limiting:** Multiple limiters in server.js — authLimiter, uploadLimiter, searchLimiter, generalLimiter, externalLimiter. Applied per-route.
- **Security:** Helmet for headers, XSS sanitization on all user inputs, express-validator for request validation.
- **Cron jobs:** 4 job files in `server/jobs/` + 1 inline cron in server.js. All fire-and-forget, never block the request cycle.
- **Task permissions:** `taskPermissions.js` middleware attaches `req.taskPermissions` with role-based access context (fullAccess/boardAccess/partialAccess).
- **API key auth:** External endpoints use `apiKeyOrJwt` middleware — authenticates via `X-API-Key` header or JWT Bearer token.

## Environment Variables

See `server/.env.example`. Key vars: `PORT=5000`, `DB_*` (PostgreSQL), `JWT_SECRET`, `CLIENT_URL=http://localhost:3000`

## Common Tasks

- **Add a new API route:** Create controller in `server/controllers/`, route in `server/routes/`, mount in `server/server.js`
- **Add a new model:** Create in `server/models/`, add associations in `server/models/index.js`. Add table/columns via manual SQL. Do NOT use force sync.
- **Add activity logging:** Import `logActivity` from `server/services/activityService` and call fire-and-forget in controller
- **Add a new page:** Create in `client/src/pages/`, add route in `App.jsx`, optionally add sidebar link in `Sidebar.jsx`
- **Add DB columns:** Run `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` via node script or psql. Do NOT rely on Sequelize ALTER.

## Caveats

- **OneDrive Files On-Demand** causes issues — run server and client in separate terminals if `npm run dev` hangs
- **Sequelize ALTER bug:** `ALTER TABLE ... SET DEFAULT NULL REFERENCES` generates invalid SQL. Always add columns via manual SQL. Wrap `sequelize.sync()` in try-catch.
- **Vite CSS warning:** `@import must precede all other statements` for Google Fonts — cosmetic only, doesn't affect functionality
- **DB sync:** `server.js` wraps `sequelize.sync({ alter: false })` in try-catch so the server starts even if sync encounters schema drift errors.
