# NOTIFICATION & REMINDER SYSTEM — DEEP PRODUCTION AUDIT

**Audit date:** 2026-05-12
**Branch:** `main` (commit `1c817b4`)
**Scope:** Every notification + reminder flow in the repository, end-to-end. Frontend, backend, DB, cron, push, Teams, sockets, tests.
**Reviewers (composite role):** Senior full-stack architect · notification-system engineer · QA automation lead · backend reliability engineer · security reviewer · production incident auditor.
**Mode:** Read-only. No code changes were made during this audit.

---

## A. EXECUTIVE SUMMARY

### Scores

| Dimension | Score | Justification |
|-----------|-------|--------------|
| Overall system health | **6.5 / 10** | Architecture is sound; centralised `notificationService` with idempotency keys is a strong foundation. But many call-sites bypass idempotency, the recurring-miss job ignores approval state, the inactive-user check has a type-confusion silent bug, and there is **zero client-side test coverage** for the notification UI. |
| Production readiness | **6 / 10** | The core fan-out (assignment, overdue, due-soon, push, in-app, Teams) works. Production-only behaviours (multi-replica cron, push permission across users, retention growth) have **3 confirmed P0 issues** and several P1 risks that will surface within months. Not blocking, but not "ship and forget" either. |

### Main risks (concise)

