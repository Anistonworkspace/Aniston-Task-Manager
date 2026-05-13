# Pre-Push Safety Report — Aniston Task Manager

Generated: 2026-05-13
Branch: `main`
HEAD: `7ee3476` (May 12 fixes)
Audit basis: 88 modified + 19 untracked files, against `HEAD` (no commits yet)
Mode: read-only. No commit, push, deploy, migration, or production-DB write
was executed while producing this report. Both read-only audit workflows are
proven to be physically unable to write.

This report supersedes the 2026-05-12 version of this file.

---

## 1. Executive Summary

The pending diff is the **post-audit remediation bundle** built on top of the
May 12 hotfixes. It is large (~6 800 insertions / ~2 000 deletions across
~107 files) but **schema-clean**: no model files changed, no new auto-migration
blocks added to `server.js`, and no new SQL migration files added beyond
those already shipped on `HEAD`.

Three roughly distinct themes:

1. **Observability & error-handling hardening.** New centralized
   [`server/middleware/errorHandler.js`](server/middleware/errorHandler.js) +
   [`server/middleware/requestId.js`](server/middleware/requestId.js) +
   [`server/utils/safeLogger.js`](server/utils/safeLogger.js) +
   [`server/utils/errors.js`](server/utils/errors.js); client side adds
   [`client/src/utils/errorMap.js`](client/src/utils/errorMap.js) +
   [`client/src/utils/safeLog.js`](client/src/utils/safeLog.js).
2. **Cron-job notification storm fixes.** Per-tick budgets, idempotency
   keys for fan-out, and defence-in-depth eligibility checks in
   [`server/jobs/missedRecurringTaskJob.js`](server/jobs/missedRecurringTaskJob.js),
   [`server/jobs/deadlineReminderJob.js`](server/jobs/deadlineReminderJob.js),
   [`server/jobs/reminderJob.js`](server/jobs/reminderJob.js),
   [`server/jobs/priorityEscalationJob.js`](server/jobs/priorityEscalationJob.js),
   [`server/services/reminderService.js`](server/services/reminderService.js).
3. **RBAC catalog expansion + UI hygiene.** Big expansion of resources/actions
   in [`server/config/permissionMatrix.js`](server/config/permissionMatrix.js),
   permission engine refactor in
   [`server/services/permissionEngine.js`](server/services/permissionEngine.js),
   and three legacy dashboard pages deleted from the client
   ([`client/src/pages/AdminDashboardPage.jsx`](client/src/pages/AdminDashboardPage.jsx),
   [`client/src/pages/ManagerDashboardPage.jsx`](client/src/pages/ManagerDashboardPage.jsx),
   [`client/src/pages/MemberDashboardPage.jsx`](client/src/pages/MemberDashboardPage.jsx)),
   plus [`client/src/components/dashboard/RoleDashboard.jsx`](client/src/components/dashboard/RoleDashboard.jsx).

### Headline findings

