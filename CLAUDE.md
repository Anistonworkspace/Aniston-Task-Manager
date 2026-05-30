# Aniston Project Hub

Monday.com-style task management platform for Aniston Technologies LLP: RBAC, real-time updates via Socket.io, team dashboards, meetings, departments, time planning, recurring work, dependencies, approvals, Microsoft Teams + Deepgram integrations, web push notifications, AI assistant, external HRMS API.

---

## ⚠️ Production Safety Rules — Read Before Any Push

`.github/workflows/deploy.yml` **deploys to production on every push to `main`**. Read these rules before pushing. Also read `PRE_PUSH_SAFETY_REPORT.md` (root) — it's the canonical incident-driven safety log.

1. **NEVER `git push origin main` without the user's explicit approval.** A push triggers deploy. Local commits are fine; pushing is the deploy action.
2. **NEVER set `ALLOW_PROD_HIERARCHY_SEED=true` in production.** It re-derives `users.hierarchyLevel` from `role` on every restart. The guard at the top of `server/seed-hierarchy.js` defaults to skip in production.
3. **NEVER set `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY=true`.** This force-resets two specific user passwords on every deploy. The flag is hard-coded to `"false"` in `deploy/run-onetime-password-reset.sh`. Manual `workflow_dispatch` opt-in still works for one-off resets.
4. **NEVER set `ALLOW_PROD_PLAN_CLEANUP=true`** unless you have an explicit incident reason. `server/cleanup-plan-data.js` would wipe `director_plans` + `time_blocks` data otherwise.
5. **NEVER set `ALLOW_SEED_IN_PRODUCTION=true`** unless bootstrapping a fresh production DB. `server/seed-users.js` refuses in prod by default.
6. **NEVER mutate `users.tier` directly** via psql/docker exec. Tier is auto-derived from `(role, isSuperAdmin)` on every server boot (`server/server.js` ~line 1814). Hand-edits revert. Change `role` or `isSuperAdmin` via the UI instead.
7. **NEVER bypass the GitHub Environment `production` approval gate.** It must have **Required Reviewers** configured in repo Settings → Environments. Verify before pushing.
8. **NEVER directly run `node server/cleanup-plan-data.js`** (or `recover-director-plans.js`, or `__rbac_test_*.js`) against production without a pg_dump first.
9. **NEVER run `node server/config/sync.js --force`**. It DROPs every table.
10. **Two read-only audit workflows exist** for investigating prod issues without mutating data:
    - `.github/workflows/readonly-production-task-audit.yml`
    - `.github/workflows/readonly-production-task-visibility-audit.yml`
    Both use `SET TRANSACTION READ ONLY + ROLLBACK + forbidden-keyword guard`. Use them before any ad-hoc psql.
11. **Boot-time side effects you must accept on every restart** (these are intentional but worth knowing):
    - `users.tier` is recomputed from `(role, isSuperAdmin)` (now `WHERE` guarded — touches zero rows when in sync).
    - `BoardMembers.autoAdded` is re-marked to `false` for board creators and admins/managers/assistant_managers.
    - Stale `autoAdded` `BoardMembers` rows are deleted **once per deploy** (gated by `system_flags.boardmembers_cleanup_v1`). Membership only — never deletes tasks, comments, files, or work logs.
    - Every board's `columns` JSONB is appended-only with `labels` / `references` / `links` columns; `"Link"` / `"References"` titles normalized to `"Link/URL"` / `"Reference"`.
    - All schema changes (~15 tables/columns) re-applied via `CREATE TABLE / ALTER … ADD COLUMN IF NOT EXISTS`.
12. **Single-active-session is enforced** via `PendingLoginToken`. A login on a new browser revokes prior sessions for that user. This is intentional; do not work around it.

---

## Quick Start

```bash
# Prerequisites: Docker Desktop (for PostgreSQL), Node.js 20+
# PostgreSQL runs in Docker on localhost:5432
#   (db: aniston_project_hub, user: postgres, pass: postgres in dev)

npm run install:all                      # Install server + client deps
cd server && node seed-users.js          # Seed 4 test users (refuses in prod
                                         # unless ALLOW_SEED_IN_PRODUCTION=true)
npm run dev                              # Starts server (5000) + client (3000)

# Tests
cd server && npm test                    # Jest, ~750 unit tests, mocked DB
cd client && npm test                    # Vitest, ~130 tests, jsdom

# Build
npm run build                            # Vite client build
```

**Local test accounts:** `admin@aniston.com / Admin@1234`, `manager@aniston.com / Manager@1234`, `john@aniston.com / John@1234`, `sara@aniston.com / Sara@1234`.

---

## Tech Stack

**Frontend** (client/, port 3000)
- React 18.3, Vite 5.3, TailwindCSS 3.4, React Router DOM 6.23
- Axios (JWT interceptor + refresh-token rotation), Socket.io-client
- @hello-pangea/dnd, framer-motion, lucide-react, Recharts
- exceljs, file-saver (CSV/XLSX exports), date-fns
- i18n: custom `LanguageContext` (en / hi locales)
- Tests: Vitest 4 + @testing-library/react + jsdom

**Backend** (server/, port 5000)
- Express 4.19, Node 20+
- Sequelize 6.37, PostgreSQL 16 (Docker)
- JWT (bcryptjs + jsonwebtoken), httpOnly cookies + refresh-token rotation + reuse detection
- Socket.io 4.7 (board / user rooms), raw `ws` (Deepgram meeting audio)
- helmet, morgan, express-rate-limit, express-validator, xss, web-push (VAPID)
- winston (file logger), node-cron, pg / pg-hstore, multer, pdfkit
- AES-256-GCM encryption util (used for AI provider API keys, planned for Teams tokens)
- Tests: Jest 30 + supertest

**Database**
- PostgreSQL 16 (Dockerized for prod and dev)
- UUID PKs (except `TeamsNotificationLog` — INTEGER autoincrement, intentional)
- JSONB columns heavy use (columns, customFields, recurrence, etc.)
- 16 SQL migration files in `server/migrations/` + ~15 self-installing `IF NOT EXISTS` blocks in `server/server.js start()`

**Deploy**
- Single EC2 instance, Docker Compose (postgres + backend + frontend nginx)
- GitHub Actions `deploy.yml` triggers on push to `main` (gated by `production` environment + Required Reviewers)
- Daily `pg_dump` backup cron + pre-deploy snapshot retained for 30 deploys

---

## Architecture