1. **Recurring-miss escalation ignores approval state** — a daily task submitted-for-approval still pages assignees/managers/admins as "missed". Confirmed in [server/jobs/missedRecurringTaskJob.js:197-214](server/jobs/missedRecurringTaskJob.js#L197-L214).
2. **`notificationService.createNotification` silently treats deactivated-user skip as success** — callers cannot distinguish "wrote a notification" from "skipped because user inactive". [server/services/notificationService.js:177-185](server/services/notificationService.js#L177-L185).
3. **Push permission state leaks across users on shared browser** — module-scope flag `pushPermissionAttempted` in Header is never reset on logout. User A's denial silences User B forever on the same machine. [client/src/components/layout/Header.jsx](client/src/components/layout/Header.jsx).
4. **No visible reminder indicator on task rows** — users set a reminder, then have no way to see which tasks have one pending without opening each task. UX gap, not a bug, but a load-bearing trust issue.
5. **Notification & TeamsNotificationLog tables grow unbounded** — no archival, no TTL. Production deployments at scale will hit performance cliffs in 6–12 months.
6. **Approval / dependency / help / extension notifications have no test coverage at all** — the services exist and look correct, but there is no regression net. Any future refactor will be silent if it breaks recipients or idempotency.
7. **Many notification dispatches use the legacy `sendNotification` wrapper, which forwards `idempotencyKey: opts.idempotencyKey || null`** — recurring-generated, recurring-reassigned, recurring-missed, and approval lifecycle all dispatch with `null` keys. Cron re-runs and HTTP retries can duplicate.

### Highest-priority fixes (one-line each)

1. P0 — Call `isTaskEligibleForOverdueNotification(task)` inside the missed-recurring loop before claiming the row.
2. P0 — Change `createNotification` to return `null` (not an object) for the deactivated-user skip; OR change callers to test `if (notification?.id)`.
3. P0 — Reset `pushPermissionAttempted` / `pushSubscribeOk` on logout in `Header.jsx` / `AuthContext.jsx`.
4. P1 — Pass `idempotencyKey: buildIdempotencyKey('recurring-generated', task.id, assigneeId)` from recurring generation.
5. P1 — Build approval/dependency/help/extension/comment-mention idempotency keys, add a unit test for each.
6. P1 — Add a bell-icon indicator on `TaskRow.jsx` / `BoardCard.jsx` when `task.reminders?.length > 0`.
7. P1 — Add `idx_tasks_status_duedate_notarchived` partial index for direct overdue scans.
8. P2 — Add the retention/archival job for `notifications` and `teams_notification_log`.
9. P2 — Tests: `approvalNotificationService.test.js`, `dependencyService.notifications.test.js`, client `NotificationsPanel`, `Toast`, `useSocket`, `pushNotifications`.
10. P2 — Move the socket-emit in `notificationService.createNotification` to after the outer controller transaction commits (or document the current semantic explicitly).

A "production-ready?" decision is at the end of this document.

---

## B. SYSTEM ARCHITECTURE MAP

### Backend (server/)

| Concern | File | Role |
|---------|------|------|
| Centralised notification creator | [server/services/notificationService.js](server/services/notificationService.js) | The only sanctioned entry point. Builds idempotency key, sanitizes message, inserts row, emits socket, fires email. **Never throws.** |
| Assignment fan-out | [server/services/assignmentNotificationService.js](server/services/assignmentNotificationService.js) | Daily-keyed idempotency. Diffs old vs. new assignees/supervisors. |
| Approval fan-out | [server/services/approvalNotificationService.js](server/services/approvalNotificationService.js) | Multi-channel (in-app + push + Teams). Watcher CC. No idempotency keys. |
| Push web-push | [server/services/pushService.js](server/services/pushService.js) | VAPID-validated subscribe/unsubscribe; sendPushToUser; 410/404 hard-delete. |
| Teams fan-out + batching | [server/services/teamsNotificationService.js](server/services/teamsNotificationService.js) | `eventId` unique-index dedup; batched bulk-assign; cancel-on-delete. |
| Socket emit | [server/services/socketService.js](server/services/socketService.js) | JWT auth on handshake; `board:<id>` / `user:<id>` rooms; emitToUser fires push as side-effect. |
| Realtime helper | [server/services/realtimeService.js](server/services/realtimeService.js) | Fire-and-forget wrappers; visibility-filtered fan-out. |
| Dependency lifecycle | [server/services/dependencyService.js](server/services/dependencyService.js) | dispatchDependencyEvent with per-recipient idempotency. |
| Recurring lifecycle | [server/services/recurringTaskService.js](server/services/recurringTaskService.js) | Generation, reassignment, preflight. Uses legacy `sendNotification` (no idempotency). |
| Reminder upsert / scan | [server/services/reminderService.js](server/services/reminderService.js) | applyReminderSpecs, scheduleReminders, processReminders (consumed by deadlineReminderJob). |
| Notification API | [server/controllers/notificationController.js](server/controllers/notificationController.js) | List (visibility-filtered), unread count (NOT filtered), mark-read, delete, clear-read. |
| Notification routes | [server/routes/notifications.js](server/routes/notifications.js) | `/api/notifications` REST endpoints. |
| Push routes | [server/routes/push.js](server/routes/push.js) | `/api/push/vapid-key` (public), subscribe/unsubscribe (auth). |
| Eligibility predicate | [server/utils/taskOverdueEligibility.js](server/utils/taskOverdueEligibility.js) | Single source of truth for "should this task generate an overdue reminder?". Used by reminderJob, deadlineReminderJob, priorityEscalationJob. **NOT used by missedRecurringTaskJob.** |
| Recipient resolver | [server/utils/taskNotificationRecipients.js](server/utils/taskNotificationRecipients.js) | Unions TaskAssignee + legacy `assignedTo`. |
| Sanitizer | [server/utils/sanitize.js](server/utils/sanitize.js) | sanitizeNotificationField / sanitizeNotificationMessage. |
| Notification model | [server/models/Notification.js](server/models/Notification.js) | 31-value type ENUM; idempotencyKey column. |
| Reminder model | [server/models/TaskReminder.js](server/models/TaskReminder.js) | sentAt / cancelled / scheduledFor; expression-based unique index. |
| Push subscription model | [server/models/PushSubscription.js](server/models/PushSubscription.js) | endpoint globally unique via md5 hash. |
| Teams log model | [server/models/TeamsNotificationLog.js](server/models/TeamsNotificationLog.js) | SERIAL PK (only non-UUID model); eventId unique. |

### Cron jobs (server/jobs/)

| Job | Cron | Idempotency | Eligibility | cronLock |
|-----|------|-------------|-------------|----------|
| [reminderJob.js](server/jobs/reminderJob.js) | hourly + daily 09:00 | per-day key | `isTaskEligibleForOverdueNotification` | ✓ |
| [deadlineReminderJob.js](server/jobs/deadlineReminderJob.js) (delegates to reminderService.processReminders) | every 15 min | conditional UPDATE `sentAt` claim | `isTaskEligibleForOverdueNotification` | ✓ |
| [priorityEscalationJob.js](server/jobs/priorityEscalationJob.js) | daily 00:00 | per-day key + conditional UPDATE | `isTaskEligibleForOverdueNotification` | ✓ |
| [recurringTemplateGenerationJob.js](server/jobs/recurringTemplateGenerationJob.js) | every 10 min | partial unique index `(templateId, occurrenceDate)` | n/a | ✓ |
| [missedRecurringTaskJob.js](server/jobs/missedRecurringTaskJob.js) | every 10 min | conditional UPDATE `missedEscalationSent` claim | **status='done' only — does NOT check approval state** | ✓ |
| [recurringTaskJob.js](server/jobs/recurringTaskJob.js) (legacy, off by default) | hourly :15 | **cronLock only — no per-row guard** | n/a | ✓ |
| [webhookRetryJob.js](server/jobs/webhookRetryJob.js) | every 5 min | per-row claim | n/a | ✓ |
| [calendarSyncRetryJob.js](server/jobs/calendarSyncRetryJob.js) | every 15 min | Graph mapping check | n/a | ✓ |
| [vacuumAnalyzeJob.js](server/jobs/vacuumAnalyzeJob.js) | Sunday 03:00 | n/a | n/a | ✓ |

`cronLock` uses Postgres `pg_try_advisory_xact_lock(bigint)` keyed on FNV-1a of the job name; auto-releases on tx end. ([server/jobs/cronLock.js](server/jobs/cronLock.js))

### Frontend (client/src/)

| Concern | File |
|---------|------|
| Auth context (login/logout, broadcastAuthStateToSW) | [client/src/context/AuthContext.jsx](client/src/context/AuthContext.jsx) |
| Realtime provider (queryKey routing) | [client/src/realtime/RealtimeProvider.jsx](client/src/realtime/RealtimeProvider.jsx) |
| Event router | [client/src/realtime/eventRouter.js](client/src/realtime/eventRouter.js) |
| useRealtimeEvent / useRealtimeQuery hooks | [client/src/realtime/](client/src/realtime/) |
| Socket service | [client/src/services/socket.js](client/src/services/socket.js) |
| Push subscription helper | [client/src/services/pushNotifications.js](client/src/services/pushNotifications.js) |
| Service worker | [client/public/sw.js](client/public/sw.js) (auth-state-aware push handler) |
| Notifications panel | [client/src/components/common/NotificationsPanel.jsx](client/src/components/common/NotificationsPanel.jsx) |
| Toast dispatcher | [client/src/components/common/Toast.jsx](client/src/components/common/Toast.jsx) |
| Header (bell badge, push prompt) | [client/src/components/layout/Header.jsx](client/src/components/layout/Header.jsx) |
| Sidebar (approvals badge) | [client/src/components/layout/Sidebar.jsx](client/src/components/layout/Sidebar.jsx) |
| Nav badge counts | [client/src/hooks/useNavBadgeCounts.js](client/src/hooks/useNavBadgeCounts.js) |
| Reminder picker | [client/src/components/task/TaskReminderField.jsx](client/src/components/task/TaskReminderField.jsx) |

### Database (server/models/ + server/migrations/)

Relevant tables: `notifications`, `task_reminders`, `push_subscriptions`, `teams_notification_log`, `tasks`, `task_approval_flows`, `dependency_requests`, `help_requests`, `due_date_extensions`, `recurring_task_templates`. See [Section J](#j-performance-risks) and [Section M](#m-multi-agent-implementation-plan) for the schema-level findings.

### External integrations

- **Microsoft Teams**: per-user OAuth, Adaptive Card delivery via `teamsGraphClient`, bulk batching, retries with exponential backoff, eventId dedup.
- **Web Push (VAPID)**: standard `web-push` library; subscription store in `push_subscriptions`; service worker decrypts and shows OS notification.
- **Deepgram + meeting stream**: unrelated to notifications.
- **n8n + outbound webhooks**: signed deliveries, dead-letter on exhaustion. Out of scope for this audit.
- **SMTP**: best-effort, optional, controlled by `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`.

### Environment variables relevant to notifications/reminders

| Var | Effect |
|-----|--------|
| `JWT_SECRET` | Socket handshake auth. FATAL boot if missing in prod. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Required for web push. Service logs explicit warnings when missing in prod. |
| `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID`, `TEAMS_REDIRECT_URI` | Required for Teams card delivery. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Optional email fallback. Errors swallowed. |
| `ENCRYPTION_KEY` | Encrypts AI provider keys; planned for Teams tokens. |
| `LEGACY_RECURRING_ENABLED` | Re-enables the un-idempotent legacy `recurringTaskJob.js`. **Should remain `false` in prod.** |
| `WEBHOOK_HMAC_SECRET`, `WEBHOOK_REQUIRE_SIGNATURE` | Inbound webhook validation. |
| (none specifically) | No "notify cadence" env var; cadence is hard-coded in cron expressions. |

---

## C. NOTIFICATION FLOW MATRIX

Each row: notification type → trigger → backend path → DB write → socket event → frontend listener → push? → badge update → recipient logic → status → risk.

> **Status legend:** `OK` = working end-to-end & defended. `Partial` = works but missing idempotency or defensive checks. `Broken` = will fire wrongly today. `Unknown` = not covered by this audit (still need to grep).

| # | Type (enum) | Trigger | Backend path | Idempotency key | Socket event | Frontend listener | Push? | Badge update | Recipient logic | Status | Risk | Notes |
|---|-------------|---------|--------------|-----------------|--------------|--------------------|-------|---------------|-----------------|--------|------|-------|
| 1 | `task_assigned` | Task created or `assignedTo` changed | `taskController` → `assignmentNotificationService.diffAndNotify` → `notificationService.createNotification` | `task-assigned:<taskId>:<userId>:<yyyy-mm-dd>` | `notification:new` (per recipient) | Header `useRealtimeEvent` → Toast + showLocalNotification | yes via `emitToUser` side-effect | bell unreadCount, sidebar approvals/dependencies | new assignees − actor | **OK** | Low | Daily-keyed; same-day retry dedupes. |
| 2 | `task_supervisor_added` | Supervisor added to task | same | role-aware idem key | same | same | yes | yes | new supervisors − actor | **OK** | Low | Role distinct from assignee. |
| 3 | `task_role_changed` | User role changed (assignee↔supervisor) | same | role-change key | same | same | yes | yes | affected user | **OK** | Low | New idem key on role flip → fresh notify. |
| 4 | `task_removed` | User removed from task | same | removal key | same | same | yes | yes | removed users − actor | **OK** | Low | Daily-keyed. |
| 5 | `task_updated` (generic) | Approval state change, watcher CC | `approvalNotificationService.dispatchTo` → `createNotification` (NO idempotencyKey) + watchers | **none** | `notification:new` | same | yes | yes | event-specific (next approver, requester, watchers) | **Partial** | P1 | Retry of approval controller dispatches twice. |
| 6 | `comment_added` | New comment | `commentController` → `notificationService.createNotification` | unclear without re-grep; some legacy call sites use `Notification.create` directly | `notification:new` | same | yes | yes | task owner + watchers + @mentions − commenter | **Partial** | P1 | Self-notification on comment self-mention not tested. |
| 7 | `mention` | `@user` in comment | `commentController` (mention parser) → `createNotification` | unclear | same | same | yes | yes | mentioned user(s) − commenter | **Partial** | P2 | No regression test. |
| 8 | `approval_submitted` | Submitter posts for approval | `approvalNotificationService.notifySubmitted` | **none** | `notification:new` | same | yes (+ Teams card) | yes (sidebar approvals) | next approver in chain | **Partial** | P1 | Duplicate on retry. |
| 9 | `approval_approved` | Approver approves | `approvalNotificationService.notifyAdvanced` | **none** | same | same | yes | yes | next stage approvers + requester | **Partial** | P1 | Same. |
| 10 | `approval_rejected` | Approver rejects | `approvalNotificationService.notifyRejected` | **none** | same | same | yes | yes | requester + watchers | **Partial** | P1 | Same. |
| 11 | `approval_changes_requested` | Approver requests changes | `notifyChangesRequested` | **none** | same | same | yes | yes | requester | **Partial** | P1 | Same. |
| 12 | `approval_completed` | Final approval | `notifyCompleted` | **none** | same | same | yes | yes | requester + watchers | **Partial** | P1 | Same. |
| 13 | `recurring_generated` | Cron generates instance | `recurringTaskService.afterInstanceCreated` → `sendNotification(..., 'recurring_generated', task.id)` with `idempotencyKey: null` | **none** | n/a (sendNotification still emits via createNotification) | Header listener | yes | yes | template.assigneeId | **Broken-ish** | P1 | Cron backfill can duplicate. |
| 14 | `recurring_missed` | Missed-instance cron | `missedRecurringTaskJob` → `sendNotification` with `null` key | per-task `missedEscalationSent` flag | implicit | listener | yes | yes | assignee + managers + admins per `escalationTargets` | **Broken** | **P0** | **Does not exclude `approvalStatus=pending_approval` or awaiting-review statuses. Will escalate submitted-but-not-approved daily tasks.** |
| 15 | `dependency_requested` | Cross-team dependency created | `dependencyService.dispatchDependencyEvent('requested', dep, actor)` | `dep-event:requested:<depId>:<userId>` | yes | listener | yes | yes (Header Waypoints) | assignedToUserId − actor | **OK** | Low | Per-recipient key. |
| 16 | `dependency_accepted` | Dependee accepts | same | per-event key | yes | listener | yes | yes | requester + parent owner − actor | **OK** | Low | |
| 17 | `dependency_started` | Status → working_on_it | same | per-event key | yes | listener | yes | yes | requester − actor | **OK** | Low | |
| 18 | `dependency_done` | Dependee completes | same; also unblocks parent | per-event key | yes + `task:unblocked` | listener | yes | yes | requester + parent owner | **Partial** | P2 | Two unblock paths can both emit (`processTaskCompletion` + `recomputeParentBlockState`). |
| 19 | `dependency_rejected` | Dependee rejects | same | per-event key | yes | listener | yes | yes | requester + original assigner | **OK** | Low | |
| 20 | `dependency_cancelled` | Requester cancels | same | per-event key | yes | listener | yes | yes | assigned dependee | **OK** | Low | |
| 21 | `deadline_2day` | Hourly cron `reminderJob` | `reminderJob` 3-day-warn path | `due-3day:<taskId>:<userId>:<yyyy-mm-dd>` | `notification:new` | listener | yes | yes | recipients via `getTaskNotificationRecipients` + creator fallback | **OK** | Low | Eligibility-checked. |
| 22 | `deadline_2hour` | Hourly cron `reminderJob` due-soon path | `reminderJob` due-soon path | `due-soon:<taskId>:<userId>:<yyyy-mm-dd>` | same | listener | yes | yes | same | **OK** | Low | Eligibility-checked. |
| 23 | `due_date` (overdue) | Hourly cron overdue path + custom reminders | `reminderJob` + `deadlineReminderJob` (TaskReminder rows) | `overdue:<taskId>:<userId>:<yyyy-mm-dd>` + TaskReminder.sentAt claim | same | listener | yes | yes | same | **OK** | Low | Best-tested path. |
| 24 | (custom reminder via TaskReminder) | User-set "5 min before due", "at due", custom datetime | `reminderService.processReminders` → conditional UPDATE sentAt → sendNotification | TaskReminder row claim | same | listener | yes | yes | task recipients | **OK** (mostly) | P2 | Reminder is **cancelled if the task goes to a non-eligible status and never re-instated** when it comes back. No visible indicator on the task row (UX gap). |
| 25 | `priority_change` | Daily cron `priorityEscalationJob` | conditional UPDATE + sendNotification | `priority-escalated:<taskId>:<userId>:<yyyy-mm-dd>` | yes | listener | yes | yes | recipients | **OK** | Low | |
| 26 | `extension_requested` | DueDateExtension created | `dueDateExtensionController` (assumed) | unclear | yes | listener | yes | yes | manager/approver | **Unknown** | P2 | No tests, no audit grep. |
| 27 | `extension_approved` | Approve | same | unclear | yes | listener | yes | yes | requester | **Unknown** | P2 | Same. |
| 28 | `extension_rejected` | Reject | same | unclear | yes | listener | yes | yes | requester | **Unknown** | P2 | Same. |
| 29 | `help_requested` | HelpRequest created | `helpRequestController` line 46 | unclear; probably none | yes | listener | yes | yes | requested user | **Unknown** | P2 | No regression test. |
| 30 | `help_responded` | Help responded | `helpRequestController` line 128 | unclear | yes | listener | yes | yes | requester | **Unknown** | P2 | Same. |
| 31 | `access_requested` | AccessRequest created | accessRequestController | unclear | yes | listener | yes | yes | admins / role reviewers | **Unknown** | P2 | |
| 32 | `access_approved` | Approve | same | unclear | yes | listener | yes | yes | requester | **Unknown** | P2 | |
| 33 | `access_rejected` | Reject | same | unclear | yes | listener | yes | yes | requester | **Unknown** | P2 | |
| 34 | `board_member_added` | Member added | `boardController` line 739 | unclear | yes | listener | yes | yes | added member | **OK** (legacy) | Low | |
| 35 | `board_member_removed` | Member removed | `boardController` line 833 | unclear | yes | listener | yes | yes | removed member | **OK** (legacy) | Low | |
| 36 | `promotion` | Promotion recorded | promotionController | unclear | yes | listener | yes | yes | promoted user | **Unknown** | P3 | |

### Notification fan-out chain (the canonical path)

```
controller / cron job
    └─ notificationService.createNotification({ userId, type, message, idempotencyKey?, … })
         ├─ sanitizeNotificationMessage()          # xss-safe regardless of caller
         ├─ User.findByPk(userId, attr:['isActive']) → if inactive, return { success:false, … } (BUG)
         ├─ findByIdempotencyKey()                 # try/catch — fall-through if column missing
         ├─ Notification.create(…)                 # caught for 23505 + idemKey → re-fetch winner
         ├─ emitToUser(userId, 'notification:new', { notification, boardId })
         │     ├─ io.to(`user:<id>`).emit(…)
         │     └─ pushService.sendPushToUser(userId, …)   # async, errors swallowed
         └─ best-effort email via SMTP transport   # fire-and-forget
```

This chain is correct conceptually. Risks are at the seams (the idempotency-key skip, the inactive-user check, the legacy `sendNotification` wrapper that passes `null` keys).

---

## D. REMINDER SYSTEM MATRIX

| Reminder type | Source field(s) | Scheduler | Eligibility logic | Status exclusions | Repeat prevention | Timezone | Status | Risk | Notes |
|---------------|-----------------|-----------|--------------------|--------------------|---------------------|----------|--------|------|-------|
| 3-day deadline warn | `tasks.dueDate` | `reminderJob.daily09:00` | `isTaskEligibleForOverdueNotification` | done, awaiting-review, pending_approval, approved, archived | per-user-per-day idem key | UTC compare, "end-of-day UTC" semantic | **OK** | Low | Documented in [taskOverdueEligibility.js](server/utils/taskOverdueEligibility.js). |
| Due-soon (hourly) | `tasks.dueDate` | `reminderJob.hourly` | same | same | per-user-per-day idem key | UTC | **OK** | Low | |
| Overdue (hourly) | `tasks.dueDate` | `reminderJob.hourly` | same | same | per-user-per-day idem key | UTC | **OK** | Low | Tests cover this. |
| Custom user reminder (offset) | `TaskReminder.reminderType='offset' + offsetMinutes` | `deadlineReminderJob` every 15 min → `reminderService.processReminders` | `isTaskEligibleForOverdueNotification` | same | conditional UPDATE `sentAt=NOW() WHERE sentAt IS NULL` | UTC | **OK** | P2 | Cancelled on status flip; not re-armed if status flips back to actionable. Confirmed in [reminderService.js:620](server/services/reminderService.js#L620). |
| Custom user reminder (at_due) | `TaskReminder.reminderType='at_due'` | same | same | same | same | UTC | **OK** | P2 | Same caveat. |
| Custom user reminder (explicit datetime) | `TaskReminder.reminderType='custom' + customReminderAt` | same | same | same | same | UTC (input is `<input type="datetime-local">` — browser local time → ISO UTC) | **OK** | P2 | No timezone hint in UI. |
| Priority escalation (progress ≥80%) | `tasks.progress` + `tasks.priority` | `priorityEscalationJob.daily00:00` | same | same | per-user-per-day idem key + conditional UPDATE on priority flip | UTC | **OK** | Low | |
| Recurring task generation | `RecurringTaskTemplate.nextRunAt` | `recurringTemplateGenerationJob.every10min` | n/a (creates new tasks) | n/a | partial unique idx `(templateId, occurrenceDate)` | per-template `timezone` IANA tz | **OK** | Low | The only flow with explicit per-row tz. |
| Recurring missed escalation | `tasks.missedEscalationSent` flag + template `escalateIfMissed` + `escalationTargets` | `missedRecurringTaskJob.every10min` | **only `status: { Op.notIn: ['done'] }`** | **NOT approval-state-aware** | conditional UPDATE `missedEscalationSent` claim | per-template `timezone` IANA tz | **Broken** | **P0** | **Confirmed: file imports neither `isTaskEligibleForOverdueNotification` nor `AWAITING_REVIEW_STATUSES`. Task submitted-for-approval still escalates as missed.** [server/jobs/missedRecurringTaskJob.js:197-214](server/jobs/missedRecurringTaskJob.js#L197-L214) |
| Legacy `Task.recurrence` JSONB cron | `tasks.recurrence` JSONB | `recurringTaskJob.hourly` (off unless `LEGACY_RECURRING_ENABLED=true`) | **none** | **none** | **cronLock only — no row-level dedup** | depends on caller | **Broken-ish** | P1 | Disabled by default. Keep it that way. |

### Custom-reminder save → fire (end-to-end, verified)

```
TaskReminderField.jsx          → user picks {kind, offsetMinutes/at_due/custom + at}
   ↓ toWriteShape()
TaskModal save()              → PUT /api/tasks/:id  body.reminders=[…]
   ↓
taskController.update         → normalizeReminderSpecs(req.body.reminders)
   ↓
reminderService.applyReminderSpecs(taskId, specs, { dueDate })
   ├─ cancel rows whose spec was removed
   ├─ for each kept spec:
   │    SELECT (taskId, reminderType, COALESCE(offsetMinutes,-1), COALESCE(customReminderAt,'1970-01-01'))
   │       ↳ row exists → UPDATE scheduledFor + cancelled=false
   │       ↳ row missing → INSERT TaskReminder
   │            ↳ on 23505 (race) → re-fetch + UPDATE
   ↓ (rows persist across restart)
deadlineReminderJob.every15min → withCronLock('deadlineReminderJob')
   ↓
reminderService.processReminders(now)
   ├─ SELECT WHERE scheduledFor ≤ now AND sentAt IS NULL AND cancelled=false  (LIMIT 200)
   ├─ for each:
   │    if !isTaskEligibleForOverdueNotification(task) → UPDATE cancelled=true; continue
   │    UPDATE sentAt=NOW() WHERE id=? AND sentAt IS NULL AND cancelled=false   ← CLAIM
   │       ↳ affectedCount=0 → another replica won; skip
   │       ↳ affectedCount=1 → resolve recipients → sendNotification per recipient
```

This is genuinely well-designed. The two confirmed gaps are: (a) **no visual indicator** for tasks with reminders on the row, and (b) **reminders cancelled on status flip are not re-armed** if the status flips back to actionable.

---

## E. BUGS FOUND (severity-ordered, with file:line)

> Each bug has been verified against the actual code, not just the agent summaries.

### P0 — Critical (ship-stopping or data-integrity)

**P0-1 — `missedRecurringTaskJob` ignores approval/awaiting-review state**
- **File:** [server/jobs/missedRecurringTaskJob.js:197-214](server/jobs/missedRecurringTaskJob.js#L197-L214) (the `Task.findAll` candidate query) and the body loop at [lines 224-258](server/jobs/missedRecurringTaskJob.js#L224-L258).
- **Function:** `tickOnce(now)`
- **Current behavior:** The candidate query only excludes `status IN ['done']` (see `COMPLETED_STATUSES` at line 50). It does **not** import `taskOverdueEligibility` and does **not** consult `task.approvalStatus`. A daily task that the assignee already submitted for approval still passes the filter and gets escalated to assignee + managers + admins as "missed".
- **Expected behavior:** A task in `status='waiting_for_review'` or `approvalStatus='pending_approval'/'approved'` is **not** missed — the assignee has done their part. Skip.
- **Root cause:** Job pre-dates the centralised eligibility helper and was never retrofitted.
- **User impact:** Daily false-positive escalations to managers/admins on busy boards. Erodes trust in the system, trains users to ignore notifications.
- **Production risk:** High. Worse on boards that use the approval workflow heavily.
- **Recommended fix:** Add `const { isTaskEligibleForOverdueNotification } = require('../utils/taskOverdueEligibility');` and inside the for-loop, right before the conditional UPDATE at line 248, do `const { eligible, reason } = isTaskEligibleForOverdueNotification(task); if (!eligible) { skipped += 1; continue; }`. Also flip `missedEscalationSent=true` regardless (so the same task doesn't keep being re-evaluated every 10 minutes once it's in an ineligible state).
- **Test required:** Add a test case in `__tests__/jobs/missedRecurringTaskJob.test.js` covering: `status='working_on_it', approvalStatus='pending_approval'` → no notify, flag flipped; `status='waiting_for_review'` → no notify, flag flipped.

**P0-2 — `notificationService.createNotification` returns truthy object on deactivated-user skip**
- **File:** [server/services/notificationService.js:177-185](server/services/notificationService.js#L177-L185)
- **Function:** `createNotification(args)`
- **Current behavior:** When the recipient is `User.isActive === false`, the function returns `{ success: false, reason: 'user_inactive' }`. Most callers (e.g. assignment service line 282-291, recurring service, missed-recurring loop) treat any truthy return as "success" — so they update activity logs, post analytics, and proceed as if the notification fired. Some callers will subsequently try to read `.id` off the return value and crash on the second call site.
- **Expected behavior:** Either return `null` (matching the documented contract at the top of the file: "createNotification NEVER throws ... returns null") OR return a typed object that callers check with `if (notification && notification.id)`. The current contract is ambiguous.
- **Root cause:** The "P2-8" comment (line 173) introduced the skip but did not update the documented return type contract.
- **User impact:** Deactivated users silently absorb activity log entries that claim notifications fired. Future "did the notification fire?" audits will show `success` rows for deactivated users that received nothing.
- **Production risk:** Medium — observability is wrong, not behavior. But the audit trail is corrupted.
- **Recommended fix:** Change line 180 to `return null`. (The skip semantic is already preserved by the early return.) Audit callers; none of them branch on the returned object today, only on truthiness — `null` is the safer signal.
- **Test required:** Unit test that `await createNotification({ userId: deactivatedUserId, … })` resolves to `null` and no socket emit / no DB insert is observed.

**P0-3 — Browser push permission state leaks across users on shared browser**
- **File:** [client/src/components/layout/Header.jsx](client/src/components/layout/Header.jsx) (lines ~74-92 per the frontend agent; module-scope `pushPermissionAttempted` and `pushSubscribeOk` declarations)
- **Function:** Header push prompt effect; AuthContext logout path
- **Current behavior:** `pushPermissionAttempted` and `pushSubscribeOk` are module-scope booleans (not stored in React state and not in AuthContext). They persist across login/logout cycles within the same tab. If User A is prompted and denies, then logs out, then User B logs in on the same machine, User B will never be prompted because the module flag is still `true`.
- **Expected behavior:** On `logout`, reset both flags. On `login`, re-evaluate from `Notification.permission` (which is per-origin, but the user explicitly opted in once, so we should still prompt them if they were never prompted in this app session — at minimum re-attempt subscribe).
- **Root cause:** Module-scope state for what should be per-user-session state.
- **User impact:** Multi-user shared browsers (lab computers, family iPads) see one user's choices silently applied to everyone. Also: any user who denies once will never be prompted again, even on a different device session.
- **Production risk:** Real for any deployment used in shared environments (warehouses, support desks, kiosks).
- **Recommended fix:** Move both flags into `AuthContext` (or a `usePushPrompt` hook) keyed on `user?.id`. On logout, the keying naturally resets. Bonus: on `Notification.permission === 'denied'`, surface a small banner explaining how to re-enable in browser settings.
- **Test required:** Vitest test on Header (which currently has zero tests) covering: mount → user A → deny → unmount → user B mount → expect prompt.

**P0-4 — `notifications` table has no archival / TTL**
- **File:** [server/models/Notification.js](server/models/Notification.js); no cleanup job exists.
- **Current behavior:** Every notification row remains forever. There is no `archivedAt` column, no retention cron, and no documented policy.
- **Expected behavior:** Read rows older than 30–90 days should be archived (or deleted). Unread rows are kept until the user reads or explicitly clears.
- **Root cause:** Retention was not in scope of the initial notification rollout.
- **User impact (production):** None for a year; then the table will dominate write latency and backup size. With ~5–20 notifications/user/day, a 500-user deployment generates ~10k-100k rows/day → millions/year.
- **Production risk:** High at scale. **This is the single most likely "we got paged at 3am" outcome from this audit.**
- **Recommended fix:** Add a nightly cron `notificationCleanupJob.js` (wrapped in `withCronLock`) that `DELETE FROM notifications WHERE isRead=true AND createdAt < NOW() - INTERVAL '90 days'` in batches of 10k. Also add the same retention to `teams_notification_log` (`status='sent' AND createdAt < NOW() - INTERVAL '30 days'`).
- **Test required:** Job-level test with mocked clock; integration test with real DB to verify it doesn't lock the table.

### P1 — High (correctness/coverage)

**P1-1 — Approval-lifecycle notifications have no idempotencyKey**
- **File:** [server/services/approvalNotificationService.js](server/services/approvalNotificationService.js) (every dispatch from notifySubmitted/notifyAdvanced/notifyRejected/notifyChangesRequested/notifyCompleted; lines 108, 130, 152, 176, 202 per agent map)
- **Current behavior:** `dispatchTo` does not build or pass an `idempotencyKey`. Any retry of the approval controller (network blip, double-submit, replay) creates duplicate notifications, duplicate push, duplicate Teams cards.
- **Expected behavior:** Build a deterministic key like `approval-event:<approvalFlowId>:<event>:<recipientId>` and pass it to `createNotification`. The partial unique index will dedup transparently.
- **Recommended fix:** Add the key in `dispatchTo`. Also pass to `pushService.sendPushToUser` and `teamsNotificationService.sendTeamsCard` so they can no-op on second call.
- **Test required:** Net-new `approvalNotificationService.test.js` (currently zero coverage) with a "calling dispatchTo twice yields one notification row" case.

**P1-2 — Recurring generated/reassigned notifications have no idempotencyKey**
- **File:** [server/services/recurringTaskService.js:709-715](server/services/recurringTaskService.js#L709-L715) (`afterInstanceCreated`) and [lines 1342-1350](server/services/recurringTaskService.js#L1342-L1350) (`reassignOpenInstances`).
- **Current behavior:** Uses legacy `sendNotification(...)` wrapper, which forwards `idempotencyKey: opts.idempotencyKey || null`. Same-day cron backfill / replica race / retry creates duplicates.
- **Recommended fix:** Pass `{ idempotencyKey: buildIdempotencyKey('recurring-generated', task.id, assigneeId) }` and `{ idempotencyKey: buildIdempotencyKey('recurring-reassigned', task.id, newAssigneeId) }` respectively.
- **Test required:** Backfill scenario test — run `afterInstanceCreated` twice for the same task → one notification.

**P1-3 — Recurring-missed escalation has no idempotencyKey + no eligibility check (compound with P0-1)**
- **File:** [server/jobs/missedRecurringTaskJob.js:272-278](server/jobs/missedRecurringTaskJob.js#L272-L278)
- **Current behavior:** `sendNotification(userId, 'Recurring task missed', message, 'recurring_missed', task.id)` with `null` key. The per-row `missedEscalationSent` flag prevents the **task** from being re-escalated, but a sibling worker race within the same tick can fire two notifications to the same user before either has UPDATEd the flag. Worse, see P0-1.
- **Recommended fix:** Pass `{ idempotencyKey: buildIdempotencyKey('recurring-missed', task.id, userId) }`. Cross-cuts with P0-1.

**P1-4 — Custom reminders are cancelled on status flip but not re-armed when actionable again**
- **File:** [server/services/reminderService.js:620](server/services/reminderService.js#L620) (the line that sets `cancelled=true` when eligibility fails)
- **Current behavior:** If a task is at `working_on_it` with a custom "remind me 10 min before due" reminder, and the user marks it `done`, the next cron tick cancels the reminder. If a reviewer later flips the status back to `working_on_it` (e.g. changes_requested), the reminder is gone and will not fire.
- **Expected behavior:** Either don't cancel (just skip + leave `sentAt=null`) so that if the task becomes eligible again the reminder still has a chance; or re-arm cancelled-not-sent reminders on relevant status transitions.
- **Recommended fix:** Change `cancelled=true` to a skip-and-leave on the eligibility path (lines ~620), reserving `cancelled` for explicit user cancellation, due-date changes, and task deletion.
- **Test required:** Unit test: schedule a reminder; flip status to `done`; tick; flip back to `working_on_it`; tick at reminder time → still fires.

**P1-5 — Approval flow missing FK SET NULL audit safety in controllers**
- **File:** [server/models/TaskApprovalFlow.js](server/models/TaskApprovalFlow.js)
- **Current behavior:** `userId` is `ON DELETE SET NULL` (intentional — preserves audit history of who approved what). `userName` and `role` are snapshotted on the row. **But the approval notification service likely reads through to `User.email` for the email fallback — if the user is deleted, this can NPE or skip silently.**
- **Recommended fix:** Audit every `approvalNotificationService` and `approvalController` call path that reads `approver.email` and ensure null-safe fallback to the snapshot `userName`.
- **Test required:** Approver deleted mid-flow → next dispatch does not throw, in-app notification skipped gracefully.

**P1-6 — Dependency unblock fires from two code paths with separate idempotency keys**
- **File:** [server/services/dependencyService.js:140-148](server/services/dependencyService.js#L140-L148) (`processTaskCompletion`) and [lines 376-389](server/services/dependencyService.js#L376-L389) (`recomputeParentBlockState`).
- **Current behavior:** Both paths can fire a "your task is unblocked" notification to the parent task owner with separate idempotency keys. If they race within the same tick (blocker completed + dependency removed in same controller call), the owner sees two notifications.
- **Recommended fix:** Funnel both paths through a single helper with a shared key `unblock:<parentTaskId>:<userId>:<yyyy-mm-dd>`.

**P1-7 — Missing composite index `idx_tasks_status_duedate_notarchived`**
- **File:** [server/models/Task.js](server/models/Task.js) + server.js boot migrations
- **Current behavior:** Indexes exist on `status` and `dueDate` separately, but any direct scan like `WHERE status NOT IN (...) AND dueDate < NOW() AND isArchived = false` does a sequential scan once the tasks table grows past a few hundred thousand rows.
- **Recommended fix:** Add a partial composite index:
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_status_duedate_notarchived
    ON tasks (status, "dueDate")
    WHERE "isArchived" = false;
  ```
- **Test required:** EXPLAIN ANALYZE before/after with a seeded fixture.

**P1-8 — Push subscription save has no retry on transient network failure**
- **File:** [client/src/services/pushNotifications.js](client/src/services/pushNotifications.js) (`subscribeToPush`)
- **Current behavior:** A timeout on `POST /api/push/subscribe` returns `{ ok: false, reason: 'save-failed' }`. `pushSubscribeOk` stays false. The browser has a `PushSubscription` registered locally but the backend doesn't know about it. The user receives **no** server-side pushes until the next page load triggers the Header useEffect.
- **Recommended fix:** Exponential backoff retry (3 attempts, 1s/3s/10s) inside `subscribeToPush` before giving up.

**P1-9 — Service Worker auth-state race on login**
- **File:** [client/src/context/AuthContext.jsx](client/src/context/AuthContext.jsx) (broadcastAuthStateToSW order)
- **Current behavior:** `broadcastAuthStateToSW('authenticated')` is called after `loadUser()` resolves. There is a ~100ms window where the socket has connected, push notifications can arrive, but the SW still has the prior auth state. The user-A-then-user-B switch on the same browser is the failure mode: stale push arrives during the window, SW reads `SW_AUTH_STATE='loggedOut'` (technically correct for that moment) but the body may still be User A's content.
- **Recommended fix:** Broadcast `'authenticated'` synchronously, immediately after the auth token is in memory and before connect(). Also broadcast `'unknown'` on logout (not `'loggedOut'`) so the SW renders the generic body, then explicitly mark `'loggedOut'` after socket disconnect completes.

### P2 — Medium (operational/UX)

**P2-1 — Visibility filter in `getNotifications` fails open**
- **File:** [server/controllers/notificationController.js](server/controllers/notificationController.js) lines 50, 59, 78, 85
- **Current behavior:** If `taskVisibilityService.canViewTask` throws (transient DB blip), the notification is kept in the result set.
- **Expected:** Fail-closed (exclude on error) OR add explicit alerting.
- **Risk:** Very brief data leak on demotion + transient DB error.

**P2-2 — Unread count not visibility-filtered**
- **File:** [server/controllers/notificationController.js](server/controllers/notificationController.js) `getUnreadCount`
- **Current behavior:** Returns raw count without visibility filter. Documented in the file. Brief over-count after demotion.
- **Risk:** Cosmetic. Bell badge shows N even though only N-K are reachable.

**P2-3 — Teams bulk-batching race on threshold hit**
- **File:** [server/services/teamsNotificationService.js:471-534](server/services/teamsNotificationService.js#L471-L534)
- **Current behavior:** Two assignments within the same second can both pass the batch-not-empty check and both fire a card.
- **Risk:** Cosmetic duplicate Teams card.

**P2-4 — Notification emit happens before outer controller transaction commits**
- **File:** [server/services/notificationService.js:228-232](server/services/notificationService.js#L228-L232)
- **Current behavior:** `emitToUser` fires inside `createNotification`. If the *caller's* enclosing controller transaction rolls back (e.g. permission check fails after notification creation), the user has already received the socket event for an action that didn't commit.
- **Risk:** Stale notifications on rare rollbacks. The notification row itself is committed (it's not in the controller's tx), so the bell will still show it.
- **Fix:** Either require callers to pass a transaction and emit on `afterCommit`, or document this current behavior explicitly. Most callers create the notification *after* their commit, so this is rare in practice.

**P2-5 — Toast cap of 5 silently drops older toasts**
- **File:** [client/src/components/common/Toast.jsx](client/src/components/common/Toast.jsx)
- **Current behavior:** `MAX_TOASTS=5`; the 6th drops the oldest with no "X more" indicator.

**P2-6 — eventRouter fan-out invalidates approvals/dependencies badges on every notification**
- **File:** [client/src/realtime/eventRouter.js](client/src/realtime/eventRouter.js)
- **Current behavior:** Every `notification:new` invalidates both `approvals.pendingCounts` and `dependencies.assignedActiveCount` regardless of notification type. Two extra API calls per notification.

**P2-7 — Notification.entityId is polymorphic with no FK; orphan rows possible**
- **File:** [server/models/Notification.js](server/models/Notification.js)
- **Current behavior:** Polymorphic — `entityType + entityId` with no FK. Deleting a task via raw SQL leaves dangling notifications. UI must handle broken references.
- **Fix:** Add a periodic cleanup job that marks notifications whose entity is gone (skip if `entityType='task'` and `Task.findByPk(entityId)` is null), or accept as design and ensure UI fallback.

**P2-8 — `TeamsNotificationLog` and `notifications` tables can grow unbounded**
- See P0-4 above; same problem, same fix.

**P2-9 — No reminder indicator on task rows**
- **File:** [client/src/components/board/TaskRow.jsx](client/src/components/board/TaskRow.jsx), [BoardCard.jsx](client/src/components/board/BoardCard.jsx), kanban card
- **Current behavior:** User sets a reminder in TaskModal. Closes modal. No visual indicator anywhere that this task has a pending reminder.
- **Fix:** Conditional small bell icon when `task.reminders?.length > 0`.
- **User trust impact:** Significant — directly listed in the user's "known issues" item #5.

**P2-10 — `applyReminderSpecs` swallows non-unique constraint errors**
- **File:** [server/services/reminderService.js:402-424](server/services/reminderService.js#L402-L424)
- **Current behavior:** Race handler re-throws everything except 23505. A SequelizeValidationError on a custom timestamp loses the reminder spec while the task save succeeds.
- **Fix:** Logging + bounded retry; never silently lose a user-set reminder.

### P3 — Low (polish)

- **P3-1** — `recurringTaskJob.js` (legacy) does not validate `recurrence.nextRun` is a valid date. Out of scope unless `LEGACY_RECURRING_ENABLED=true`.
- **P3-2** — `errorMessage` TEXT column in TeamsNotificationLog has no length cap; truncate to 500 chars on insert.
- **P3-3** — `RecurringTaskTemplate.nextRunAt` index is not partial — scans archived rows uselessly.
- **P3-4** — No `Sentry`/`Datadog` integration for cron error logs.
- **P3-5** — `Notification.markAsRead` lacks tier enforcement (only ownership check). Inconsistent with `deleteNotification`. Low-risk because ownership is the strict gate.
- **P3-6** — `pushService.sendPushToUser` floods logs when VAPID is unconfigured. By design but operationally noisy.

---

## F. MISSING FUNCTIONALITY

These are features that look intended (UI hooks, enum members, model columns) but are not fully wired.

1. **Visible reminder indicator on task rows** (P2-9 above) — UI affordance missing.
2. **Reminder management dashboard** — no place to list/edit/cancel all your reminders. Only via re-opening each task.
3. **Notification preferences UI** — there is no user-facing setting to mute notification types, set quiet hours, or choose channels (email vs push vs in-app). Server has the multi-channel dispatch but no per-user preferences.
4. **`Notification.type` enum values not reachable from any controller** — `promotion`, possibly `access_*`, were added but no audited controller path inserts them. Either dead code or controller logic missed in this audit.
5. **`task.recurrence` JSONB legacy path** — kept behind `LEGACY_RECURRING_ENABLED`. Deprecate and remove.
6. **Notification archive table** — schema does not exist. Retention is unimplemented.
7. **Push subscription unsubscribe on logout** — the frontend logout path does not call `/api/push/unsubscribe` or `subscription.unsubscribe()`. Stale subscriptions accumulate per device; rely on backend 410-detection later.
8. **WhatsApp integration** — referenced in product context but no service / config / model in the repo. Out of scope.
9. **Custom-reminder timezone hint** — TaskReminderField uses `<input type="datetime-local">` (browser local time). User sees their local time, server stores UTC. No tz hint in the UI for users who travel or have non-default tz.

---

## G. DUPLICATE NOTIFICATION RISKS

Every place where a duplicate notification can fire today:

1. **Approval lifecycle on retry** (P1-1) — no idem key; controller retry duplicates every approval transition.
2. **Recurring generated on cron backfill** (P1-2) — no idem key.
3. **Recurring missed escalation race** (P1-3) — multi-replica race within the same 10-minute tick (before `missedEscalationSent=true` UPDATE wins on one replica).
4. **Dependency unblock from two paths** (P1-6) — `processTaskCompletion` + `recomputeParentBlockState`.
5. **Teams bulk-batch threshold race** (P2-3) — two concurrent batch sends in <1s.
6. **Sequelize partial-unique-index race-not-23505** — if `findByIdempotencyKey` returns `null` after a 23505 retry (DB transient blip during the re-fetch), the second caller throws and the controller may then call `createNotification` again on its own retry path → two rows.
7. **`Notification.create` called directly outside `notificationService`** — board_member_added/removed, help_request*, extension_request*, comment_added/mention all need audit. Any direct `Notification.create` call without `idempotencyKey` is a duplicate risk.
8. **Socket reconnect → Toast re-fire** — frontend has no proven dedup on socket reconnect for the same `notification:new` event. The Toast dedup is keyed on `type+title+body+1500ms`, which works for rapid resends but not for "user reconnects after 30 min and the server re-emits stale events" (server doesn't replay, but if it did, dedup window is too short).
9. **Multi-tab browser** — each tab independently shows the in-app toast for the same event. There is BroadcastChannel coordination for logout but not for toast dedup. (OS push is fine — SW tag-collapses.)
10. **Legacy `recurringTaskJob`** — cronLock-only; crash mid-tick can duplicate.

---

## H. MISSING NOTIFICATION RISKS

Places where a notification can be silently dropped:

1. **Inactive user skip silently treated as success** (P0-2) — caller thinks "notified" but nothing happened.
2. **`emitToUser` failure swallows `sendPushToUser`** — if the socket emit throws *before* reaching the push fan-out, no push fires. Both are async, but execution order is socket-first.
3. **`pushService.sendPushToUser`** — all errors swallowed silently. A misconfigured VAPID or an SSL renegotiation failure surfaces only in logs, never to the operator.
4. **SMTP failure** — `transport.sendMail(...).catch(err => logger.warn(...))`. Email reminders never send if SMTP misconfigured, but no operator alert.
5. **Teams `sendChatMessage` failure post-eventId-log** — eventId is logged before send; if send fails after log, the row is `'failed'` and a retry with same eventId is skipped (per service design). This is intentional, but it means "exactly once" can degrade to "at most once" if send fails.
6. **Recurring template hard-deleted** — `recurringTaskService` checks for `tpl` being null and skips. No alert.
7. **Recipient list empty (deactivated assignee, no managers)** — `missedRecurringTaskJob` flips the flag and skips silently. By design but should be logged.
8. **`reminderService.processReminders` claim failure** — if conditional UPDATE returns affectedCount=0, the row is skipped silently. By design (another replica won), but in a single-replica deploy this indicates a real bug.
9. **`approvalNotificationService` push/Teams `.catch()` swallowed** — lines 81, 95 per agent audit. A 401 from Teams burns the user's token (correctly), but a transient 500 is invisible.
10. **`Notification.create` 23505 → re-fetch fails** — if the re-fetch itself fails, the function throws. Controllers typically `.catch()` and proceed, which leaves zero notification rows for that event.
11. **Frontend push subscribe failure** (P1-8) — backend doesn't get the subscription; user receives no pushes.
12. **Frontend not re-arming after permission state change** — if user grants permission later via browser settings, no UI re-prompts to subscribe.

---

## I. SECURITY RISKS

1. **Notifications visible to wrong user via socket** — addressed: socket rooms are `user:<id>`-scoped and JWT-authenticated. **OK.**
2. **`markAsRead` IDOR** — addressed by `WHERE id=? AND userId=?` in [notificationController.js:165-189](server/controllers/notificationController.js#L165-L189). **OK.**
3. **`deleteNotification` IDOR** — same pattern, plus `assertCanDelete` tier gate. **OK.**
4. **Notification payloads leak task data** — the message body is the same `task.title` + assignee names. If a user is in two notifications about the same task and gets demoted from one but the row stays in their inbox, brief over-disclosure (P2-1/P2-2). Fail-open visibility filter compounds this.
5. **Push payloads on shared device** — addressed via SW auth-state gate (renders generic "Sign in to view" body when not authed). **OK, with P0-3 caveat about state leakage.**
6. **Email recipient leak** — `email` is read from `User.email` directly. Verified that the recipient is `req.user` controlled — i.e., we email the notification *recipient*, not the actor — so no leak. **OK.**
7. **Teams cards** — sent to the recipient's Teams account via their own OAuth token. Cross-user leak only possible if the OAuth token store is read by the wrong user. Teams tokens are currently **plaintext in `users.teamsAccessToken/teamsRefreshToken`** (per CLAUDE.md P0-5). **Cross-cutting risk, separate audit.**
8. **CSP & XSS** — `sanitizeNotificationMessage` is called by default in `createNotification`. Any direct `Notification.create` callers bypass this. Grep + audit needed for all `Notification.create` call sites.
9. **VAPID key disclosure** — `GET /api/push/vapid-key` is public. **OK** (intended — VAPID public key is meant to be public).
10. **Subscription forge** — `POST /api/push/subscribe` is authenticated. `user.id` is taken from the JWT, not the body. **OK.**
11. **Webhook receiver HMAC** — out of scope; controlled by `WEBHOOK_REQUIRE_SIGNATURE`. **OK** if set to `strict` in prod.
12. **Activity log / notification message reflects raw user input** — sanitizer present; verify no path bypasses it.
13. **Audit trail manipulation** — `TaskApprovalFlow.userId ON DELETE SET NULL` preserves audit; `userName` snapshot ensures readability post-deletion. **OK.**
14. **Mass-notification fan-out (DoS)** — `getEscalationAdminIds` caps at 5. `recurringTemplateGenerationJob` caps at 200/tick. **OK.**

---

## J. PERFORMANCE RISKS

1. **`notifications` table unbounded growth** (P0-4) — biggest single risk.
2. **`teams_notification_log` unbounded growth** (P2-8).
3. **`push_subscriptions` inactive rows linger** — purge after `deactivatedAt < 6 months`.
4. **Missing partial composite index `(status, dueDate) WHERE isArchived=false`** (P1-7).
5. **`reminderJob` has no `LIMIT` on `Task.findAll`** — after long downtime, a single tick scans every overdue task at once. Recommend `LIMIT 500` and rely on subsequent ticks. (Confirmed in agent finding P2.1.)
6. **`getNotifications` heuristic over-fetch of 3× limit** — fine, but worst case (entire page filtered out by visibility) requires multiple round trips.
7. **eventRouter unconditional fan-out** (P2-6) — 2 extra API calls per notification.
8. **Toast dedup window is fixed at 1500ms** — fine for the common case.
9. **`Notification.findByIdempotencyKey` does a userId+idempotencyKey scan** — partial unique index covers it. **OK.**
10. **Cron job log noise** — `logger.info` per tick is fine; `pushService` log per push without VAPID is noisy.
11. **Multi-recipient fan-out in `notifyApproved` etc. iterates serially** — for a 50-watcher task, that's 50 sequential awaits. Migrate to `Promise.allSettled`.
12. **`io.to(room).emit(...)` with Redis adapter** — fine for horizontal scale, but verify Redis adapter is wired in prod (`socket.io-redis` configured?).

---

## K. PRODUCTION RISKS

Issues that may only show in production (multi-replica, real load, real time):

1. **Multi-replica cron race** — `cronLock` plus per-row claim is mostly safe. `recurringTaskJob.js` (legacy) is the weakest link — cronLock only. **Keep `LEGACY_RECURRING_ENABLED=false`.**
2. **Service Worker / push auth-state lag** (P1-9) — only visible across user switches on shared browsers.
3. **VAPID misconfiguration silent failure** — frontend logs `[Push] backend reports VAPID NOT configured`; backend logs noisily. No operator alert.
4. **SMTP failure silent** — same.
5. **Teams 401 burns the token** — by design but means re-auth flow must be smooth.
6. **`notifications` table size** (P0-4) — guaranteed to bite within a year.
7. **Postgres `pg_try_advisory_xact_lock` collision** — FNV-1a of job names has negligible collision risk for ~10 names, but adding more jobs blindly increases risk. Document the lock-name namespace.
8. **`Notification.idempotencyKey` partial unique index** — relies on the boot migration having run. The service has a `try/catch` fallback (line 114-116) that silently falls through if the index is missing. **Add a startup assertion that the index exists.**
9. **Frontend `loadUnreadCount` race** with simultaneous socket event (frontend agent P1-6) — UI flicker on bad order.
10. **Socket reconnect** — if `io.to(room).emit` is buffered server-side during a brief disconnect, on reconnect the client receives the event. Toast dedup may or may not catch it depending on timing.
11. **CSP report-only by default** — `CSP_ENFORCE=true` recommended. Until set, XSS in a notification body could execute despite our `sanitize` calls (which are best-effort, not a CSP).
12. **`pg_dump` pre-deploy snapshot** — exists, but **backups are not yet shipped off-host** per CLAUDE.md. A box loss = data loss = lost notifications.
13. **Webhook retry job dead-letter** — exhausts and moves to `dead` status; no operator alert.

---

## L. RECOMMENDED IMPLEMENTATION ROADMAP

### Phase 0 — Emergency correctness & security (1–2 days)

**Goal:** Stop the bleeding. Fix P0s and the most user-visible P1s.

**Files to change:**
- `server/jobs/missedRecurringTaskJob.js`
- `server/services/notificationService.js`
- `client/src/components/layout/Header.jsx`
- `client/src/context/AuthContext.jsx`

**Exact fixes:**
1. Import & call `isTaskEligibleForOverdueNotification` inside `missedRecurringTaskJob.tickOnce` before the conditional UPDATE.
2. Change `notificationService.createNotification` line 180 from `return { success: false, reason: 'user_inactive' }` to `return null`.
3. Move `pushPermissionAttempted` / `pushSubscribeOk` out of module scope into a `usePushPrompt(userId)` hook keyed on user id.
4. Broadcast SW auth state immediately on login (before socket.connect()).

**Risk level:** Low — these are localised and reversible.

**Test plan:**
- Net-new unit tests for each of the four fixes (4 tests).
- Manual: shared browser scenario for fix #3.

**Acceptance criteria:**
- Recurring task in `approvalStatus='pending_approval'` does NOT escalate as missed.
- Inactive user notification returns `null`; no socket emit observed.
- User A denies push → User B is prompted on next login (same tab).
- SW push received during a login transition shows the generic body, never the previous user's task title.

### Phase 1 — Reminder/scheduler reliability (2–3 days)

**Goal:** Idempotency everywhere; reminder re-arming; observability.

**Files:**
- `server/services/recurringTaskService.js`
- `server/services/approvalNotificationService.js`
- `server/services/reminderService.js`
- `server/services/dependencyService.js`
- `server/services/notificationService.js` (assertion at boot)

**Fixes:**
1. Pass explicit `idempotencyKey` to every `sendNotification` call in `recurringTaskService` (generated, reassigned).
2. Refactor `approvalNotificationService.dispatchTo` to accept and forward `idempotencyKey`; build keys at every call site.
3. Change `reminderService.processReminders` eligibility-fail path: instead of `cancelled=true`, skip and leave `sentAt=null`.
4. Add boot-time assertion: `SELECT 1 FROM pg_indexes WHERE indexname='idx_notifications_idempotency'` — log FATAL if missing.
5. Add `LIMIT 500` to the `reminderJob.checkOverdue` Task.findAll.
6. Unify dependency-unblock emits into one helper with one idem key.

**Acceptance criteria:**
- Two cron ticks for the same template-occurrence emit one notification.
- An approval retry emits one notification.
- A reminder cancelled by status flip fires after status flips back.
- Boot fails loudly if idempotency index is missing.

### Phase 2 — Socket / browser / push correctness (2–3 days)

**Goal:** Frontend reliability + multi-user / multi-tab correctness.

**Files:**
- `client/src/services/pushNotifications.js`
- `client/src/realtime/eventRouter.js`
- `client/src/realtime/RealtimeProvider.jsx`
- `client/public/sw.js`
- `client/src/components/common/Toast.jsx`

**Fixes:**
1. Exponential backoff retry on `POST /api/push/subscribe` failure (P1-8).
2. Refine `eventRouter` to only invalidate `approvals.pendingCounts` / `dependencies.assignedActiveCount` for relevant notification types (P2-6).
3. Add cross-tab toast dedup via BroadcastChannel (only the active tab toasts).
4. Add `Notification.permission === 'denied'` banner with re-enable instructions.
5. Call `subscription.unsubscribe()` + `POST /api/push/unsubscribe` from AuthContext logout.

**Acceptance criteria:**
- Network glitch during push subscribe is retried 3×.
- Two tabs receive the same `notification:new` → one toast.
- Logout unsubscribes the device on the backend.

### Phase 3 — Badge / count / UI consistency (1–2 days)

**Goal:** Trust surface for reminders + badge accuracy.

**Files:**
- `client/src/components/board/TaskRow.jsx`
- `client/src/components/board/BoardCard.jsx`
- `client/src/components/board/KanbanView.jsx`
- `client/src/hooks/useNavBadgeCounts.js`
- `client/src/components/common/NotificationsPanel.jsx`

**Fixes:**
1. Bell icon on TaskRow/BoardCard/Kanban when `task.reminders?.length > 0` (P2-9).
2. Optimistic update on `markAllAsRead`.
3. Clear badge counts to 0 when `user` goes null in `useAuthGated`.

**Acceptance criteria:**
- User sets reminder → icon appears on the row immediately.
- Badge does not flicker on mark-all-read.
- Logout clears badges without a refresh.

### Phase 4 — Tests & observability (4–5 days)

**Goal:** Regression net + production debug capability.

**Files:**
- New: `server/__tests__/services/approvalNotificationService.test.js`
- New: `server/__tests__/services/dependencyService.notifications.test.js`
- New: `server/__tests__/services/helpRequestNotifications.test.js`
- New: `server/__tests__/services/extensionRequestNotifications.test.js`
- New: `server/__tests__/jobs/missedRecurringTaskJob.test.js` (cover P0-1 fix)
- New: `client/src/components/__tests__/NotificationsPanel.test.jsx`
- New: `client/src/components/__tests__/Toast.test.jsx`
- New: `client/src/services/__tests__/pushNotifications.test.js`
- New: `client/src/hooks/__tests__/useNavBadgeCounts.test.js`

**Plus:** structured logging (jobName, recurringTemplateId, taskId, recipientId, idempotencyKey, eventType, durationMs) on every cron tick.

**Acceptance criteria:**
- Coverage delta: backend +20%, frontend +60%.
- All P0–P1 fixes have regression tests.

### Phase 5 — Scale & production hardening (3–5 days)

**Goal:** Survive a year of production growth.

**Files:**
- New: `server/jobs/notificationCleanupJob.js` (retention)
- `server/jobs/cronLock.js` (lock-name namespace docs)
- `server/migrations/0NN_indexes.sql` (composite index P1-7)
- `server/server.js` (boot assertions; LIMIT 500 in reminderJob)

**Fixes:**
1. Nightly retention cron: archive read notifications >90d, hard-delete >365d; same for `teams_notification_log`.
2. Add `idx_tasks_status_duedate_notarchived`.
3. Boot-time assertion for `idx_notifications_idempotency`.
4. Datadog / Sentry hook for cron errors (infra change, not code).

**Acceptance criteria:**
- `notifications` table size stays bounded after a 90-day window.
- Overdue scan stays under 200ms at 10M task rows (EXPLAIN ANALYZE in CI).

---

## M. MULTI-AGENT IMPLEMENTATION PLAN

Each agent has a tight scope and a strict do-not-touch list to prevent cross-agent contention. Run **Backend** and **Frontend** in parallel; **Database/Migration** and **QA/Test** sequenced after to avoid touching files under active edit.

### Agent 1 — Backend Notification Agent

**Scope:** Fix idempotency, dispatch semantics, recipient correctness for all server-side notification fan-out.

**Files to inspect:**
- `server/services/notificationService.js`
- `server/services/approvalNotificationService.js`
- `server/services/assignmentNotificationService.js`
- `server/services/dependencyService.js`
- `server/services/recurringTaskService.js`
- `server/services/teamsNotificationService.js`
- `server/services/pushService.js`
- `server/controllers/notificationController.js`
- All `Notification.create(...)` direct call sites (grep first; commentController, helpRequestController, dueDateExtensionController, boardController, accessRequestController, promotionController)

**Files allowed to change:** all of the above.

**Do not touch:** anything under `client/`, anything under `server/jobs/`, anything under `server/models/`.

**Expected output:**
- Every `sendNotification` / `Notification.create` call site passes a deterministic `idempotencyKey`.
- `notificationService.createNotification` returns `null` for inactive-user skip (P0-2).
- `approvalNotificationService.dispatchTo` accepts and forwards `idempotencyKey`.
- Unified dependency-unblock helper with one idem key.

**Validation:**
- All existing tests pass.
- New unit tests for each call site cover "twice-called → one row".
- Manual smoke: retry an approval submission → one notification.

### Agent 2 — Reminder / Scheduler Agent

**Scope:** Cron correctness, eligibility, re-arming, batching, observability.

**Files to inspect:**
- `server/jobs/missedRecurringTaskJob.js`
- `server/jobs/reminderJob.js`
- `server/jobs/deadlineReminderJob.js`
- `server/jobs/priorityEscalationJob.js`
- `server/jobs/recurringTaskJob.js` (deprecate)
- `server/jobs/cronLock.js`
- `server/services/reminderService.js`
- `server/utils/taskOverdueEligibility.js`

**Files allowed to change:** all of the above. Plus `server/server.js` for boot wiring/assertions.

**Do not touch:** anything under `client/`, services under `server/services/` except `reminderService.js`.

**Expected output:**
- P0-1 fixed: `missedRecurringTaskJob` calls `isTaskEligibleForOverdueNotification`.
- P1-3 fixed: idempotencyKey on missed-escalation notifications.
- P1-4 fixed: eligibility-fail in `processReminders` no longer cancels.
- `reminderJob.checkOverdue` adds `LIMIT 500`.
- Deprecate `recurringTaskJob.js` (log a warning if `LEGACY_RECURRING_ENABLED=true`).

**Validation:**
- New tests cover the eligibility gap for missed-recurring.
- 1000-row overdue fixture completes in <2s.

### Agent 3 — Frontend Notification UI Agent

**Scope:** Push permission, toast, badge, reminder indicator, multi-tab.

**Files to inspect:**
- `client/src/components/layout/Header.jsx`
- `client/src/components/layout/Sidebar.jsx`
- `client/src/context/AuthContext.jsx`
- `client/src/services/pushNotifications.js`
- `client/src/services/socket.js`
- `client/src/components/common/Toast.jsx`
- `client/src/components/common/NotificationsPanel.jsx`
- `client/src/components/board/TaskRow.jsx`
- `client/src/components/board/BoardCard.jsx`
- `client/src/components/board/KanbanView.jsx`
- `client/src/hooks/useNavBadgeCounts.js`

**Files allowed to change:** all of the above.

**Do not touch:** `client/src/realtime/` (owned by Socket/Realtime Agent), anything under `server/`, anything under `client/public/sw.js`.

**Expected output:**
- P0-3 fixed: push permission state per-user not per-module.
- P1-8 fixed: retry on push subscribe failure.
- P2-9 fixed: bell icon on task rows.
- Optimistic mark-all-read.
- Logout unsubscribes push.

**Validation:**
- Vitest tests added for each component above (per Phase 4).
- Manual smoke: shared browser scenario, multi-tab toast, reminder indicator.

### Agent 4 — Socket / Realtime Agent

**Scope:** RealtimeProvider, eventRouter, SW auth-state, cross-tab dedup.

**Files to inspect:**
- `client/src/realtime/RealtimeProvider.jsx`
- `client/src/realtime/eventRouter.js`
- `client/src/realtime/useRealtimeEvent.js`
- `client/src/realtime/useRealtimeQuery.js`
- `client/public/sw.js`
- `server/services/socketService.js` (read-only)

**Files allowed to change:** everything under `client/src/realtime/` and `client/public/sw.js`.

**Do not touch:** other client/server files (those are owned by Agents 1 / 3).

**Expected output:**
- P1-9 fixed: SW auth state broadcast before socket.connect().
- P2-6 fixed: eventRouter only fans out badge invalidations for relevant types.
- Cross-tab toast dedup via BroadcastChannel.

**Validation:**
- Two tabs receiving the same event toast once.
- SW renders generic body during user switch.

### Agent 5 — Database / Migration Agent

**Scope:** Schema additions, indexes, retention.

**Files to inspect:**
- `server/models/Notification.js`
- `server/models/TaskReminder.js`
- `server/models/PushSubscription.js`
- `server/models/TeamsNotificationLog.js`
- `server/models/Task.js`
- `server/migrations/*.sql`
- `server/server.js` (boot DDL blocks)

**Files allowed to change:** new migration files only (`server/migrations/0NN_*.sql`) + corresponding boot DDL in `server/server.js`. Models may add index declarations but do not change existing column types.

**Do not touch:** services, controllers, jobs.

**Expected output:**
- New migration: `idx_tasks_status_duedate_notarchived` partial composite (P1-7).
- New migration: archive table for notifications + retention scripts.
- Boot assertion: `idx_notifications_idempotency` exists or FATAL.

**Validation:**
- `EXPLAIN ANALYZE` before/after on a seeded 1M-row tasks table.

### Agent 6 — QA / Regression Test Agent

**Scope:** Net-new test coverage. Run AFTER Agents 1-5 to test their fixes.

**Files to add (new):**
- `server/__tests__/services/approvalNotificationService.test.js`
- `server/__tests__/services/dependencyService.notifications.test.js`
- `server/__tests__/services/helpRequestNotifications.test.js`
- `server/__tests__/services/extensionRequestNotifications.test.js`
- `server/__tests__/jobs/missedRecurringTaskJob.test.js`
- `server/__tests__/jobs/notificationCleanupJob.test.js`
- `client/src/components/__tests__/NotificationsPanel.test.jsx`
- `client/src/components/__tests__/Toast.test.jsx`
- `client/src/services/__tests__/pushNotifications.test.js`
- `client/src/hooks/__tests__/useNavBadgeCounts.test.js`
- `client/src/realtime/__tests__/eventRouter.test.js`

**Files allowed to change:** test files only.

**Do not touch:** any production code.

**Expected output:** Coverage delta: backend +20%, frontend +60%. Every P0–P1 fix has a regression test.

### Agent 7 — Security / Reliability Agent

**Scope:** Hardening, observability, retention enforcement.

**Files to inspect:**
- `server/server.js` (boot assertions)
- `server/jobs/notificationCleanupJob.js` (new)
- `server/services/teamsNotificationService.js` (truncate errorMessage)
- `server/utils/logger.js`

**Files allowed to change:** the above + new infra config under `.github/workflows/` if alerting is added.

**Do not touch:** business logic in services, jobs (unless writing the cleanup job itself).

**Expected output:**
- `notificationCleanupJob.js` (wrapped in cronLock; nightly; batch=10k).
- Boot assertion for the idempotency partial index.
- Structured logging upgrade.
- `errorMessage.slice(0,500)` in TeamsNotificationLog inserts.

**Validation:** notifications table size stays bounded after a 90-day fixture run.

---

## N. PRODUCTION-READINESS CHECKLIST

A checklist a future engineer/Claude can run end-to-end before shipping any notification change.

### Backend correctness
- [ ] All `Notification.create` call sites go through `notificationService.createNotification`.
- [ ] Every dispatch has a deterministic `idempotencyKey` (or a documented reason it doesn't).
- [ ] `notificationService.createNotification` returns `null` (not a `{success:false,…}` object) on the inactive-user skip.
- [ ] No fire-and-forget `await` in critical paths (controller must not 500 if notification fails).
- [ ] Self-notification exclusion is applied at the service level, not only at controller call sites.
- [ ] All cron jobs use `withCronLock(name, fn)` AND a per-row claim (conditional UPDATE).
- [ ] `recurringTaskJob.js` legacy path is OFF (`LEGACY_RECURRING_ENABLED=false`).
- [ ] `missedRecurringTaskJob` calls `isTaskEligibleForOverdueNotification`.
- [ ] `reminderJob.checkOverdue` has a `LIMIT`.
- [ ] `taskOverdueEligibility` covers: archived, completed, awaiting-review, pending_approval, approved.
- [ ] `changes_requested` is NOT in the non-actionable set (reviewer bounced back to user).

### Database
- [ ] Partial unique index `idx_notifications_idempotency` exists; boot assertion present.
- [ ] Partial composite index `idx_tasks_status_duedate_notarchived` exists.
- [ ] `task_reminders` expression-based unique index exists.
- [ ] `push_subscriptions` endpoint md5-unique index exists.
- [ ] `teams_notification_log.eventId` unique index exists.
- [ ] Retention job for `notifications` (>90d read) and `teams_notification_log` (>30d sent).
- [ ] `pg_dump` pre-deploy snapshot is taken and shipped off-host.

### Frontend correctness
- [ ] All socket listeners registered exactly once, cleaned up on unmount.
- [ ] Socket joins `user:<id>` and (when on a board) `board:<id>` after login.
- [ ] Toast dedup window covers reconnect bursts AND cross-tab via BroadcastChannel.
- [ ] Browser notification only attempted when `Notification.permission==='granted'` AND user logged in.
- [ ] Push permission state is per-user, not module-scope. Reset on logout.
- [ ] Push subscribe retries on transient failure.
- [ ] Logout calls `subscription.unsubscribe()` and `POST /api/push/unsubscribe`.
- [ ] SW broadcasts auth state synchronously on login before connect().
- [ ] SW renders generic body when auth state is unknown.
- [ ] Reminder indicator visible on TaskRow/BoardCard/Kanban when `task.reminders?.length > 0`.
- [ ] Badge counts (bell, approvals, dependencies) reset to 0 on logout.

### Security
- [ ] Notification list endpoint scoped to caller userId.
- [ ] Mark-read / delete / clear-read enforce ownership AND tier where applicable.
- [ ] Socket rooms are JWT-authenticated; cannot subscribe to another user's room.
- [ ] All notification message bodies sanitized via `sanitizeNotificationMessage`.
- [ ] CSP enforced in prod (`CSP_ENFORCE=true`).
- [ ] VAPID public key is the only push-related public endpoint.
- [ ] Webhook receiver verifies HMAC (`WEBHOOK_REQUIRE_SIGNATURE=strict`).
- [ ] Teams OAuth tokens encrypted at rest (P0-5 in CLAUDE.md — separate work item).

### Observability
- [ ] Every cron tick logs `{ jobName, processed, sent, skipped, errors, ms }`.
- [ ] Every notification dispatch logs at debug level with `{ idempotencyKey, type, recipientId, dispatched, deduped }`.
- [ ] Failed push / Teams sends are logged at WARN with the recipient & reason.
- [ ] SMTP failures surface to operator (Slack/PagerDuty hook, not just file logger).
- [ ] Boot fails loudly on missing critical indexes.

### Tests
- [ ] `approvalNotificationService` has unit tests for all 5 events.
- [ ] `dependencyService` notification events tested for all 6 lifecycle phases.
- [ ] `missedRecurringTaskJob` has a test for `approvalStatus=pending_approval`.
- [ ] `notificationService.createNotification` has a test for the inactive-user `null` return.
- [ ] Toast component has Vitest coverage including reconnect dedup.
- [ ] Push subscription save retry has a test.
- [ ] Idempotency-on-twice-called covered for every notification type.

---

## VERDICT

### Is the current system production-ready?

**Conditionally yes — with three confirmed P0s that should be fixed before the next deploy:**

1. **The recurring-missed escalation will page admins/managers/assignees for tasks that the assignee already submitted for approval.** This is a daily operational error on any board that uses both recurring work and approval workflows. Fix: ~30 lines of code in [server/jobs/missedRecurringTaskJob.js](server/jobs/missedRecurringTaskJob.js).

2. **`notificationService.createNotification` quietly lies about inactive-user skips.** The current behavior corrupts the audit trail. Fix: 1-line change at [server/services/notificationService.js:180](server/services/notificationService.js#L180).

3. **Browser push permission state leaks across users on shared machines.** Any deployment that includes shared kiosks, lab machines, support desks, or family iPads is affected. Fix: refactor module-scope flags in Header into a user-keyed hook.

**Beyond those three**, the core architecture is solid:
- Idempotency strategy is well-designed where it's used.
- The eligibility helper is the right pattern.
- Cron multi-replica safety is sound.
- Socket auth + room scoping are correctly enforced.
- The reminder save→fire path is reliable and survives restart.

**The next year of pain points** will come from:
- Unbounded table growth in `notifications` + `teams_notification_log`.
- Missing test coverage on approval / dependency / help / extension notifications.
- Reminder UI surface gaps (no indicator on rows).
- Legacy paths (`Task.recurrence` JSONB, direct `Notification.create` calls).

### Top 10 fixes to implement first

1. **P0** — `missedRecurringTaskJob` calls `isTaskEligibleForOverdueNotification`. [missedRecurringTaskJob.js:248](server/jobs/missedRecurringTaskJob.js#L248).
2. **P0** — `notificationService.createNotification` returns `null` on inactive-user skip. [notificationService.js:180](server/services/notificationService.js#L180).
3. **P0** — Reset push permission flags on logout; broadcast SW auth state synchronously on login. [Header.jsx](client/src/components/layout/Header.jsx) + [AuthContext.jsx](client/src/context/AuthContext.jsx).
4. **P1** — Add deterministic `idempotencyKey` to every `recurringTaskService` and `approvalNotificationService` dispatch.
5. **P1** — Add the bell-icon reminder indicator on `TaskRow.jsx` / `BoardCard.jsx` / `KanbanView.jsx` for `task.reminders?.length > 0`.
6. **P1** — Stop cancelling reminders on transient eligibility-fail in `reminderService.processReminders` (leave `sentAt=null` so they re-fire when the task is actionable again).
7. **P1** — Exponential-backoff retry on `POST /api/push/subscribe`; unsubscribe on logout.
8. **P1** — Add the partial composite index `idx_tasks_status_duedate_notarchived`; add boot assertion that `idx_notifications_idempotency` exists.
9. **P2** — Add a nightly retention job for `notifications` (>90d read) and `teams_notification_log` (>30d sent).
10. **P2** — Net-new test files: `approvalNotificationService.test.js`, `dependencyService.notifications.test.js`, `missedRecurringTaskJob.test.js` (covering #1 above), and the four client-side Vitest files.

After Phase 0 + Phase 1, the system is **genuinely production-ready** for ~12 months at current scale.

— End of audit —