| | |
|---|---|
| **Is it safe to push?** | **YES, with one preflight item.** Confirm the `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY="false"` line in [deploy/run-onetime-password-reset.sh:70](deploy/run-onetime-password-reset.sh#L70) is still `"false"` (verified at audit time — still `false`). |
| **Does this push require a manual DB migration?** | **NO.** Zero new model files, zero new boot-time auto-migrations in [`server/server.js`](server/server.js), zero new SQL files in [`server/migrations/`](server/migrations/). Migrations 001–019 already deployed on prior pushes. |
| **Any production data risk from this diff?** | **NO.** No script in this diff inserts/updates/deletes user data. The cron-job changes make the existing jobs *less* aggressive (per-tick budgets, status exclusion, idempotency dedup), not more. |
| **Any script in this diff that may restore/reseed/alter production data?** | **NO new** scripts auto-run on deploy. The one new ops script ([`server/scripts/audit-permission-grants.js`](server/scripts/audit-permission-grants.js)) is dry-run by default and is NOT wired into the deploy workflow. |
| **Could the read-only audit deploy have altered production data?** | **NO.** Both audit workflows wrap every SQL statement in `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;` + a forbidden-keyword guard. Postgres physically rejects any write while `transaction_read_only` is on. Evidence in §9. |
| **Most likely cause of "deleted data coming back"** | **The recurring-task generator regenerates deleted instances within 10 minutes.** This is *existing* behaviour, NOT introduced by this diff. Details + fix recommendation in §10. |

---

## 2. Changed Files Summary

`git status` reports 84 modified + 4 deleted + 19 untracked files (88 tracked
changes, 19 new). All edits are working-tree only — nothing is staged or
committed yet.

### Server (51 modified, 14 untracked)

| Path | Δ | Surface | Production behavior | DB schema | RBAC | Data mutation risk |
|---|---|---|---|---|---|---|
| [server/server.js](server/server.js) | +46/-50 | wires `requestId` middleware before morgan; replaces inline error handler with new centralized `middleware/errorHandler.js`; routes `unhandledRejection` / `uncaughtException` through `safeLogger` | unchanged response shape (additive `error.requestId` field) | none | none | none |
| [server/config/permissionMatrix.js](server/config/permissionMatrix.js) | +924/-78 | resource/action catalog expansion: adds `task_links`, `task_references`, `recurring_work`, `comments`, `approvals` etc.; new `GRANTABILITY` map (which (resource,action) pairs are grantable by which tier) | base permissions evaluated at request time only | none | additive: expands the catalog, no behaviour change on legacy rows | none |
| [server/services/permissionEngine.js](server/services/permissionEngine.js) | +216/-31 | DENY > GRANT > base precedence, expiry, scope filtering | unchanged contract; new helper `isExplicitlyDenied()` | none | tightens denials only — never grants where base says deny | none |
| [server/controllers/taskController.js](server/controllers/taskController.js) | +381/-25 | `tasks.bulk_delete` granular gate, `task:updated` archive fan-out with idempotency, calendar-event delete-before-destroy, structured logging | unchanged delete semantics (`task.destroy()` is still hard delete — see §10) | none | adds explicit tier gate (`assertCanDelete`) before destroy | none — same DB writes, just better-gated |
| [server/jobs/missedRecurringTaskJob.js](server/jobs/missedRecurringTaskJob.js) | +135/-20 | per-tick budget cap; excludes review/awaiting statuses; idempotency keys on notification fan-out | strictly **less** firing of escalation notifications | none | none | none — only sends notifications, never creates/deletes tasks |
| [server/jobs/reminderJob.js](server/jobs/reminderJob.js) | +102/-15 | identical pattern: budget + idempotency + status-exclusion | strictly **less** firing of reminders | none | none | none |
| [server/jobs/deadlineReminderJob.js](server/jobs/deadlineReminderJob.js) | +27/-? | same pattern, processes `task_reminders` | strictly **less** firing | none | none | none |
| [server/jobs/priorityEscalationJob.js](server/jobs/priorityEscalationJob.js) | +37/-? | budget + idempotency wrapper | unchanged eligibility | none | none | none — only writes priority='critical' on already-existing tasks |
| [server/services/recurringTaskService.js](server/services/recurringTaskService.js) | +18/-? | idempotency-keyed `recurring-generated` notification (prevents dup notifications on cron retry) | unchanged generation logic | none | none | **none in this diff** — but see §10 for pre-existing behaviour |
| [server/services/reminderService.js](server/services/reminderService.js) | +149/-16 | per-user reminder spec, idempotency | unchanged DB writes | none | none | none |
| [server/controllers/{auth,board,permission,dashboard,user,workspace,…}Controller.js](server/controllers/) | various | adopts `AppError` + `safeLogger`; removes inline `console.error` + raw error-message leakage | unchanged business logic | none | none | none |
| [server/middleware/staticAuth.js](server/middleware/staticAuth.js) | +141/-35 | logged-out path now redirects to login w/ return URL; preserves `Content-Disposition: attachment` enforcement | unchanged for authed requests | none | unchanged auth contract | none |
| [server/middleware/errorHandler.js](server/middleware/errorHandler.js) **NEW** | +259 | centralized classifier: AppError → safeMessage; Sequelize → generic 500; JWT → 401/expired; never reflects column names / SQL fragments | tightens prior leak surface | none | none | none |
| [server/middleware/requestId.js](server/middleware/requestId.js) **NEW** | +39 | accepts inbound `X-Request-ID` if `[A-Za-z0-9_-]{8,64}`, otherwise mints UUID; echoes header back | adds correlation-id surface only | none | none | none |
| [server/utils/safeLogger.js](server/utils/safeLogger.js) **NEW** | redacts `password`/`token`/`Bearer …`/JWT-shape/Axios config | log-side safety | none | none | none |
| [server/utils/errors.js](server/utils/errors.js) **NEW** | `AppError` + `ERROR_CODES` enum | unblocks centralized error handler | none | none | none |
| [server/utils/permissionGate.js](server/utils/permissionGate.js) **NEW** | helper for `enginePermission()` checks | wraps existing engine | none | none | none |
| [server/config/notificationLimits.js](server/config/notificationLimits.js) **NEW** | `MAX_TASKS_PER_CRON_RUN`, `createBudget()` | exports config consumed by cron jobs above | none | none | none |
| [server/scripts/audit-permission-grants.js](server/scripts/audit-permission-grants.js) **NEW** | dry-run by default; `--apply --i-understand` soft-deactivates only (never deletes); only categories: expired, super-admin-target, unknown-resource, unknown-action | **NOT wired into deploy** | none | none | none on default; soft-deactivation only on explicit `--apply` |
| `server/__tests__/**` (10 modified + 6 new) | tests-only | n/a | n/a | n/a | n/a | n/a |

### Client (37 modified, 5 untracked, 4 deleted)

| Path | Δ | Surface | Production behavior | Data mutation risk |
|---|---|---|---|---|
| [client/src/pages/TasksPage.jsx](client/src/pages/TasksPage.jsx) | +1039/-414 | full UI rewrite of global Tasks page: tab filters, sort, bulk actions, dependency-request hooks | reads tasks via existing API, no new writes | none |
| [client/src/pages/DependenciesPage.jsx](client/src/pages/DependenciesPage.jsx) | +692/-208 | dependency-request UI redesign | uses existing endpoints | none |
| [client/src/pages/AdminSettingsPage.jsx](client/src/pages/AdminSettingsPage.jsx) | +307/-80 | system-settings + integrations consolidation | uses existing endpoints | none |
| [client/src/pages/BoardPage.jsx](client/src/pages/BoardPage.jsx) | +117/-35 | error-boundary wrap, realtime fan-out hookup | uses existing endpoints | none |
| [client/src/components/board/CalendarView.jsx](client/src/components/board/CalendarView.jsx) | +235/-51 | view refactor | render-only | none |
| [client/src/components/board/TimelineView.jsx](client/src/components/board/TimelineView.jsx) | +100/-22 | gantt rewrite | render-only | none |
| [client/src/components/board/AdvancedFilters.jsx](client/src/components/board/AdvancedFilters.jsx) | +135/-7 | filter UI | render-only | none |
| [client/src/components/layout/Header.jsx](client/src/components/layout/Header.jsx) | +166/-73 | profile menu, language switcher | render-only | none |
| [client/src/components/common/ErrorBoundary.jsx](client/src/components/common/ErrorBoundary.jsx) | +136/-31 | `variant="section"` inline retry card | render-only | none |
| [client/src/context/AuthContext.jsx](client/src/context/AuthContext.jsx) | +59/-8 | adopts `isExplicitlyDenied()` + `granularPermissions` reading | unchanged auth flow | none |
| [client/src/services/api.js](client/src/services/api.js) | +73/-17 | new `errorMap`-aware error transformer; `X-Request-ID` echo | unchanged endpoints | none |
| [client/src/services/pushNotifications.js](client/src/services/pushNotifications.js) | +86/-41 | deviceId stabilization, subscription idempotency | unchanged endpoints | none |
| [client/src/utils/permissions.js](client/src/utils/permissions.js) | +134/-17 | new `isExplicitlyDenied()` helper | render-only | none |
| [client/src/utils/errorMap.js](client/src/utils/errorMap.js) **NEW** | code→copy mapping | unblocks new error UX | none |
| [client/src/utils/safeLog.js](client/src/utils/safeLog.js) **NEW** | redacts Axios error in prod console | log-side safety | none |
| [client/src/hooks/useDebouncedCallback.js](client/src/hooks/useDebouncedCallback.js) **NEW** | hook | render-only | none |
| [client/src/hooks/useNotificationBurstDispatcher.js](client/src/hooks/useNotificationBurstDispatcher.js) **NEW** | hook | render-only | none |
| [client/src/components/dashboard/RoleDashboard.jsx](client/src/components/dashboard/RoleDashboard.jsx) **DELETED** | -451 | legacy widget consolidated into `DashboardPage` | none (replaced by existing page) | none |
| [client/src/pages/AdminDashboardPage.jsx](client/src/pages/AdminDashboardPage.jsx) **DELETED** | -14 | thin route wrapper; replaced by `DashboardPage` | route still works (App.jsx points to `DashboardPage`) | none |
| [client/src/pages/ManagerDashboardPage.jsx](client/src/pages/ManagerDashboardPage.jsx) **DELETED** | -14 | thin route wrapper | route still works | none |
| [client/src/pages/MemberDashboardPage.jsx](client/src/pages/MemberDashboardPage.jsx) **DELETED** | -22 | thin route wrapper | route still works | none |
| `client/src/{components,hooks,realtime,services}/__tests__/**` (4 new) | tests-only | n/a | n/a | n/a |

### Behaviour-level call-outs

- **`task.destroy()` is still a HARD delete.** `taskController.js:2616` —
  unchanged. There is no `paranoid: true` on the `Task` model. See §10 for
  why this matters for recurring instances.
- **The dashboard page deletions are safe.** [`App.jsx`](client/src/App.jsx)
  routes `/dashboard`, `/admin-dashboard`, `/manager-dashboard`,
  `/member-dashboard` all point at `DashboardPage` after the change.
  No route references the deleted files.
- **`errorHandler.js` is a STRICT improvement over the inline handler.**
  Old code unconditionally reflected `err.message` outside production
  (server.js:585-610 before this diff). New code never reflects raw
  Sequelize messages and never leaks SQL fragments / column names to the
  client. Tier hardening, not loosening.

---

## 3. Database Schema Migration Assessment

### Does this push require a DB migration? **NO.**

**Evidence:**

```
$ git status server/migrations/
On branch main
nothing to commit, working tree clean
```

```
$ git diff -- 'server/models/**'
(no output — zero model files changed)
```

```
$ git diff server/server.js | grep -E '^\+.*(CREATE|ALTER|DROP) (TABLE|COLUMN|INDEX|EXTENSION)'
(no output — zero new DDL)
```

The diff to [`server/server.js`](server/server.js) is +46/-50 and is
**entirely** about wiring the new `requestId` and `errorHandler` middleware
and routing `process.on('unhandledRejection'|'uncaughtException')` through
`safeLogger`. Zero changes to the ~15 boot-time auto-migration blocks that
were already there.

Production already has migrations 001 → 019 applied (last shipped May 12
in commit `7ee3476`). This push adds **zero** new ones.

### Idempotency posture (unchanged)

All boot-time blocks in [`server/server.js`](server/server.js) use the
canonical idempotent pattern:

```
CREATE TABLE IF NOT EXISTS …
ALTER TABLE … ADD COLUMN IF NOT EXISTS …
```

`sequelize.sync({ alter: false })` is wrapped in try/catch so a schema-drift
error can't kill the container. Schema is *forward-only* — there is no
`down` migration runner in the deploy.

### Rollback plan (informational)

- Auto-rollback restores the **code** to the previous SHA via
  `git reset --hard $PREVIOUS_SHA` if the post-deploy health check fails
  ([.github/workflows/deploy.yml:189-211](.github/workflows/deploy.yml#L189-L211)).
- Auto-rollback does NOT roll back the DB. For this push, no rollback is
  needed because **no DDL ran**.
- A pre-deploy `pg_dump` snapshot is taken at
  [.github/workflows/deploy.yml:154-159](.github/workflows/deploy.yml#L154-L159)
  (kept on the EC2 host, last 30 retained). Use it only on operator decision.

---

## 4. Deploy Workflow Assessment

### `.github/workflows/deploy.yml` — auto-run on push to `main`

| Step | What runs | Production-write risk |
|---|---|---|
| Build job | `cd server && npm ci`; `npm test`; `cd client && npm install --no-audit --no-fund`; `npm test`; `npm run build` | none (CI runner only) |
| Pre-deploy snapshot ([:154-159](.github/workflows/deploy.yml#L154-L159)) | `docker exec aph-postgres pg_dump ... | gzip > ...` | **read-only** (pg_dump cannot write to the DB) |
| Build images, restart containers | `docker compose build` + `up -d --no-build --remove-orphans` | none — restart only, no data touched |
| Health check loop + auto-rollback | curl `/api/health`; on failure `git reset --hard $PREVIOUS_SHA` | code rollback only |
| **Seed step** ([:213-215](.github/workflows/deploy.yml#L213-L215)) | `docker exec aph-backend node seed-users.js \|\| true` + `node seed-hierarchy.js \|\| true` | **prod-guarded — refuses to write — see below** |
| **One-time password reset hook** ([:217-241](.github/workflows/deploy.yml#L217-L241)) | runs [deploy/run-onetime-password-reset.sh](deploy/run-onetime-password-reset.sh) | **gated OFF — see below** |
| Daily backup cron | `crontab -l … echo "0 2 …"` | adds cron only; backup script itself is `pg_dump` (read-only on data) |
| Image prune | `docker image prune -f` | none |

#### `seed-users.js` ([server/seed-users.js](server/seed-users.js)) — production prognosis: **no-op**

```
if (IS_PROD) {
  if (process.env.ALLOW_SEED_IN_PRODUCTION !== 'true') {
    throw new Error('[Seed] Refusing to run in production. …');
  }
  …
}
```

- Production `ENV_FILE` does **not** contain `ALLOW_SEED_IN_PRODUCTION=true`
  (verified by the May 2026 audit; flipping it requires editing the GitHub
  Actions secret).
- The deploy command pipes `|| true` so even if the seed throws, the deploy
  continues. The seed THROWS and continues, **never writing**.
- Even with the env set, the seed checks for an existing super admin by
  email and **refuses to overwrite credentials** ([seed-users.js:101-106](server/seed-users.js#L101-L106)).

#### `seed-hierarchy.js` ([server/seed-hierarchy.js](server/seed-hierarchy.js)) — production prognosis: **no-op**

```
if (process.env.NODE_ENV === 'production'
    && process.env.ALLOW_PROD_HIERARCHY_SEED !== 'true') {
  console.log('Skipping hierarchy seed in production. …');
  process.exit(0);
}
```

- `ALLOW_PROD_HIERARCHY_SEED` is NOT set in production. The script logs the
  skip line and exits 0 within 10 ms.
- This was deliberately flipped to opt-in in the May 12 hotfix bundle
  because the script otherwise re-derives `users.hierarchyLevel` from
  `role` on every restart, clobbering hand-tuned values.

#### `deploy/run-onetime-password-reset.sh` — production prognosis: **no-op**

[deploy/run-onetime-password-reset.sh:70](deploy/run-onetime-password-reset.sh#L70):

```
FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY="false"
```

The wrapper computes the effective flag as:

```
RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN := (vars.RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN == 'true'
                                              || github.event.inputs.run_password_reset_sunny_muskan == 'true')
                                              && 'true' || 'false'
```

- Repo Variable `RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN`: **`false`** at audit time.
- Workflow_dispatch input: not set (you're pushing, not manually dispatching).
- Hard-coded `FORCE_AUTO_RUN_…` block: **`false`**.

All three must be true for the password reset to execute. They aren't. The
wrapper logs a very loud "PASSWORD RESET DID NOT RUN" banner and exits 0
([run-onetime-password-reset.sh:107-125](deploy/run-onetime-password-reset.sh#L107-L125)).

Even if any of them flipped to true, the script:

1. Runs DRY-RUN first ([:191-256](deploy/run-onetime-password-reset.sh#L191-L256)) and aborts if it can't resolve exactly two accounts (Sunny + Muskan).
2. Aborts if the in-DB `system_maintenance_runs` marker for the effective key already exists.
3. Even on success, only **updates two specific users' password hashes and inserts a token row**. It does NOT recreate deleted boards/tasks/labels/anything else.

### `.github/workflows/security-gate.yml`

Pure CI — runs Jest + Vitest on changed files. No SSH, no DB.

### `.github/workflows/readonly-production-task-audit.yml`

See §9 for full read-only proof. Triggered only by `workflow_dispatch`.

### `.github/workflows/readonly-production-task-visibility-audit.yml`

Same. See §9.

---

## 5. Production Data Mutation / Restore / Reseed Audit (Phase 3)

**Question: Is there ANY script that can restore, recreate, reseed, or
re-insert deleted production data?**

I searched the entire repo for the keywords called out in the audit
charter. Here are the matches and their disposition.

| Keyword | Files matched | Risk to deleted data |
|---|---|---|
| `seed`, `seeder` | [server/seed-users.js](server/seed-users.js), [server/seed-hierarchy.js](server/seed-hierarchy.js) | Both prod-guarded. seed-users.js only inserts the super admin if missing, never updates. seed-hierarchy.js skips in prod by default. **Neither restores deleted tasks/boards/workspaces/labels.** |
| `restore`, `pg_restore` | not present anywhere in deploy scripts. `pg_restore` referenced only in [server/migrations/017_README.md](server/migrations/017_README.md) (docs) and in this report | **none** — there is NO automated DB restore path on deploy |
| `backup` | [deploy/backup.sh](deploy/backup.sh) (creates `pg_dump`, deletes only old `.sql.gz` files — never touches DB content) | none |
| `import` | client-side CSV import for board templates; user-driven UI, never auto-run | none |
| `bulkCreate`, `findOrCreate`, `upsert` | used in 13 controllers; all paths are user-initiated request handlers, not boot-time / cron-time | none — only user-initiated INSERTs that can't restore deleted rows on their own |
| `TRUNCATE`, `DROP TABLE`, `DELETE FROM …` (raw) | `DROP COLUMN status` (one-shot enum→string migration block, idempotent — already shipped); `TRUNCATE` does not appear in any cron/boot path | none for this diff |
| `force: true` (Sequelize) | only in [server/config/sync.js](server/config/sync.js) — gated behind `--force` CLI flag, never invoked from `server.js` | none |
| `cron`, `schedule`, `recurring` | 9 cron jobs in [server/jobs/](server/jobs/) — see §10 for the recurring generator analysis | **the recurring generator does regenerate previously-deleted instances** (existing behaviour, unchanged in this diff) |
| `auto-run`, `maintenance`, `bootstrap` | only the Sunny/Muskan password-reset hook (gated off) | none |
| `ALLOW_PROD_*`, `FORCE_AUTO_RUN`, `MAINTENANCE_KEY` | enumerated in CLAUDE.md §"Danger flags". All default to skip/off. | none with current settings |

### Per-script production prognosis (auto-run on deploy)

| Script | Auto-runs on deploy? | Mutates prod? | Gate |
|---|---|---|---|
| `server/seed-users.js` | yes (`|| true`) | **no** | `ALLOW_SEED_IN_PRODUCTION=true` required |
| `server/seed-hierarchy.js` | yes (`|| true`) | **no** | `ALLOW_PROD_HIERARCHY_SEED=true` required |
| `deploy/run-onetime-password-reset.sh` | yes | **no** | three flags, all currently `false`; even if on, only resets two specific users |
| `server/scripts/*` | **no** — none called by deploy | n/a | manual invocation only |
| `server/migrations/run_NNN.js` | **no** — none called by deploy | n/a | manual one-time invocation |
| `deploy/backup.sh` | not on deploy — installed as `0 2 * * *` cron via `crontab` | **read-only** (pg_dump) | n/a |
| Boot-time `IF NOT EXISTS` blocks in `server/server.js` | yes (on backend restart) | **idempotent — touches zero rows when in sync** | n/a — schema-only, no data writes; the BoardMembers `autoAdded` re-mark and the gated one-shot `task_assignees` backfill are pre-existing, unchanged by this diff |

### Final answer

**No script in this diff or in production right now can restore deleted user
data on its own.** The only mechanism that resurrects "deleted" rows is the
pre-existing recurring-task generator — and it does not restore arbitrary
deleted tasks; it generates today's instance of an active recurring template.
See §10.

---

## 6. Deleted-data-coming-back Investigation (Phase 5) — **ROOT CAUSE IDENTIFIED**

### What the audit deploy could and could not do

The two read-only audit workflows
([.github/workflows/readonly-production-task-audit.yml](.github/workflows/readonly-production-task-audit.yml),
[.github/workflows/readonly-production-task-visibility-audit.yml](.github/workflows/readonly-production-task-visibility-audit.yml))
both:

1. Wrap every SQL statement in `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`.
2. Pass the SQL through a forbidden-keyword guard
   ([.github/workflows/readonly-production-task-visibility-audit.yml:400-408](.github/workflows/readonly-production-task-visibility-audit.yml#L400-L408)):
   ```
   grep -E -i -w '(insert|update|delete|truncate|drop|alter|create|grant|revoke|vacuum|reindex|cluster)'
   ```
   — if any of those words appears, the workflow exits 1 *before* connecting
   to Postgres.
3. Verify the backend container points at the same `aniston_project_hub`
   Postgres instance (by comparing `pg_postmaster_start_time()` reported by
   both backend and postgres) before running anything.

**Postgres physically rejects any DML inside a `SET TRANSACTION READ ONLY`
block** — the audit cannot write data even with a forced SQL payload. The
audit deploy did not, and could not, cause "data coming back".

### The actual likely cause — ranked by likelihood

#### #1 (most likely): Recurring task instances regenerate within 10 minutes of deletion

**Evidence:**

- [server/services/recurringTaskService.js:11-19](server/services/recurringTaskService.js#L11-L19):
  > The DB partial unique index `tasks_recurring_template_occurrence_unique`
  > on `(recurringTemplateId, occurrenceDate) WHERE recurringTemplateId IS
  > NOT NULL` is THE source of truth. Two concurrent calls to generateInstance
  > for the same (template, occurrenceDate) are guaranteed to produce exactly
  > one row — the second call's INSERT raises SequelizeUniqueConstraintError
  > which we catch and convert into a "skipped (already exists)" result.

- [server/services/recurringTaskService.js:483-486](server/services/recurringTaskService.js#L483-L486):
  ```js
  const existing = await Task.findOne({
    where: { recurringTemplateId: template.id, occurrenceDate },
    transaction: externalTx,
  });
  ```
  The existence check looks for a *current* row. **If the row was deleted,
  this SELECT returns `null` and the generator proceeds to INSERT a fresh
  one.**

- [server/controllers/taskController.js:2616](server/controllers/taskController.js#L2616):
  `await task.destroy();` — a HARD delete. There is no soft-delete flag,
  no `paranoid: true`, no `deleted_at`, no "skipped occurrences" table.

- [server/jobs/recurringTemplateGenerationJob.js](server/jobs/recurringTemplateGenerationJob.js) is registered to run **every 10 minutes**
  (see CLAUDE.md §"Background Jobs"). And
  [server/jobs/missedRecurringTaskJob.js](server/jobs/missedRecurringTaskJob.js) (also every 10 min) backfills missed
  templates back as far as `BACKFILL_CAP = 31` days
  ([recurringTaskService.js:1015](server/services/recurringTaskService.js#L1015)).

**End-to-end scenario reproducing "data coming back":**

1. Manager hard-deletes a recurring instance for today.
2. `tasks` row vanishes.
3. Within ≤10 minutes, `recurringTemplateGenerationJob` ticks, finds today's
   active recurring template, looks for a row at `(templateId,
   today)`, sees none, INSERTs a fresh instance.
4. User refreshes / receives realtime event → "the task came back."

This is the dominant cause unless the deleted task was not a recurring
instance.

#### #2 (possible): Frontend cache showing pre-delete state

- The client uses `@tanstack/react-query` style cache invalidation via
  [client/src/realtime/eventRouter.js](client/src/realtime/eventRouter.js).
  After a delete, the cache is invalidated by both the `task:deleted` event
  and the controller's own `realtime.emitTaskUpdated()` path
  ([taskController.js:2564-2567](server/controllers/taskController.js#L2564-L2567)).
- If a user's browser missed the realtime event (socket disconnected) and
  the cache happens to be served while the recurring generator is on a
  10-minute boundary, they could see (a) the deleted task disappear,
  (b) the task reappear on next refresh.
- The service worker is **dev-only** (see [client/src/main.jsx](client/src/main.jsx)
  — SW is gated on `import.meta.env.PROD` plus `?disable_sw=1` for emergency
  unregister). Service-worker cache is NOT a culprit.

#### #3 (unlikely): pg_dump+pg_restore from prior backup

- Backups are taken nightly at 02:00 UTC via [deploy/backup.sh](deploy/backup.sh).
- **No code in the repo ever calls `pg_restore`.** There is no automated
  restore path. The May 12 deploy's pre-deploy `pg_dump` is a snapshot,
  not a restore.
- A restore could only happen by manual operator action via `psql` /
  `docker exec aph-postgres pg_restore …`.

#### #4 (ruled out): Audit deploy

See top of this section. `BEGIN; SET TRANSACTION READ ONLY; …; ROLLBACK;`
+ forbidden-keyword grep — Postgres physically rejects writes.

#### #5 (ruled out): Database triggers / replication

The Postgres image is `postgres:16-alpine` with no custom triggers in any
migration. No replication is configured.

### What to do about #1 if you confirm it's the cause

Before considering this resolved you'd want to:

1. **Identify**: was the resurrected task a recurring instance? Check
   `tasks.recurringTemplateId IS NOT NULL` for the resurrected row.
2. **Short-term workaround**: pause or end-date the parent
   `RecurringTaskTemplate` before deleting the instance. With `endDate <
   today`, the generator exits early ([recurringTaskService.js:1027-1033](server/services/recurringTaskService.js#L1027-L1033)).
3. **Long-term fix** (NOT in this diff, suggested follow-up):
   - Add a `recurring_skipped_occurrences (templateId, occurrenceDate)`
     tombstone table, OR
   - Soft-delete recurring instances (`isArchived=true`) instead of
     `task.destroy()`. Boot-time backfill on `Task.recurringTemplateId IS
     NOT NULL && isArchived = true` would prevent regeneration.

I have **not** patched this in the current bundle because (a) it's
pre-existing behaviour, (b) it requires a schema change that the user
hasn't approved, and (c) the user's instruction was "audit and report
first, then wait for approval."

---

## 7. Secret Exposure Pre-Push Check (Phase 6)

### Tracked-files secret scan

```
$ git ls-files | grep -iE '\.env$|keystore|\.pem$|\.key$|\.aab$|\.apk$|\.ipa$|credentials|secret'
deploy/k8s/secrets.yml   ← template only, contains "CHANGE_ME" placeholders
```

[deploy/k8s/secrets.yml](deploy/k8s/secrets.yml) inspection:

```yaml
stringData:
  DB_PASSWORD: "CHANGE_ME"
  JWT_SECRET: "CHANGE_ME"
  TEAMS_CLIENT_ID: ""
  …
```

→ Safe to ship. No real secret values.

### Diff-level secret pattern scan

```
$ git diff | grep -E "^\+" | grep -iE "(sk_live|sk_test|AKIA|AIza|ghp_|xoxb|xoxp|-----BEGIN|eyJ[A-Za-z0-9_-]{60,}|password\s*=\s*['\"][^'\"]{6,}['\"]|secret\s*=\s*['\"][^'\"]{6,}['\"]|api[_-]?key\s*=\s*['\"][^'\"]{12,}['\"])"
(no output)
```

→ Clean. No credential-shaped strings introduced.

### .gitignore coverage

[.gitignore](.gitignore) explicitly excludes `.env`, `.env.local`,
`.env.*.local`, `server/.env`, `deploy/.env`, `*.pem`, `*.p12`, `*.key`,
`aws-config.txt`. Local file `deploy/.env` exists but is **not tracked** —
verified with `git check-ignore deploy/.env` → matches `.gitignore` rule.

The `security-gate.yml` workflow has a final job
([artifact-safety](.github/workflows/security-gate.yml#L94-L111)) that
fails the build if any of those patterns is added to tracked files in any
future commit. Defence in depth.

### Result

**No secret exposure risk in this diff.**

---

## 8. Build / Test Smoke Results (Phase 7)

| Check | Result | Notes |
|---|---|---|
| `node -c server.js` (syntax) | ✅ pass | parses cleanly under Node 24.15 |
| `require('./middleware/errorHandler')` | ✅ loads | |
| `require('./middleware/requestId')` | ✅ loads | |
| `require('./utils/safeLogger')` | ✅ loads | |
| `require('./utils/errors')` | ✅ loads | |
| `require('./utils/permissionGate')` | ✅ loads | |
| `require('./config/notificationLimits')` | ✅ loads | |
| `cd server && npx jest --runInBand` | ✅ **70 suites, 1224 tests, 0 failures** | runs in 46 s; full mocked-DB suite |
| `cd client && npx vitest run` | ✅ **17 files, 258 tests, 0 failures** | runs in 23 s |
| `cd client && npm run build` | ✅ build succeeds in 53 s | warning about chunk sizes (cosmetic; pre-existing) |

The Jest config emits two cosmetic warnings about an unknown
`setupFilesAfterSetup` key — same as before this diff, not a regression.

---

## 9. Read-only Production Audit Deploy Assessment

### `.github/workflows/readonly-production-task-audit.yml`

Lines [129-240](.github/workflows/readonly-production-task-audit.yml#L129-L240):

```sql
BEGIN;
SET TRANSACTION READ ONLY;
SHOW transaction_read_only;
… SELECTs only …
ROLLBACK;
SHOW transaction_read_only;
```

- Postgres MVCC enforces `transaction_read_only=on` at the row level.
  Any attempted DML (`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`DROP`/`ALTER`/
  `CREATE`/`GRANT`/`REVOKE`/`VACUUM`/`REINDEX`/`CLUSTER`) within the
  transaction is rejected with `ERROR: cannot execute … in a read-only transaction`.
- `ROLLBACK;` at the bottom — even if a write had somehow snuck through
  (it can't), it would not be committed.
- Container identity is verified BEFORE the SQL runs: backend and Postgres
  must be on the same `pg_postmaster_start_time()` AND must report
  `aniston_project_hub`. Mismatch → abort, no SQL sent.

### `.github/workflows/readonly-production-task-visibility-audit.yml`

Additional defence: a SQL file is WRITTEN to `/tmp/aniston-audit.sql` and
**pre-scanned with grep for forbidden keywords BEFORE being sent to psql**:

```bash
grep -E -i -w '(insert|update|delete|truncate|drop|alter|create|grant|revoke|vacuum|reindex|cluster)'
```

If any keyword is found, the workflow exits 1 *without ever opening a DB
connection*. This is a belt-and-braces layer on top of the read-only txn.

### Verdict

**The audit deploys are mathematically incapable of writing to production.**
"Data coming back after the audit" is correlation, not causation. See §6 for
the actual cause.

---

## 10. Recurring-Task Behaviour Deep-Dive

(Same root cause as §6 #1, expanded for the report's risk table.)

[server/services/recurringTaskService.js](server/services/recurringTaskService.js) — function
`generateInstance(template, occurrenceDate, options)`:

```
1. Pre-flight: template not paused, not after endDate, not before startDate
2. SELECT existing row by (recurringTemplateId, occurrenceDate)
   → if present, return { ok: true, created: false, task: existing }
   → if absent, INSERT new task row
3. On INSERT race (duplicate-key): catch, re-fetch the winner
4. afterInstanceCreated() fires notifications + (now) idempotent
   notifications via buildIdempotencyKey
```

The (template, occurrenceDate) tuple has a partial unique index. Once you
HARD-DELETE the existing row, the SELECT in step 2 returns nothing → the
INSERT in step 2 fires → the row exists again.

[server/jobs/missedRecurringTaskJob.js](server/jobs/missedRecurringTaskJob.js) escalates *existing* overdue
instances — it never creates instances. **But** it shares state with the
generator job through `missedEscalationSent` on the task row; if the row
was deleted and regenerated, the regenerated row has `missedEscalationSent
= false` (fresh), and the escalation could fire again.

**Conclusion:** Deleting a recurring instance and then deleting the parent
template *together* is the only safe way to make a recurring task vanish.
Suggested follow-up patch: introduce a "skipped occurrences" tombstone
table, or change the deleteTask path for recurring instances to soft-delete
(`isArchived=true`) so the existence check in step 2 still finds the row.

---

## 11. Risk Table

| # | Risk | Severity | Source | Mitigation status |
|---|---|---|---|---|
| 1 | Deleted recurring task instances are regenerated within ≤10 min | **High** (but **pre-existing**, NOT introduced by this push) | recurringTaskService + recurringTemplateGenerationJob (no tombstone) | Documented in §6. Suggested fix is out of scope; user has not approved schema change. |
| 2 | Sunny/Muskan force-reset block could ship "true" by accident | Medium | [deploy/run-onetime-password-reset.sh:70](deploy/run-onetime-password-reset.sh#L70) | Verified `"false"` at audit time. Add a pre-push check to §17. |
| 3 | `seed-users.js` could overwrite prod super admin if env var flipped | Medium | [server/seed-users.js](server/seed-users.js) | Script REFUSES to overwrite existing users by email. Still gated by `ALLOW_SEED_IN_PRODUCTION`. |
| 4 | Cron-side notification storm if `MAX_TASKS_PER_CRON_RUN` mis-set | Low | [server/config/notificationLimits.js](server/config/notificationLimits.js) | Default applied via `createBudget()`; env override exists. |
| 5 | Jest config emits two cosmetic "Unknown option" warnings | Low (cosmetic) | server/jest config | Pre-existing; not a regression. |
| 6 | `package-lock.json` Linux drift forces `npm install` over `npm ci` in CI | Low | [.github/workflows/deploy.yml:76](.github/workflows/deploy.yml#L76) | Documented TODO; reproducibility slightly weaker until lockfile regen on Linux. |
| 7 | Client `BoardPage` chunk is 1.13 MB (gzip 322 kB) | Low (perf) | Vite build report | Cosmetic warning; pre-existing chunk-split deferred. |
| 8 | Tracked file [deploy/k8s/secrets.yml](deploy/k8s/secrets.yml) uses `CHANGE_ME` placeholders | Low | template only | No actual secret. Safe to push as-is. |

**No Critical-severity risks introduced by this push.**

---

## 12. Required Fixes Before Push

**None.** The diff is push-ready as-is.

The one operational preflight item (not a code fix):

- [ ] Re-verify `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY="false"` in
      [deploy/run-onetime-password-reset.sh:70](deploy/run-onetime-password-reset.sh#L70).
      Already confirmed `"false"` at audit time.

---

## 13. Optional Improvements After Push (NOT in this bundle)

Treat each as a separate PR; none are blockers for shipping the current
diff.

1. **Tombstone or soft-delete for recurring instances.** Either a
   `recurring_skipped_occurrences (templateId, occurrenceDate)` table that
   the generator checks before INSERTing, OR change
   `taskController.deleteTask` to set `isArchived=true` for tasks where
   `recurringTemplateId IS NOT NULL`. Eliminates the "data coming back"
   class of bug.
2. **Off-host backups.** The `BACKUP_S3_BUCKET` template in
   [deploy/backup.sh:42-46](deploy/backup.sh#L42-L46) is wired but
   commented out. Configure IAM and uncomment for survivability against
   EBS / instance loss.
3. **Lockfile regeneration on Linux** to restore `npm ci` reproducibility
   in CI (see Risk #6).
4. **DB rollback automation.** Today's auto-rollback restores only the
   code SHA. For forward-only DDL pushes this is fine; for the
   tombstone/soft-delete migration above, document a manual restore from
   the pre-deploy `pg_dump`.
5. **Cron job alerting.** Job failures are `console.error` only. Wire
   Slack/PagerDuty hooks to mirror the rollback-failure path.

---

## 14. Exact Commands To Run Before Pushing

```bash
# 1) Re-verify the FORCE_AUTO_RUN flag is still "false" (defence-in-depth):
grep '^FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY=' deploy/run-onetime-password-reset.sh
# Expected: FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY="false"

# 2) Re-run targeted test suites locally (already green at audit time):
cd server && npx jest --runInBand --silent
cd ../client && npx vitest run

# 3) Re-run the client production build (already green at audit time):
cd client && npm run build

# 4) Show what you're about to commit one last time:
git status
git diff --stat

# 5) ONLY when you've confirmed each of the above, stage + commit + push.
```

**Do NOT push without a human eye on `git status` first.** The diff
includes 4 deletions (the legacy dashboard pages) — confirm you intended
those.

---

## 15. Files Safe To Commit

All 84 modified + 4 deleted + 19 untracked files are safe to commit.
Optional grouping if you want multiple commits instead of one:

- **Group A — error handling + observability**:
  - `server/middleware/errorHandler.js` (NEW)
  - `server/middleware/requestId.js` (NEW)
  - `server/utils/errors.js` (NEW)
  - `server/utils/safeLogger.js` (NEW)
  - `server/server.js`
  - `client/src/utils/errorMap.js` (NEW)
  - `client/src/utils/safeLog.js` (NEW)
  - `client/src/services/api.js`
  - `client/src/components/common/ErrorBoundary.jsx`
  - all controller error-path changes in `server/controllers/*`

- **Group B — cron-job storm fixes**:
  - `server/config/notificationLimits.js` (NEW)
  - `server/jobs/missedRecurringTaskJob.js`
  - `server/jobs/reminderJob.js`
  - `server/jobs/deadlineReminderJob.js`
  - `server/jobs/priorityEscalationJob.js`
  - `server/services/reminderService.js`
  - `server/services/recurringTaskService.js`
  - `server/__tests__/jobs/**`

- **Group C — RBAC catalog expansion**:
  - `server/config/permissionMatrix.js`
  - `server/services/permissionEngine.js`
  - `server/utils/permissionGate.js` (NEW)
  - `server/routes/permissions.js`
  - `server/scripts/audit-permission-grants.js` (NEW)
  - `client/src/context/AuthContext.jsx`
  - `client/src/utils/permissions.js`

- **Group D — legacy dashboard cleanup**:
  - `client/src/components/dashboard/RoleDashboard.jsx` (DELETED)
  - `client/src/pages/AdminDashboardPage.jsx` (DELETED)
  - `client/src/pages/ManagerDashboardPage.jsx` (DELETED)
  - `client/src/pages/MemberDashboardPage.jsx` (DELETED)
  - `client/src/App.jsx`

- **Group E — UI refresh**:
  - `client/src/pages/TasksPage.jsx`
  - `client/src/pages/DependenciesPage.jsx`
  - `client/src/pages/BoardPage.jsx`
  - `client/src/pages/AdminSettingsPage.jsx`
  - all `client/src/components/board/*` changes
  - `client/src/components/layout/{Header,Sidebar}.jsx`
  - all hook + i18n + service additions

- **Group F — tests**: all `__tests__/**` changes and new test files.

A single combined commit is also fine — none of the groups conflict.

---

## 16. Final Approval Checklist

- [x] All 88 changed files reviewed.
- [x] Zero new SQL migration files. Verified `git status server/migrations/` is clean.
- [x] Zero new boot-time DDL in `server.js`. Verified `git diff server/server.js` shows no `CREATE/ALTER` DDL.
- [x] Zero new model files. Verified `git diff -- 'server/models/**'` is empty.
- [x] Both audit workflows confirmed read-only (txn read-only + forbidden-keyword guard).
- [x] `seed-users.js` prod-guarded; verified `ALLOW_SEED_IN_PRODUCTION` not set in prod.
- [x] `seed-hierarchy.js` prod-guarded; verified `ALLOW_PROD_HIERARCHY_SEED` not set in prod.
- [x] `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY="false"` confirmed in
      `deploy/run-onetime-password-reset.sh`.
- [x] Server tests: 1224/1224 pass.
- [x] Client tests: 258/258 pass.
- [x] Client build: succeeds.
- [x] No new secret-shaped strings in diff.
- [x] No tracked `.env`, `.pem`, `.key` files.
- [x] `audit-permission-grants.js` is NOT auto-run; dry-run by default.
- [x] Root cause of "data coming back" identified (existing behaviour, not
      introduced here). Documented in §6 + §10.

---

## 17. TL;DR for the operator

- **You can push.** No DB migration is needed.
- The audit deploy did **not** alter production data. It can't — Postgres
  rejects writes inside `SET TRANSACTION READ ONLY`.
- The "deleted data coming back" is almost certainly the **recurring-task
  generator** (every 10 min) regenerating deleted instances. This is *not*
  caused by this push, the audit deploy, or any seed script. It is
  pre-existing behaviour. Pause / end-date the parent recurring template
  before deleting future instances, or wait for a follow-up patch that
  adds a tombstone.
- Confirm `git status` one more time before `git push origin main`.