```
client/src/
├── components/
│   ├── auth/             # Login, Register, ForgotPassword, ResetPassword
│   ├── board/            # BoardCard, TaskGroup, TaskRow, StatusCell, PersonCell, DateCell,
│   │                     #   PriorityCell, BoardSettingsModal, CreateBoardModal,
│   │                     #   AdvancedFilters, AddColumnModal, AutomationsPanel, BulkActionBar,
│   │                     #   CSVImportModal, CalendarView, KanbanView, CheckboxCell,
│   │                     #   ColumnHeaderMenu, ColumnInfoTooltip, DueDateExtensionModal,
│   │                     #   HelpRequestModal, LabelCell, LinksCell (multi-value), LinkCell (legacy),
│   │                     #   NumberCell, ProgressCell, ReferenceCell, SortDropdown,
│   │                     #   RearrangeBoardsModal, RearrangeWorkspacesModal,
│   │                     #   SubtaskCountBadge, TextCell, TimelineView, ApprovalStepIndicator
│   ├── task/             # TaskModal, TaskComments, TaskFiles, SubtaskList, ActivityFeed,
│   │                     #   WorkLogSection, ApprovalSection, ConflictWarning, DelegateTaskModal,
│   │                     #   DueDateExtensionModal, HelpRequestModal, RecurrenceSection,
│   │                     #   WatcherSection, RecurringInstanceDetails
│   ├── layout/           # Layout, Sidebar, Header
│   ├── common/           # Modal, Button, Avatar, LoadingSpinner, DropdownMenu, AccessDenied,
│   │                     #   NotificationsPanel, GlobalSearch, AIAssistant, ErrorBoundary,
│   │                     #   FeedbackWidget, GrammarSuggestion, KeyboardShortcuts, OnboardingTour,
│   │                     #   PageTransition, PortalDropdown, Skeleton, ToolsFAB, UpdatePrompt,
│   │                     #   VoiceNotes, DepartmentSelect, DetailModalShell, TaskReceiptIcon
│   ├── dashboard/        # MemberDrillDown, RoleDashboard, stat widgets
│   ├── department/       # DepartmentModal
│   ├── dependencies/     # DependencyBadge, DependencySelector, DependencyWorkSection,
│   │                     #   RejectDependencyDialog
│   ├── home/             # Home-page widgets
│   ├── integrations/     # TranscriptionProviderSection
│   ├── meeting/          # MeetingModal
│   ├── profile/          # ProfileModalRoute (overlay route)
│   ├── recurring/        # Recurring task UI pieces
│   ├── settings/         # TeamsIntegrationSettings
│   ├── timeplan/         # DayTimeline, TimeBlockForm
│   ├── user/             # CreateUserModal, EditUserModal, ResetPasswordModal
│   └── workspace/        # TeamPlannerModal, WorkspaceAssignModal, WorkspaceSetupModal
├── context/
│   ├── AuthContext.jsx       # user, token, tier helpers, granularPermissions, session-timeout
│   ├── ThemeContext.jsx      # dark / light theme
│   ├── FontSizeContext.jsx   # user-configurable font size
│   ├── LanguageContext.jsx   # i18n (en / hi)
│   └── UndoContext.jsx       # Ctrl+Z/Y action history
├── hooks/                # useSocket, useGrammarCorrection, useNavBadgeCounts,
│                         #   useMeetingTranscription, useSpeechToText
├── i18n/                 # index.js + locales/{en.js, hi.js}
├── pages/                # 29 page components (see Pages & Routes table)
├── realtime/             # RealtimeProvider, useRealtimeEvent, useRealtimeQuery, eventRouter
├── services/             # api.js (Axios + JWT interceptor), socket.js,
│                         #   pushNotifications.js, recurringTasks.js
├── utils/                # constants, dateFormat, animations, permissions,
│                         #   taskNavigation, taskPrioritization, uploadConfig,
│                         #   workspaceTemplates, i18nLabels
└── App.jsx               # Routes with ProtectedRoute / ManagerRoute / AdminRoute /
                          #   StrictAdminRoute / PermissionRoute wrappers
                          #   + modal-route pattern (state.background)

server/
├── config/
│   ├── db.js             # Sequelize connection (pooled, min 2 / max 10)
│   ├── sync.js           # CLI: sync({alter:true}) or sync({force:true}) with --force.
│   │                     #   Never called from server.js. NEVER run --force in prod.
│   ├── tiers.js          # Canonical tier 1-4 helpers (tierFromLegacy, hasTierAtLeast, TIER.*)
│   └── fileTypes.js      # Upload extension allowlists per category
├── controllers/          # 48 controllers (one per resource — see API Routes below)
├── middleware/
│   ├── auth.js                       # authenticate, requireRole, managerOrAdmin, adminOnly,
│   │                                 #   strictAdminOnly, optional origin-validation
│   ├── tier.js                       # requireTier(n) — canonical privilege gate
│   ├── permissions.js                # requirePermission(resource, action) + legacy hasPermission
│   ├── taskPermissions.js            # attachTaskPermissions — per-task role context
│   ├── apiKeyAuth.js                 # apiKeyOrJwt — API key OR JWT auth
│   ├── upload.js                     # Multer + magic-byte validation
│   ├── staticAuth.js                 # /uploads/* auth gate + Content-Disposition: attachment
│   ├── webhookSignature.js           # Incoming-webhook HMAC verification (strict in prod)
│   └── dependencyRequestPermissions.js  # drPerm.* loaders + per-row guards
├── models/               # 51 model files + index.js + userTierSync.js helper (see Database Models)
├── routes/               # 47 route files (one per resource — see API Routes below)
├── services/             # 33 service files. Notable:
│   ├── socketService.js              # Socket.io init, emitToBoard, emitToUser
│   ├── activityService.js            # Fire-and-forget logActivity()
│   ├── notificationService.js        # Centralized notification fan-out + idempotencyKey
│   ├── permissionEngine.js           # Canonical RBAC resolver (DENY > GRANT > base)
│   ├── tierEnforcement.js            # Destructive-action gates (assertCanDelete)
│   ├── boardVisibilityService.js     # SQL-level board filter per tier
│   ├── taskVisibilityService.js      # SQL-level task filter per tier
│   ├── boardMembershipService.js     # Auto board-membership rules
│   ├── dependencyService.js          # Dependency resolution, auto-unblock chain
│   ├── recurringTaskService.js       # RecurringTaskTemplate → Task generation
│   ├── approvalChainService.js       # Approval chain builder
│   ├── approvalCapabilityService.js  # Per-step approver capability resolver
│   ├── approvalLifecycleService.js   # Approval state transitions
│   ├── approvalNotificationService.js
│   ├── assignmentNotificationService.js
│   ├── conflictDetectionService.js
│   ├── reminderService.js
│   ├── deadlineNotificationService.js (legacy)
│   ├── teamsWebhook.js, teamsGraphClient.js, teamsNotificationService.js, teamsUserSync.js
│   ├── meetingStreamService.js       # Deepgram WebSocket proxy
│   ├── transcriptionService.js
│   ├── aiService.js, aiContextService.js
│   ├── pushService.js                # VAPID web push
│   ├── webhookService.js             # Outbound webhook delivery
│   ├── calendarService.js            # Teams calendar event sync
│   ├── realtimeService.js            # Realtime helper (Socket.io abstraction)
│   ├── taskReceiptService.js         # WhatsApp-style delivered/seen receipts
│   ├── hierarchyService.js           # Org hierarchy
│   ├── storageService.js             # File-storage abstraction (local / S3)
│   └── storage/                      # storage provider impls
├── jobs/                 # 9 cron jobs + cronLock.js (Postgres advisory locks)
│   ├── cronLock.js                       # withCronLock(name, fn) helper
│   ├── reminderJob.js                    # Hourly overdue/due-soon, daily 9 AM 3-day warn
│   ├── recurringTaskJob.js               # Hourly: legacy Task.recurrence JSONB (off by default)
│   ├── deadlineReminderJob.js            # Every 15 min: TaskReminder pre-deadline
│   ├── priorityEscalationJob.js          # Daily midnight: progress ≥80% → critical
│   ├── calendarSyncRetryJob.js           # Every 15 min: retry failed Teams calendar sync
│   ├── missedRecurringTaskJob.js         # Every 10 min: backfill missed recurring runs
│   ├── recurringTemplateGenerationJob.js # Every 10 min: generate today's recurring instances
│   ├── webhookRetryJob.js                # Every 5 min: drain failed outbound webhook deliveries
│   └── vacuumAnalyzeJob.js               # Weekly Sunday 03:00: VACUUM ANALYZE hot tables
├── migrations/           # 16 SQL files (001-016) + run_NNN.js for some. All also covered by
│                         #   the auto-installing blocks in server.js start().
├── utils/                # logger (winston), encryption (AES-GCM), sanitize (xss),
│                         #   sanitizeNotification, authCookies, taskNotificationRecipients,
│                         #   taskOverdueEligibility, taskOwnership, taskPrioritization,
│                         #   tierResponseHelpers
├── __tests__/            # 53 test files (controllers, services, jobs, middleware, models,
│                         #   utils, config, security). All mock-DB; no real Postgres.
├── scripts/              # One-shot ops scripts (dev-only or gated by env in prod)
├── uploads/              # File storage (Docker named volume in prod)
├── server.js             # Entry point (~2050 lines — mounts routes, runs auto-migrations,
│                         #   wires sockets, starts cron jobs, SIGTERM graceful shutdown)
├── seed-users.js         # Seeds 4 test users. Prod-safe via ALLOW_SEED_IN_PRODUCTION guard.
├── seed-hierarchy.js     # Seeds hierarchy_levels + back-derives users.hierarchyLevel.
│                         #   Prod-safe via ALLOW_PROD_HIERARCHY_SEED guard (default: skip).
└── cleanup-plan-data.js  # One-shot DELETE of director_plans + time_blocks.
                          #   Removed from boot path. Manual run only, gated by
                          #   ALLOW_PROD_PLAN_CLEANUP in prod.
```

---

## Pages & Routes

29 page components in `client/src/pages/`. Routes defined in `App.jsx`.

| Route | Page | Access | Description |
|-------|------|--------|-------------|
| `/login` | Login | Public | Login page (redirects if logged in) |
| `/forgot-password` | ForgotPassword | Public | Token-based password reset request |
| `/reset-password` | ResetPassword | Public | Password reset with token |
| `/` | HomePage | All | Greeting, quick actions, My Tasks table, recent boards, notification feed |
| `/my-work` | MyWorkPage | All | Personal task view (Table + Calendar tabs), grouped by due date |
| `/boards` | BoardsPage | All | Board library — grid/list, search, create |
| `/boards/:id` | BoardPage | All | Board with task groups, drag-drop, filters, search, settings (ErrorBoundary-wrapped) |
| `/boards/:id/dashboard` | DashboardPage | Admin (T1-T2) + `dashboard.view` grant | Board-specific analytics |
| `/dashboard` | DashboardPage | Manager+ (T1-T2) + `dashboard.view` grant | Global analytics, stat cards, charts |
| `/member-dashboard` | MemberDashboardPage | All | Member-specific dashboard view |
| `/manager-dashboard` | ManagerDashboardPage | Admin (T1-T2) + `dashboard.view` grant | Manager dashboard with team insights |
| `/admin-dashboard` | AdminDashboardPage | Admin (T1-T2) + `dashboard.view` grant | Admin-level system dashboard |
| `/director-dashboard` | (Retired — redirects to `/`) | — | Module removed |
| `/director-plan` | (Retired — redirects to `/`) | — | Module removed; `/api/director-plan` returns HTTP 410 |
| `/timeline` | TimelinePage | All | Gantt chart view with zoom controls |
| `/time-plan` | TimePlanPage | All | Daily time planner (personal + team view for managers) |
| `/reviews` | ReviewPage | All | Weekly review with PDF/CSV export |
| `/profile` | ProfilePage *(modal-route)* | All | Avatar upload, edit profile, change password. Renders as overlay when navigated with `state.background`, else as full page. |
| `/meetings` | MeetingsPage | All | Meeting scheduling, accept/decline, stats, date-grouped list |
| `/integrations` | IntegrationsPage | **Strict Admin (T1)** + `integrations.view` grant | Teams / Slack / Google / Jira / AI / Transcription |
| `/archive` | ArchivedPage | Admin (T1-T2) + `archive.view` grant | View/restore/permanently delete archived boards |
| `/users` | UserManagementPage | Admin (T1-T2) + `users.view` grant | Users + Departments tabs |
| `/admin-settings` | AdminSettingsPage | **Strict Admin (T1)** + `admin_settings.view` grant (ErrorBoundary-wrapped) | System-wide config |
| `/access-requests` | AccessRequestPage | Admin (T1-T2) + `roles.view` grant | Review/approve/reject access requests |
| `/org-chart` | OrgChartPage | All (with DENY override capability) | Visual org tree + promotion history + multi-manager relations |
| `/cross-team` | DependenciesPage | All | Dependency requests across teams (replaces retired CrossTeamTasksPage) |
| `/tasks` | TasksPage | All | Global tasks view |
| `/notes` | NotesPage | All | Personal voice notes + transcripts |
| `/recurring-work` | RecurringWorkPage | All (server-filtered by tier) | Recurring task templates |
| `/feedback` | FeedbackPage | **Strict Admin (T1)** + `feedback.view` grant | Feedback review (manage actions hidden unless `feedback.manage` holds) |

Route guard wrappers in `App.jsx`:
- `ProtectedRoute` — any authenticated user
- `ManagerRoute` — T1+T2 OR `granularPermissions[requiredPermission]`
- `AdminRoute` — T1+T2 OR `granularPermissions[requiredPermission]`
- `StrictAdminRoute` — T1 only OR `granularPermissions[requiredPermission]`
- `PermissionRoute` — base-allowed unless `isExplicitlyDenied()` for resource.action
- All wrap a `Layout` that contains an `ErrorBoundary` to catch sub-tree render crashes.

---

## API Routes

All routes prefixed `/api/`. 47 route files in `server/routes/` + a handful mounted inline in `server.js`.

| Endpoint | Description |
|----------|-------------|
| `/auth` | Login, force-login, register (disabled), refresh, logout, forgot/reset/create/change password, profile (GET/PUT), avatar, list users, list assignable users, Microsoft SSO (auth, callback, status, pending), approve/reject pending accounts |
| `/boards` | CRUD, members (add/remove), group reorder, export CSV, import JSON, templates |
| `/tasks` | CRUD with RBAC, reorder, bulk update, duplicate, archive, conflicts check, auto-reschedule, schedule-summary, members management, task receipts |
| `/subtasks` | CRUD within tasks |
| `/worklogs` | Daily work updates per task |
| `/comments` | Task comments with @mentions |
| `/files` | File uploads (Multer, 25 MB), download (authenticated), general/plan upload helpers |
| `/notifications` | List (paginated), mark read, unread count, clear read |
| `/activities` | Activity audit log with filters |
| `/dashboard` | Stats, role, enterprise, member/:id tasks. `/director` returns 410. |
| `/users` | Admin user management (create/update/reset-password/toggle-status/delete) |
| `/timeplans` | Time blocks CRUD, my blocks, team view, employee view, calendar-events |
| `/reviews` | Weekly review data, PDF, CSV downloads |
| `/search` | Global search across tasks and boards (RBAC-aware, rate limited) |
| `/departments` | CRUD departments, sync-from-users, assign |
| `/meetings` | CRUD meetings, my/team, respond (accept/decline) |
| `/webhooks` | Microsoft Teams / n8n integration webhooks (HMAC verified) |
| `/teams` | Microsoft Teams OAuth + Graph API sync (auth, callback, status, disconnect, sync-task, sync-users, preview-users, notification-stats) |
| `/automations` | CRUD automation rules per board (trigger → action) |
| `/workspaces` | Workspace CRUD, member management, board-order, workspace-order |
| `/permissions` | PermissionGrant CRUD (single, multi, bulk, apply-template, effective/:userId) |
| `/access-requests` | Access request flow (request/approve/reject) + pending count |
| `/task-extras` | Task watchers, approval workflow (submit/approve/reject/changes_requested), recurrence |
| `/task-references` | Task multi-value Reference column rows |
| `/task-links` | Task multi-value Link/URL column rows |
| `/announcements` | Team/board announcements CRUD |
| `/labels` | Label CRUD per board, assign/unassign |
| `/extensions` | Due-date extension request, approve/reject |
| `/help-requests` | Help request create, list, status, archive |
| `/promotions` | Promotion history + manager-relations (legacy alias) |
| `/hierarchy-levels` | Custom org hierarchy level management |
| `/manager-relations` | Multi-manager support (primary / functional / project / dotted_line). **Also aliased inline as `/api/multi-manager/*`** in `server.js` for the legacy frontend caller. |
| `/director-plan` | **Returns HTTP 410** (retired) |
| `/archive` | View/restore archived boards, dependencies, help requests |
| `/push` | Web push subscriptions (VAPID). GET `/vapid-key` is public. |
| `/integrations` | IntegrationConfig CRUD (Teams, SSO providers) |
| `/notes` | Personal notes CRUD + `/process` (transcription pipeline) + segment rename-speaker |
| `/feedback` | In-app feedback submissions and admin review |
| `/ai` | AI chat, grammar correction. Provider config CRUD (admin only). |
| `/transcription` | Transcription providers (Deepgram, etc.) — admin config |
| `/api-keys` | API key CRUD (strict-admin only) |
| `/outbound-webhooks` | Outbound webhook subscriptions + HMAC-signed deliveries + retry queue |
| `/recurring-tasks` | RecurringTaskTemplate CRUD, pause/resume/archive, generate-now (super-admin only) |
| `/board-orders` | Per-user board ordering preference (sidebar Rearrange) |
| `/system-settings` | System-wide settings (session-timeout, etc.) — super-admin only |
| `/external` | HRMS/external employee API (API-key authenticated, rate limited) |
| Dependencies | Task dependency get/create/remove, delegate task — mounted at `/api/*` (see `server/routes/dependencies.js`) |
| `/csp-report` | (Public POST) CSP violation report receiver |
| `/upload-config` | (Public GET) returns allowed file extensions/sizes |
| `/health` | Liveness — does not touch DB |
| `/health/deep` | Readiness — `SELECT 1` against DB; 503 on failure |
| `/meeting-stream/ws` | WebSocket (raw `ws`) — proxies browser PCM audio to Deepgram |

---

## Role-Based Access Control (RBAC)

### Tier 1-4 (canonical privilege axis)

Since Phase 2/3 of the RBAC migration, **`users.tier` (1-4) is the canonical privilege column.** It is **re-derived from `(isSuperAdmin, role)` on every server boot** (`server/server.js` ~line 1814):

```
tier 1: isSuperAdmin = true
tier 2: role IN ('admin','manager')
tier 3: role = 'assistant_manager'
tier 4: everyone else (members)
```

**Hand-tuned tier values are silently overwritten on every restart.** Mutate `role` or `isSuperAdmin` via the UI instead. The `WHERE tier IS NULL OR tier <> CASE …` guard ensures the UPDATE touches zero rows when already in sync.

Server-side: `requireTier(n)` middleware in `server/middleware/tier.js`. Service-side: `hasTierAtLeast(user, TIER.TIER_2)` from `server/config/tiers.js`.

Client-side `AuthContext.jsx` exposes:
- `isTier1, isTier2, isTier3, isTier4`
- `isSuperAdmin` (= `!!user?.isSuperAdmin`)
- `isAdmin` (= T1 ∪ T2)
- `isStrictAdmin` (= T1 only — used for /admin-settings, /integrations, /feedback)
- `isManager` (= T2)
- `isAssistantManager` (= T3)
- `isMember` (= T4)
- `canManage` (= T1 ∪ T2)
- `granularPermissions`, `effectivePermissions`, `permissionOverrides` — per-resource grants/denies

### PermissionGrant overrides

The `permission_grants` table holds explicit `(userId, resourceType, resourceId?, action, effect)` rows. The kernel rule:

```
DENY  beats  GRANT  beats  tier-base permission
```

Expired grants are not honored. Super-admins bypass everything. The canonical resolver is `server/services/permissionEngine.js`.

### Role tables (legacy view)

#### Admin (Tier 1-2, e.g. `admin@aniston.com`)
| Area | Capabilities |
|------|-------------|
| Users | Create/edit/deactivate any user, reset passwords, change roles, set isSuperAdmin |
| Departments | CRUD, assign heads |
| Boards | CRUD, manage members, configure columns/groups |
| Tasks | Create/assign to anyone, set priority/dates, archive, bulk |
| Dashboard | All boards' stats, team overview, member drill-down, admin dashboard |
| Meetings | Schedule with any user, edit/cancel any meeting |
| Reviews | All employees, download PDF/CSV |
| Time Plan | View any user's time plan |
| Admin Settings | **Strict Admin (T1 only)** — system-wide config, AI keys, API keys, feedback review |
| Approvals | Due-date extensions, help requests, access requests |

#### Manager (Tier 2)
| Area | Capabilities |
|------|-------------|
| Users | Create member accounts, view all users |
| Departments | Create/edit |
| Boards | Create/edit, manage members |
| Tasks | Create/assign, set priority/dates, archive |
| Dashboard | Their boards' stats, team overview, manager dashboard |
| Meetings | Schedule, edit/cancel own |
| Reviews | Team |
| Time Plan | Team |
| Approvals | Due-date extensions, help requests |

#### Assistant Manager (Tier 3)
| Area | Capabilities |
|------|-------------|
| Tasks | Board-level access, manage within assigned boards |
| Dashboard | Director dashboard |
| Time Plan | Team |
| Boards | Partial access via PermissionGrant |

#### Member / Employee (Tier 4)
| Area | Capabilities |
|------|-------------|
| Tasks | Own assigned, self-assign, status updates |
| Subtasks | On their tasks |
| Work Logs | Daily updates |
| Comments | On their tasks, files |
| My Work | Assigned across all boards |
| Home | "My Tasks" dashboard |
| Meetings | Invited only, accept/decline |
| Time Plan | Own daily schedule |
| Reviews | Own weekly, download |
| Profile | Edit self, change password, avatar |
| Notes | Personal voice notes |
| Feedback | Submit via widget |

---

## How to Assign Work to an Employee

**Method 1 — Inline on Board:** Login as admin/manager → open board → click `+ New task` or existing row → click Owner column → pick from dropdown.

**Method 2 — TaskModal:** Click task → Owner field → select user → set status/priority/dates → add description/subtasks → save. Recipient is notified.

**Method 3 — Quick Add:** In any group, click `+ Add task` → type name → press Enter → click Owner.

---

## Database Models (51)

| Model | Table | Key Fields |
|-------|-------|------------|
| User | users | name, email, password, role (admin/manager/assistant_manager/member), **tier (1-4, canonical, auto-derived)**, department, designation, departmentId, avatar, isActive, managerId, hierarchyLevel, title, **isSuperAdmin**, accountStatus, hasLocalPassword, passwordResetToken, **language (en/hi)**, teamsUserId, teamsAccessToken/teamsRefreshToken/teamsTokenExpiry (planned: encrypted), teamsNotificationsEnabled, **fontSize** |
| Board | boards | name, description, color, columns (JSONB), groups (JSONB), archivedGroups (JSONB), customColumns (JSONB), isArchived, workspaceId, createdBy |
| BoardMember | BoardMembers (PascalCase) | boardId+userId composite PK, autoAdded |
| Task | tasks | title, description, status (VARCHAR(50), de-enumed), priority (ENUM), statusConfig (JSONB), groupId, dueDate, startDate, position, tags (JSONB), customFields (JSONB), progress, completedAt, isArchived, archivedAt, archivedBy, labels (JSONB), boardId, assignedTo, createdBy, approvalStatus, approvalChain (JSONB — legacy), recurrence (JSONB — legacy), recurringTemplateId, occurrenceDate, escalationLevel, plannedStartTime/EndTime, estimatedHours, actualHours, autoAssigned, teamsEventId, syncStatus |
| Subtask | subtasks | title, status, priority, progress, position, taskId, assignedTo, createdBy, plannedStartTime/EndTime, estimatedMinutes, actualMinutes |
| Comment | comments | content, attachments (JSONB), taskId, userId |
| FileAttachment | file_attachments | filename, originalName, mimetype, size, url, taskId, uploadedBy |
| Notification | notifications | type (ENUM, ~30 values), message, entityType, entityId, isRead, userId, **idempotencyKey (partial unique)** |
| Activity | activities | action, description, entityType, entityId, meta (JSONB), taskId, boardId, userId |
| WorkLog | worklogs | content, date, taskId, userId |
| TimeBlock | time_blocks | date, startTime, endTime, description, taskId, userId, boardId |
| Department | departments | name (unique), description, color, head, isActive |
| Meeting | meetings | title, description, date, startTime, endTime, location, type, status, participants (JSONB), boardId, taskId, createdBy |
| Label | labels | name, color, boardId, createdBy |
| TaskLabel | task_labels | **composite PK (taskId, labelId)** |
| TaskDependency | task_dependencies | taskId, dependsOnTaskId, dependencyType, autoAssignOnComplete, autoAssignToUserId, createdById, isArchived |
| DependencyRequest | dependency_requests | parentTaskId, assignedToUserId, requestedByUserId, boardId, status, priority, dueDate, linkedTaskId, workspaceId |
| TaskAssignee | task_assignees | taskId, userId, role (assignee/supervisor — DB enum), assignedAt, assignerId, deliveredAt/seenAt (WhatsApp receipts) |
| TaskOwner | task_owners | taskId+userId unique, isPrimary |
| TaskWatcher | task_watchers | userId, taskId (unique) |
| TaskReminder | task_reminders | taskId, reminderType, scheduledFor, sentAt, cancelled, offsetMinutes, customReminderAt |
| TaskApprovalFlow | task_approval_flows | taskId, userId (SET NULL preserves audit), userName, role, level, **stage (parallel-approver group)**, status, comment, attachmentUrl, actionAt |
| TaskLink | task_links | taskId, url (STRING(2048)), label, position, createdBy |
| TaskReference | task_references | taskId, text (STRING(500)), label, position, createdBy |
| DueDateExtension | due_date_extensions | taskId, requestedBy, currentDueDate, proposedDueDate, reason, status, reviewedBy, reviewNote |
| HelpRequest | help_requests | taskId, requestedBy, requestedTo, description, urgency, status, meetingLink, meetingScheduledAt, isArchived |
| PromotionHistory | promotion_history | userId, previousRole, newRole, previousTitle, newTitle, promotedBy, notes, effectiveDate |
| ManagerRelation | manager_relations | employeeId, managerId (composite unique), type (primary/functional/project/dotted_line) |
| Workspace | workspaces | name, description, color, icon, isDefault, isActive, createdBy |
| UserBoardOrder | user_board_orders | userId+workspaceId+boardId unique, position |
| UserWorkspaceOrder | user_workspace_orders | userId+workspaceId unique, position |
| Automation | automations | name, boardId, trigger, triggerValue, action, actionConfig (JSONB), isActive, createdBy |
| Announcement | announcements | title, content, type, isPinned, isActive, workspaceId, createdBy |
| AccessRequest | access_requests | userId, resourceType, resourceId, requestType, reason, status, reviewedBy, reviewNote, isTemporary |
| PermissionGrant | permission_grants | userId, resourceType, resourceId, action, effect (grant/deny), permissionLevel (legacy), grantedBy, revokedBy, expiresAt |
| HierarchyLevel | hierarchy_levels | name (unique), label, order, color, icon, description, isActive |
| RecurringTaskTemplate | recurring_task_templates | title, description, frequency, weekdays/daysOfMonth (JSONB), nextRunAt, assigneeId, boardId, escalationTargets, isActive, archivedAt |
| Webhook | webhooks | name, url, events (JSONB), secret (HMAC), apiKeyId, isActive, createdBy |
| WebhookDelivery | webhook_deliveries | webhookId, payload (JSONB), status (pending/success/failed/dead), retryCount, nextRetryAt |
| ApiKey | api_keys | name, keyHash (SHA-256), keyPrefix, expiresAt, lastUsedAt, isActive, createdBy |
| IntegrationConfig | integration_configs | provider (unique), clientId, clientSecret (encrypted), tenantId, redirectUri, ssoRedirectUri, ssoEnabled, isActive, configuredBy |
| AIConfig | ai_configs | provider (default 'deepseek'), apiKey (encrypted), model, baseUrl, isActive, lastTestedAt, configuredBy |
| AIProvider | ai_providers | per-provider config; replaces single-row AIConfig (migrateFromLegacy runs on boot) |
| TranscriptionProvider | transcription_providers | provider, apiKey (encrypted), config, isActive, isDefault, configuredBy |
| TranscriptSegment | transcript_segments | noteId, startMs, endMs, speaker, text |
| Note | notes | title, content, duration, type (default 'voice_note'), lang, userId |
| Feedback | feedback | category, rating (1-5), message, page, status, adminNotes, userId |
| PushSubscription | push_subscriptions | userId, endpoint (md5-uniq), p256dh, auth, userAgent, deviceId, isActive, lastSeenAt |
| RefreshToken | refresh_tokens | userId (jti = PK), issuedAt, expiresAt, revokedAt, revokedReason, replacedByJti |
| PendingLoginToken | pending_login_tokens | userId, token_hash (SHA-256), expires_at, used_at, origin (local/sso), ip, user_agent |
| SystemSetting | system_settings | key (unique), value (JSONB), updatedBy |
| TeamsNotificationLog | teams_notification_log | **INTEGER autoincrement PK** (only model not UUID), eventId (unique), taskId, userId, notificationType, cardPayload (JSONB), status, sentAt, errorMessage, retryCount |

Three coexisting sources of truth for task assignment exist: `tasks.assignedTo` (legacy single FK), `task_assignees` (junction with role), `task_owners` (primary ownership). Reads union them at notification time via `server/utils/taskNotificationRecipients.js`. **Long-term refactor: pick one canonical model and migrate writers.** See audit P0 finding.

---

## Background Jobs

All cron jobs are fire-and-forget at boot, coordinated by Postgres advisory locks (`server/jobs/cronLock.js` → `withCronLock(name, fn)`) so multi-replica deploys never double-fire.

| Job | Schedule | Purpose |
|-----|----------|---------|
| reminderJob | hourly + daily 9 AM | Overdue / due-soon / 3-day warn notifications |
| recurringTaskJob | hourly @ :15 | **Legacy** Task.recurrence JSONB (off unless `LEGACY_RECURRING_ENABLED=true`) |
| deadlineReminderJob | every 15 min | Process pending `task_reminders` rows |
| priorityEscalationJob | daily midnight | Tasks ≥80% progress → critical |
| calendarSyncRetryJob | every 15 min (offset :07) | Retry failed M365 calendar sync |
| missedRecurringTaskJob | every 10 min | Backfill missed recurring instances |
| recurringTemplateGenerationJob | every 10 min | Generate today's recurring instances |
| webhookRetryJob | every 5 min | Drain failed outbound webhook deliveries (exp backoff → dead) |
| vacuumAnalyzeJob | weekly Sunday 03:00 | `VACUUM ANALYZE` hot tables |

---

## Key Patterns

- **Activity logging:** Fire-and-forget via `activityService.logActivity({...})`. Never `await`; never block the response.
- **Notification dispatch:** Centralized via `notificationService.createNotification({..., idempotencyKey})`. The DB enforces dedup via `idx_notifications_idempotency` partial unique index.
- **DB schema changes:** Manual `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` SQL. Sequelize `sync({alter:true})` has known bugs with FK REFERENCES — never used. `sync({alter:false})` runs at boot wrapped in try/catch so a sync failure can't kill the container.
- **Migration files:** `server/migrations/001-016` (numbered SQL + optional run_NNN.js). Every change ALSO ships via a self-installing `IF NOT EXISTS` block in `server.js start()` so the deploy never depends on running a script. The SQL files are the audit-trail companion.
- **API response format:** `{ success: true, data: { ... } }` or `{ success: false, message: "...", errors?: [...], code?: 'rate_limited' | ... }`. The Axios interceptor auto-unwraps in the client.
- **Socket.io:** JWT auth on handshake. Rooms: `board:<id>`, `user:<id>`. Realtime layer in `client/src/realtime/` wraps subscriptions for React.
- **Constants:** Task status — `not_started`, `working_on_it`, `stuck`, `done`, `review` (plus board-defined custom statuses since the de-enum migration). Priority — `low`, `medium`, `high`, `critical`.
- **Rate limiting:** `authLimiter` (50/15m), `uploadLimiter` (50/15m), `searchLimiter` (60/min), `boardReadLimiter` (90/min), `externalLimiter` (100/min), `generalLimiter` (300/min), plus per-user `aiUserLimiter` for AI chat.
- **Security headers:** `helmet` + CSP (report-only by default; flip `CSP_ENFORCE=true` for enforcement). Origin/Referer validation on every mutating request.
- **Task permissions:** `taskPermissions.attachTaskPermissions` attaches `req.taskPermissions` with role-based access context (fullAccess / boardAccess / partialAccess). Per-action gating via `permissionEngine.hasPermission(user, resource, action, ctx)`.
- **API key auth:** External endpoints use `apiKeyOrJwt` middleware (X-API-Key header or JWT Bearer).
- **Cron multi-replica safety:** Every cron job is wrapped in `withCronLock(name, fn)` (Postgres advisory locks). Adding a new job? Use the same wrapper.
- **Graceful shutdown:** `SIGTERM` / `SIGINT` close the HTTP server, then `sequelize.close()`, then exit. 15 s hard-exit fallback.

---

## Environment Variables

See `server/.env.example` and `deploy/.env.production.example` for full lists. Highlights:

| Var | Required? | Notes |
|-----|-----------|-------|
| `PORT` | yes | 5000 default |
| `NODE_ENV` | yes in prod | `production` triggers all safety guards |
| `CLIENT_URL` | required in prod | Comma-separated allowlist. Wildcards rejected. FATAL if missing in prod. |
| `JWT_SECRET` | required | FATAL boot if missing. Rotate periodically. |
| `JWT_EXPIRES_IN` | optional | Access token (default 1h) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | yes | Sequelize / Postgres |
| `ENCRYPTION_KEY` | yes in prod | 32 bytes hex. Used for AES-256-GCM. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | yes for push | `npx web-push generate-vapid-keys` |
| `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID`, `TEAMS_REDIRECT_URI`, `TEAMS_SSO_REDIRECT_URI` | optional | Microsoft Teams + Graph API |
| `TEAMS_WEBHOOK_URL` | optional | Outgoing webhook for notifications |
| `DEEPGRAM_API_KEY` | optional | Meeting audio transcription |
| `WEBHOOK_API_KEY` | required if using webhooks | Static key for n8n receiver |
| `WEBHOOK_HMAC_SECRET` | required if `_REQUIRE_SIGNATURE=strict` | HMAC-SHA256 secret |
| `WEBHOOK_REQUIRE_SIGNATURE` | recommended `strict` in prod | `off` / `warn` / `strict`. Default `strict` if `NODE_ENV=production`, else `off`. |
| `HRMS_API_KEY` | optional | Legacy env-var fallback for external HRMS API |
| `CSP_ENFORCE` | recommended `true` in prod | Switch from report-only to enforce |
| `STORAGE_PROVIDER`, `AWS_S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | optional | For S3 storage |
| `MAX_FILE_SIZE` | optional | Bytes; default 26214400 (25 MB) |

### Danger flags — only set explicitly

| Var | Effect |
|-----|--------|
| `ALLOW_PROD_HIERARCHY_SEED=true` | Lets `seed-hierarchy.js` rewrite users.hierarchyLevel from role in prod |
| `ALLOW_SEED_IN_PRODUCTION=true` | Lets `seed-users.js` run in prod (with `SEED_SUPERADMIN_EMAIL/PASSWORD`) |
| `ALLOW_PROD_PLAN_CLEANUP=true` | Lets `cleanup-plan-data.js` DELETE director_plans + time_blocks in prod |
| `ALLOW_PROD_TEAMS_TOKEN_ENCRYPT_BACKFILL=true` | Lets `migrations/run_017.js` encrypt existing plaintext Teams tokens |
| `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY=true` | Auto-resets two specific users' passwords every deploy |
| `FORCE_AUTO_RUN_MAINTENANCE_KEY` | Idempotency key for password-reset script (lives in DB `system_maintenance_runs`) |
| `RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN=true` | Repo-variable override that still triggers reset |
| `LEGACY_RECURRING_ENABLED=true` | Re-enables the legacy Task.recurrence JSONB cron (off by default; new system is RecurringTaskTemplate) |
| `ALLOW_DEV_PASSWORD_RESET=true` | Allows `reset-dev-passwords.js` (dev only — refuses in prod regardless) |
| `ALLOW_SPECIFIC_PASSWORD_RESET=true` + `--allow-production` | Allows `reset-specific-user-passwords.js` (allowlist + dry-run by default) |
| `SLACK_WEBHOOK_URL` | Sent rollback-failure alerts; configure in GH Actions secrets |
| `BACKUP_S3_BUCKET` | Off-host backup target (template wired in `deploy/backup.sh`) |

---

## Common Tasks

- **Add a new API route:** create `server/controllers/<name>.js`, `server/routes/<name>.js`, mount in `server/server.js` under `app.use('/api/<name>', ...)`. Apply `authenticate`, then `managerOrAdmin` / `requireTier(n)` / `requirePermission(resource, action)` as appropriate. Add express-validator `body(...)` chains on POST/PUT.
- **Add a new model:** create `server/models/<Name>.js`, add associations in `server/models/index.js`, then add a self-installing `CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS` block in `server.js start()` wrapped in try/catch. Also add a canonical SQL file in `server/migrations/0NN_*.sql` for audit trail. **Do NOT rely on Sequelize `sync({alter:true})` — it has FK bugs.**
- **Add DB columns:** same pattern — `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` in `server.js`, mirrored in a numbered migration file.
- **Add activity logging:** `const { logActivity } = require('../services/activityService'); logActivity({ action, description, entityType, entityId, taskId, boardId, userId, meta });` — fire-and-forget.
- **Add a notification:** `await notificationService.createNotification({ userId, type, message, entityType, entityId, idempotencyKey: buildIdempotencyKey(...) });` — partial unique index dedups.
- **Add a new page:** create `client/src/pages/<Page>.jsx`, add a `<Route>` in `App.jsx` with the right wrapper, add a sidebar link in `Sidebar.jsx`.
- **Add a new cron job:** create `server/jobs/<job>.js`, wrap the tick body in `withCronLock('jobName:interval', async () => { ... })`, register in `server.js` near the existing job starts.
- **Add an i18n string:** add a key to `client/src/i18n/locales/en.js` AND `hi.js`, then consume via the language hook in the component.

---

## Caveats & Operational Notes

- **OneDrive Files-On-Demand** can stall `npm run dev` — run server and client in separate terminals if combined startup hangs.
- **Sequelize FK ALTER bug:** `ALTER TABLE ... SET DEFAULT NULL REFERENCES` generates invalid SQL. Use manual SQL for FK columns.
- **Vite Google-Fonts CSS warning** — cosmetic, ignore.
- **DB sync wrapping:** `sequelize.sync({ alter: false })` is wrapped in try/catch in `server.js` so a single schema-drift error doesn't prevent boot. Many critical schema changes are also auto-installed via `IF NOT EXISTS` blocks.
- **Boot-time auto-migrations:** ~15 separate blocks in `server.js start()` create tables, add columns, create indexes, add CHECK constraints, normalize default columns. All idempotent. See section "Production Safety Rules" #11 for the behavior-mutating ones.
- **Three sources of truth for task assignment:** `Task.assignedTo`, `TaskAssignee`, `TaskOwner` coexist. Notifications are unified via `utils/taskNotificationRecipients.js`. Read-path code is partially inconsistent — long-term refactor pending.
- **CSP report-only by default:** Set `CSP_ENFORCE=true` after observation window. Until then, XSS payloads can execute despite the policy — file-upload allowlist (`server/config/fileTypes.js`) is the primary defense.
- **/uploads/* serves with `Content-Disposition: attachment`** for non-avatar files, preventing same-origin inline execution of malicious uploads.
- **Pre-deploy `pg_dump`:** `deploy.yml` takes a snapshot before each deploy. Snapshots live on the EC2 host. **Backups are NOT yet shipped off-host** — the `BACKUP_S3_BUCKET` template in `deploy/backup.sh` is wired but commented out until IAM is configured.
- **DB rollback is not automatic.** A failed deploy auto-rolls back the *code* via `git reset --hard $PREVIOUS_SHA`, but auto-migrations are forward-only. Use the pre-deploy snapshot or daily backup if you need to restore data.
- **Plaintext Teams OAuth tokens (P0-5):** Currently stored as plaintext in `users.teamsAccessToken/teamsRefreshToken`. Encryption migration prepared at `server/migrations/017_*` + `server/utils/teamsTokenStorage.js` (dual-path reader). **Run during maintenance window with snapshot.**
- **Cron observability:** Job failures are logged via `console.error` only. No metrics, no alerting hooks. Wire Slack/PagerDuty in a future pass.
- **i18n coverage:** Core navigation and primary buttons are translated (en, hi). Deeper form labels, modal contents, and error messages are still hardcoded English in many pages — extend in future passes.

---

## Test Accounts (Local)

Set up by `node server/seed-users.js` (refuses in prod by default):

| Email | Password | Role | isSuperAdmin |
|-------|----------|------|--------------|
| admin@aniston.com | Admin@1234 | admin | depends on `SEED_SUPERADMIN_EMAIL` |
| manager@aniston.com | Manager@1234 | manager | no |
| john@aniston.com | John@1234 | member | no |
| sara@aniston.com | Sara@1234 | member | no |

---

## Recent Branch Highlights

The `main` branch carries (in addition to the historical phases above):

- **Tier-based RBAC migration** — `users.tier (1-4)`, `requireTier(n)`, `permissionEngine.js` as canonical resolver with DENY > GRANT > base precedence.
- **Single-active-session auth** — `PendingLoginToken` table; login on a new browser revokes prior sessions.
- **Refresh-token rotation + reuse detection** — `RefreshToken` table; reuse burns the entire chain.
- **Multi-manager support** — `ManagerRelation` model with primary/functional/project/dotted_line types.
- **i18n (en / hi)** — `LanguageContext`, locales, `users.language` column, migration 016.
- **Multi-value Link / Reference columns** — `TaskLink`, `TaskReference` models; `LinksCell` + `ReferenceCell` components.
- **Approval flow with parallel stages** — `TaskApprovalFlow.stage` groups parallel approvers. New services: `approvalCapabilityService`, `approvalChainService`, `approvalLifecycleService`, `approvalNotificationService`.
- **Outbound webhooks** — `Webhook` + `WebhookDelivery` models, HMAC-signed deliveries, exponential-backoff retry job, dead-letter status.
- **Recurring task templates** (Phase B) — `RecurringTaskTemplate`, `RecurringWorkPage`, `recurringTaskService`, `recurringTemplateGenerationJob`, `missedRecurringTaskJob`.
- **WhatsApp-style task receipts** — `deliveredAt` / `seenAt` per `task_assignees` row, `taskReceiptService`.
- **Meeting audio streaming** — `meetingStreamService` proxies browser PCM audio to Deepgram via `/api/meeting-stream/ws`.
- **CSP scaffolding** — helmet directives + report-only mode + `/api/csp-report` receiver.
- **Read-only production audit workflows** — two GH Actions workflows for investigating prod state without mutation.
- **Pre-deploy DB snapshot** — `deploy.yml` takes a `pg_dump` before every deploy.
- **Two production safety flips** — Sunny/Muskan force-reset now `false` by default; `seed-hierarchy.js` refuses prod without explicit opt-in.
- **Tier-1 Database Backup Management** — `BackupRecord` model, `backupService.js` (pg_dump streaming + gzip + validation), `routes/adminBackups.js` mounted at `/api/admin/backups`, `dailyBackupJob.js` (6 PM cron, replica-safe via `withCronLock`), retention (30 days for scheduled only), pre-restore safety dump, typed `RESTORE DATABASE` confirmation enforced server-side. Frontend `BackupSettingsPage.jsx` at `/admin/backups` (Tier-1 only). Postgres client installed in backend Dockerfile; backups live in `backup_data:/app/backups` Docker volume.

---

## Database Backup System (Tier 1)

Production-safe DB backup workflow, all gated by `superAdminOnly`.

| Surface | Location | Notes |
|---|---|---|
| Model | `server/models/BackupRecord.js` | UUID PK, `trigger` ∈ (scheduled\|manual\|pre_restore\|uploaded), `status` ∈ (running\|completed\|failed). Auto-installed via DDL block in `server.js`. |
| Service | `server/services/backupService.js` | `pg_dump → gzip → file`, `gunzip → psql` for restore, `gzip -t` validation, path-traversal gate on every file op. Args passed as arrays to `spawn` (no shell). Credentials via `PGPASSWORD` env, not argv. |
| Controller | `server/controllers/adminBackupsController.js` | Multer (`storage=diskStorage`, `.sql.gz` extension only, 2 GB cap). Server-side typed-confirmation check (`RESTORE DATABASE`). |
| Routes | `server/routes/adminBackups.js` | Mounted at `/api/admin/backups`. Every endpoint behind `authenticate` + `superAdminOnly` + rate limiter. |
| Cron | `server/jobs/dailyBackupJob.js` | `0 18 * * *` daily, replica-safe via `withCronLock('dailyDbBackup')`. Retention runs only after successful dump. |
| Frontend | `client/src/pages/BackupSettingsPage.jsx`, route `/admin/backups`, `SuperAdminRoute` guard. Profile dropdown link (`Header.jsx`). |
| Storage | `backup_data:/app/backups` Docker named volume; subdirs `database/`, `pre-restore/`, `uploads-inbox/`. pg_dump installed via `postgresql16-client` in `deploy/Dockerfile.server`. |
| Env | `DB_BACKUP_ENABLED`, `DB_BACKUP_CRON`, `DB_BACKUP_DIR`, `DB_BACKUP_RETENTION_DAYS`, `DB_BACKUP_UPLOAD_MAX_MB` (see `server/.env.example`). |

**Operational rules**
- Format: gzipped plain SQL (`.sql.gz`), produced by `pg_dump --format=plain --clean --if-exists --no-owner --no-privileges`. Restored by streaming through `psql --set ON_ERROR_STOP=1`.
- Restore ALWAYS creates a `pre_restore` safety dump first. The pre-restore artefact is preserved even if the subsequent restore fails (logged in `meta.preRestoreId` of the failure activity row, surfaced to the UI).
- Retention deletes ONLY `trigger='scheduled'` rows older than `DB_BACKUP_RETENTION_DAYS` (default 30). Manual / uploaded / pre-restore artefacts are never auto-pruned.
- Off-host shipping (S3) is NOT yet wired — EC2 host loss = backup loss. The existing `deploy/backup.sh` has a commented `aws s3 cp` template for future use.

---

## Cross-references

- `PRE_PUSH_SAFETY_REPORT.md` — incident-driven safety log for the current branch. **Read before pushing.**
- `SETUP-GUIDE.md` — local + AWS deploy steps.
- `PROGRESS.md` — historical audit notes (March 2026 overnight audit, 56 issues, 35 fixed).
- `TODO_BACKEND.md` — open backend tasks for the Home page redesign.
- `.claude/rules/{api,backend,database,frontend}.md` — domain-specific coding rules.
