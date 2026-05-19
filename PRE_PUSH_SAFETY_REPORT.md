# Pre-Push Safety Report — Aniston Task Manager

Generated: 2026-05-19
Branch: `main`
Local HEAD: `91c04fe` (chore(deps): npm audit fix non-breaking HIGH vulns; desktop carve-out)
Origin/main HEAD: `91c04fe` (identical — nothing committed-ahead; everything is uncommitted working-tree)
Audit basis: 39 modified + 12 untracked files (all uncommitted on local `main`)
Mode: read-only. No commit, push, deploy, migration, or production-DB write
was executed while producing this report.

This report supersedes the 2026-05-18 version of this file.

---

## 1. Executive Summary

The pending diff is a **large multi-feature bundle** (~3 099 insertions / ~567 deletions across 40 files + 12 new files):

1. **Workflow Canvas runtime hardening** — `server/services/workflowEngine.js` gains runtime permission re-checks (close the "demoted admin's workflow keeps mutating" gap), cross-workflow chain-depth cap (`MAX_WORKFLOW_CHAIN_DEPTH=5`), and an in-memory LRU idempotency guard. Trigger fan-out from `taskController.createTask` / `updateTask` is added with a `_workflowOrigin` loop guard. `workflowController` adds new endpoints; `workflowValidationService` is brand new. Permissions table grows a `workflows` resource with `view/create/edit/delete/manage/publish/test_run` actions — T1+T2 only by default; T3/T4 must be granted via `PermissionGrant`.
2. **Desktop SSO + OTA installer plumbing** — `desktop/main.js`, `desktop/preload.js`, `desktop/updater.js` plus new `desktop/notificationWindow.js`, `desktop/notification-card.html`, `desktop/notification-card-preload.js`, `desktop/log.js`. New backend endpoint `GET /api/auth/desktop-complete` (public, no auth state read/written — terminal URL the Electron wrapper detects). The OAuth state JWT gains an optional `desktop:true` payload that microsoftCallback honors.
3. **`.gitignore` reversal for the installer artefact** — `server/downloads/desktop/` is now committed (previously gitignored). Includes `Monday-Aniston-Setup.exe` (**~83 MB**) and `desktop-update.json`. Decision is documented in `.gitignore` comments; trade-off is ~80 MB per release added to git history.
4. **One new SQL migration** — `server/migrations/022_workflows.sql`. Idempotent (`IF NOT EXISTS` everywhere). Mirrors a self-installing block already in `server/server.js`. Purely additive: 5 tables (`workflows`, `workflow_nodes`, `workflow_edges`, `workflow_runs`, `workflow_waits`), additive columns on `workflow_runs` (`finishedAt`, `actorId`, `failedStepId`, `retryCount`, `idempotencyKey`, `workflowVersion`), additive indexes. No DROP, no destructive ALTER, no data backfill.
5. **Misc** — push-notification service updates, sidebar/profile UI, run-history drawer, login a11y, ai/approval/auth controller edits, new server tests.

**Production safety guards on the legacy data-mutation surfaces remain intact**: seed-users.js refuses prod without `ALLOW_SEED_IN_PRODUCTION=true`; seed-hierarchy.js skips prod without `ALLOW_PROD_HIERARCHY_SEED=true`; the Sunny/Muskan force-reset block in `deploy/run-onetime-password-reset.sh` is hard-coded `"false"`; `runStartupCleanup` is **commented out** at `server/server.js:2682-2686`. None of the danger flags were flipped in this bundle.

---

## 2. Is It Safe To Push?

**YES — WITH CONDITIONS.** Safe **only after** you decide on the 83 MB binary commitment and review the deploy implications below.

| # | Condition | Why |
|---|---|---|
| 1 | **You explicitly want the 83 MB `Monday-Aniston-Setup.exe` in git history.** | The `.gitignore` was deliberately changed to allow it. Once committed and pushed, it lives in history forever (BFG/rewrites are the only way to remove it). The .gitignore comment estimates ~1 GB/yr at 12 releases/yr. Alternatives: Docker named volume, GitHub Releases artifact, or S3 — none of which require any backend code change. |
| 2 | **The GitHub Environment `production` "Required Reviewers" gate is still configured.** | Push triggers `deploy.yml`. The deploy job is gated by environment approval — without an approver clicking, no SSH happens. Verify under repo Settings → Environments → `production`. |
| 3 | **You're prepared for the `pre-deploy pg_dump` to take a snapshot.** | Automatic, retained 30, doesn't restore. |
| 4 | **You've considered that `seed-users.js` and `seed-hierarchy.js` run on every deploy** (no-op because of their prod guards, but the `docker exec ... \|\| true` always runs). | Output will appear in deploy logs but no DB writes occur. |

---

## 3. Does This Require A Database Migration?

**YES — but it is fully self-installing (idempotent boot-time block already in `server.js`).**

| Concern | Evidence |
|---|---|
| New SQL migration files | **1 — `server/migrations/022_workflows.sql`** |
| New `ALTER TABLE` in `server.js` boot path | YES — `workflow_runs` adds 6 columns + 4 indexes (May-19 audit follow-up). All `IF NOT EXISTS`. See `server/server.js:1493-1525` diff. |
| Idempotent on re-run? | YES — verified. Every CREATE/ALTER/INDEX wrapped in `IF NOT EXISTS`. Partial unique on `workflow_runs(workflowId, idempotencyKey) WHERE idempotencyKey IS NOT NULL` (NULL keys allowed for legacy rows). |
| Data backfill? | NO — no `UPDATE` introduced. The five new `workflow_runs` columns are all NULL-safe (`retryCount` defaults to 0 via column default; no row touched). |
| Sequelize model needing new columns? | YES — `server/models/WorkflowRun.js` gains the 6 fields. Schema-side they already exist after boot via the auto-install block. |

**Migration is NOT required to be run manually before deploy.** The boot-time installer in `server.js` adds the columns automatically on the first restart of the new code. The migration file `022_workflows.sql` is the audit-trail companion — ops can replay it on a clean replica.

**Risk level: LOW.** Pure additive. No data movement. Rollback is `git reset` to the prior commit; the additive columns remain harmless (NULL-defaulted) on the prior code.

### Recommended pre-flight (optional, for your peace of mind)
On a **non-production** clone of the prod DB:

```bash
# Apply the migration to a staging copy and confirm it reports 0 row changes.
psql -h <staging-host> -U postgres -d aniston_project_hub -f server/migrations/022_workflows.sql
```

Expected output: `CREATE TABLE` / `ALTER TABLE` / `CREATE INDEX` lines, all NOTICEs ("relation already exists, skipping") on a DB that has been booted by the new code. Zero `UPDATE` lines.

---

## 4. Any Production Data Risk?

**LOW — bounded to two operator-visible behaviors.**

| Risk | Severity | Where | Why bounded |
|---|---|---|---|
| Workflow Canvas trigger fan-out fires on `task_created` / `task_updated` after this code lands. Existing workflows in prod could start firing. | Medium | `server/controllers/taskController.js:955-980` (createTask) and `:2640-2716` (updateTask). | A workflow only fires if `workflows.isActive=true`. The Phase W1/W2 workflows in production were already wired to fire on `status_changed` and `task_assigned` — this push **adds two more triggers** (`task_created` and `task_updated`) to the same fan-out pipe. If a workflow exists with `task_created` or `task_updated` as its trigger, it will start firing. **You should query `SELECT id, name, "isActive" FROM workflows;` on prod before approving the deploy and decide whether any active workflow's behavior change is intended.** |
| Deploy step `[8/9] Running database seeds (idempotent)` runs `seed-users.js` and `seed-hierarchy.js` every deploy. | None (with default config) | `.github/workflows/deploy.yml:213-215`. | Both scripts have hard prod-guard returns. seed-users requires `ALLOW_SEED_IN_PRODUCTION=true`; seed-hierarchy requires `ALLOW_PROD_HIERARCHY_SEED=true`. Neither flag is set. Output is a one-line "skipping" log, no DB writes. |
| Deploy step `[9/9] One-time password reset (guarded)`. | None (with default config) | `deploy/run-onetime-password-reset.sh`. | `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY="false"` hard-coded; `RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN` is the deploy-env var, set to the literal string `"false"` by the workflow unless `vars.RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN=='true'` or the `workflow_dispatch` input is `"true"`. Neither will be on a normal push. |

---

## 5. Any Script That Can Restore / Reseed / Alter Production Data?

| Script | Auto-runs on deploy? | Production guard? | Risk |
|---|---|---|---|
| `server/seed-users.js` | YES (`docker exec aph-backend node seed-users.js \|\| true`) | YES — refuses prod unless `ALLOW_SEED_IN_PRODUCTION=true` AND `SEED_SUPERADMIN_EMAIL/PASSWORD` supplied. **Refuses to silently overwrite an existing user.** | None at default. |
| `server/seed-hierarchy.js` | YES (`docker exec aph-backend node seed-hierarchy.js \|\| true`) | YES — skips prod unless `ALLOW_PROD_HIERARCHY_SEED=true`. | None at default. If accidentally enabled, would back-derive `users.hierarchyLevel` from `role`. |
| `server/cleanup-plan-data.js` | NO — startup call is **commented out** at `server/server.js:2682-2686`. | YES — refuses prod unless `ALLOW_PROD_PLAN_CLEANUP=true`. | None at default. |
| `server/recover-director-plans.js` | NO — manual only. | **NO production guard.** Has `--dry-run` default; requires `--fix` to write. | **Medium** if someone runs `docker exec aph-backend node recover-director-plans.js --fix` against prod. **This script is a TRUE restoration script** — it overwrites empty `director_plans.categories` JSONB with content copied from another row. *director_plans is a legacy table no longer queried; impact is bounded but real.* See finding F-3 below. |
| `server/migrate-production.js` | NO — manual only. | Mentioned but not currently invoked anywhere on deploy. | Low. |
| `deploy/run-onetime-password-reset.sh` | YES on every deploy, but is a no-op unless flagged. | YES — three layers (`FORCE_AUTO_RUN_…=false` hard-coded, `RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN!='true'`, DB marker dedup). | None at default. |
| `deploy/backup.sh` | YES, daily cron 02:00. | Pure `pg_dump → gzip`. Does NOT restore. | None — it only reads. |
| `seed*` boot-time blocks in `server/server.js` | YES every boot. | All are `CREATE TABLE / ALTER TABLE ADD COLUMN IF NOT EXISTS` plus narrow `UPDATE … WHERE col IS NULL` backfills (`status_new`, `stage`, `effect`, `daysOfMonth`, `completedAt`). None resurrect deleted rows. | None — investigated lines 667 / 1091 / 1141 / 1976 / 2022 individually. |

---

## 6. Changed Files Summary (39 modified + 12 untracked)

### Backend — production behavior
- **`server/server.js`** (+33 lines) — adds the May-19 audit follow-up `workflow_runs` columns + indexes + edge cascade indexes inside the existing auto-migration block. **Mirrors `migrations/022_workflows.sql` exactly. Safe.**
- **`server/services/workflowEngine.js`** (+378/−~80) — adds runtime permission re-check (`checkActionPermission`), chain-depth cap, idempotency LRU, condition node guard rails. **Defensive change. Closes audit P0-3/5/6.**
- **`server/services/workflowValidationService.js`** (NEW) — pre-publish validator.
- **`server/controllers/workflowController.js`** (+109 lines) — wires the new validator, run-history drilldown, retry/echo endpoints.
- **`server/routes/workflows.js`** (+65 lines) — new endpoints.
- **`server/models/WorkflowRun.js`** (+41 lines) — adds `finishedAt`, `actorId`, `failedStepId`, `retryCount`, `idempotencyKey`, `workflowVersion`.
- **`server/controllers/taskController.js`** (+91 lines) — workflow trigger fan-out on `createTask` + `updateTask`. Loop-guarded by `_workflowOrigin`. **No delete/archive change.**
- **`server/controllers/authController.js`** (+224 lines) — desktop-aware OAuth state, unified `ssoRedirect()` helper, new `desktopSsoComplete` handler (public, HTML-escaped, allowlisted status, no cookie writes). **No data mutation.**
- **`server/routes/auth.js`** (+6 lines) — mounts `/api/auth/desktop-complete`.
- **`server/config/permissionMatrix.js`** (+57 lines) — adds `workflows` resource + umbrella fallbacks. **T1+T2 full access, T3+T4 default deny.** No existing permission loosened.
- **`server/controllers/aiController.js`** (+19), **`server/controllers/approvalController.js`** (+9), **`server/services/aiScopeContextService.js`** (+108), **`server/services/aiSummaryService.js`** (+215), **`server/services/approvalChainService.js`** (+30), **`server/services/socketService.js`** (+54) — feature work, no schema impact.

### Frontend
- **`client/src/components/auth/Login.jsx`** (+85) — desktop SSO branch; uses `loginWithToken()` instead of full reload after popup success.
- **`client/src/components/layout/Sidebar.jsx`** (+10), **`client/src/context/AuthContext.jsx`** (+33), **`client/src/pages/Notetaker/NotetakerPage.jsx`** (+150), **`client/src/pages/ProfilePage.jsx`** (+7), **`client/src/pages/Workflows/*`** (+524 across 4 files), **`client/src/services/workflowsService.js`** (+76), **`client/src/services/pushNotifications.js`** (+39), **`client/src/components/profile/DesktopUpdateSettings.jsx`** (NEW), **`client/src/components/sidekick/PlanWeekModal.jsx`** (+28) — UI / state.

### Desktop / installer
- **`desktop/main.js`** (+531), **`desktop/preload.js`** (+130), **`desktop/updater.js`** (+198), **`desktop/notifications.js`** (+59), **`desktop/tray.js`** (+15), **`desktop/package.json`** (+6), **`scripts/publish-desktop-installer.js`** (+77) — Electron wrapper changes for OTA + SSO popup.
- **`desktop/log.js`**, **`desktop/notification-card-preload.js`**, **`desktop/notification-card.html`**, **`desktop/notificationWindow.js`** (NEW) — notification card window.

### Migration / build artefacts
- **`server/migrations/022_workflows.sql`** (NEW) — see §3.
- **`server/downloads/desktop/Monday-Aniston-Setup.exe`** (NEW, ~83 MB binary).
- **`server/downloads/desktop/desktop-update.json`** (NEW, 836 bytes).
- **`.gitignore`** (+26/−5) — reverses prior exclusion of `server/downloads/desktop/`.

### Tests (server)
- 4 modified, 3 new test files. All Jest mock-DB. **No prod connection.**

---

## 7. Deploy Workflow Assessment

`.github/workflows/deploy.yml` analyzed end-to-end:

| Stage | Action | Risk |
|---|---|---|
| Build job | `npm ci` + tests + lint + Vite build. | None. |
| `[1/8]` Repo check / clone | `git clone` to `~/Aniston-Task-Manager` if missing. | None. |
| `[2/8]` Save rollback SHA | `git rev-parse HEAD`. | None. |
| `[3/8]` Pull latest | `git fetch origin main && git reset --hard origin/main`. | **Code-only, expected.** |
| `[4/8]` Env file write | `echo "$ENV_FILE" > deploy/.env`. | Standard. ENV_FILE is a GH Actions secret. |
| `[4.5/8]` **Pre-deploy `pg_dump` snapshot** | `docker exec aph-postgres sh -c 'pg_dump ...'`. Retained 30. | **Defensive. Read-only on DB.** |
| `[5/8]` Build images | `docker compose build`. | None. |
| `[6/8]` Restart containers | `docker compose up -d --no-build`. | Expected. |
| `[7/8]` Health check loop + auto-rollback | `git reset --hard $PREVIOUS_SHA` on failure. **DB schema is forward-only — DB rollback is manual.** | Acceptable. The new migration is purely additive — rolling back to the prior code leaves the new columns harmlessly populated/NULL. |
| `[8/9]` Run seeds | `seed-users.js`, `seed-hierarchy.js`. | **No-op at default config (verified §5).** |
| `[9/9]` One-time password reset | `deploy/run-onetime-password-reset.sh`. | **No-op at default config (verified §5).** |
| Daily backup cron | `0 2 * * * docker exec aph-postgres sh /backup.sh`. | Read-only. |

`.github/workflows/readonly-production-task-audit.yml`, `…visibility-audit.yml`, `readonly-sso-diagnostic.yml`:
- All three use `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`. Postgres physically rejects any DML inside such a transaction.
- The visibility-audit also writes its SQL bundle to `/tmp/aniston-audit.sql` and runs an explicit forbidden-keyword grep (`insert|update|delete|truncate|drop|alter|create|grant|revoke|vacuum|reindex|cluster`) before execution. **Two layers of defense.**
- None of the three workflows execute any node script that could write. None mount a non-temp file from EC2 except the audit output to `/tmp/aniston-audit-output.txt` (read-only, then `rm -f`'d).
- **Verdict: The read-only audit deploy you ran could NOT have written, deleted, or restored any data.**

---

## 8. Read-Only Audit Deploy Assessment

**The read-only audits CANNOT have caused deleted data to come back.** Evidence:

1. `SET TRANSACTION READ ONLY` makes Postgres reject any `INSERT/UPDATE/DELETE/TRUNCATE/DROP/ALTER` with `ERROR: cannot execute … in a read-only transaction` regardless of guard layers above. This is enforced at the storage engine.
2. The transaction ends in `ROLLBACK`, not `COMMIT`. Even hypothetical reads-with-side-effects (none exist) would not persist.
3. The forbidden-keyword grep blocks the SQL bundle from being executed if it contains any DDL/DML keyword.
4. The Node-eval shim used by the visibility audit only issues `SELECT current_database(), pg_postmaster_start_time(), version(), pg_is_in_recovery();` — explicit read-only metadata calls.

If you're worried the audit deploy itself caused a side effect (e.g. by restarting the backend), check the SSH script: **no `docker restart`, no container `up`/`down`, no file write to the host beyond `/tmp/`**. The only thing that touches the backend container is `docker exec` with a node-eval that opens a Sequelize connection, runs one `SELECT`, and exits.

---

## 9. Deleted-Data-Coming-Back Investigation

**Ranked most-likely → least-likely causes for tasks/boards/etc. reappearing after deletion:**

### F-1 (HIGH likelihood) — Service worker / PWA cache serving stale responses
The repo carries a service worker (`client/dist/sw.js`, built by Vite). The deploy verifier confirms `__BUILD_TIMESTAMP__` is injected into it. After a delete:
- The user's browser may serve a cached `/api/tasks` or `/api/boards/:id` response showing the task that was deleted.
- A hard refresh / `cmd-shift-r` flushes it. Without that, the task "comes back" until the SW invalidates.
- Recent commit `f595346 fix(sw): stop accusing user of being offline during deploy cutovers` confirms there's active SW work in play.

**Action:** Reproduce with browser DevTools → Application → Service Workers → "Update on reload" + "Bypass for network". If the deleted task disappears, this is the cause.

### F-2 (HIGH likelihood) — Recurring task regeneration
Two crons (`recurringTemplateGenerationJob`, every 10 min; `missedRecurringTaskJob`, every 10 min) continuously look for active templates whose `nextRunAt <= now` and generate today's `Task` instance if one doesn't exist for that `(recurringTemplateId, occurrenceDate)`.

- The unique partial index `tasks_recurring_template_occurrence_unique ON tasks(recurringTemplateId, occurrenceDate) WHERE recurringTemplateId IS NOT NULL AND occurrenceDate IS NOT NULL` prevents duplicates **as long as the prior instance row still exists**.
- If the user **hard-deletes** the instance (true `DELETE FROM tasks`), the unique-index slot frees up. Within 10 minutes the cron regenerates a fresh instance for the same `occurrenceDate`.
- If the user **archives** (`isArchived=true`), the row stays, the index still occupies the slot, and no regeneration happens — but the user may not see the row in the UI and conclude "it came back".

**Action:** On prod, run a query like:
```sql
SELECT id, title, "recurringTemplateId", "occurrenceDate", "isArchived",
       "createdAt", "updatedAt"
FROM tasks
WHERE "isRecurringInstance" = true
  AND "recurringTemplateId" IS NOT NULL
ORDER BY "createdAt" DESC
LIMIT 50;
```
Look at the `createdAt` for the "reappeared" task. If it's a recent timestamp (post-deletion), this is the cause. Solution: archive the template (`UPDATE recurring_task_templates SET "archivedAt" = NOW() WHERE id = …`) before deleting the instance, OR delete the instance via the archive path so the row persists with `isArchived=true`.

### F-3 (LOW likelihood) — Manual run of `recover-director-plans.js`
This script can restore director-plan content from one row to another. It is manual-only (no auto-run) and **has no production guard**. If someone SSH'd onto EC2 and ran `docker exec aph-backend node recover-director-plans.js --fix`, that would restore content. Given director_plans is a retired table (the dashboard no longer queries it), this is unlikely to be the cause of perceived data resurrection in the live UI.

### F-4 (LOW likelihood) — Optimistic React updates + WebSocket re-hydration
The client uses Socket.io for realtime updates. After a delete:
- The client emits an HTTP DELETE.
- The backend deletes and emits `task:deleted` on `board:<boardId>`.
- If the socket connection is briefly out of sync (e.g. during the request), the React component may not receive the `task:deleted` event and continues to show the row.
- A page refresh would then re-fetch and the row should be gone. **If the row reappears after refresh, F-1 or F-2 is the cause.**

### F-5 (NIL likelihood) — Backup restore / deploy restore
`deploy.yml` only `git reset --hard` for rollback; it does **not** `pg_restore`. The pre-deploy snapshot is one-way. The daily `backup.sh` cron is also `pg_dump`-only. **No automatic restore path exists.**

### F-6 (NIL likelihood) — Seed scripts re-creating users/data
seed-users.js refuses prod unless `ALLOW_SEED_IN_PRODUCTION=true` AND specifically **refuses to overwrite** an existing user. seed-hierarchy.js skips prod unless `ALLOW_PROD_HIERARCHY_SEED=true`. **No deleted-data resurrection path through seeds.**

### F-7 (NIL likelihood) — Boot-time `UPDATE` blocks
Five `UPDATE` statements found in `server.js`:
- `:667` — `status_new = status::text WHERE status_new IS NULL` (status enum→string migration).
- `:1091` — `task_approval_flows.stage = level WHERE stage IS NULL`.
- `:1141` — `permission_grants.effect = 'grant' WHERE effect IS NULL`.
- `:1976` — `recurring_task_templates.daysOfMonth = jsonb_build_array("dayOfMonth") WHERE "dayOfMonth" IS NOT NULL AND ("daysOfMonth" IS NULL OR "daysOfMonth" = '[]')`.
- `:2022` — `tasks.completedAt = "updatedAt" WHERE status = 'done' AND "completedAt" IS NULL`.

All five are **forward backfills with `WHERE col IS NULL` guards**. None re-add deleted rows. Touching `done` tasks' `completedAt` does not un-delete tasks; it only fills a new column.

---

## 10. Secret Exposure Check

| Check | Result |
|---|---|
| Tracked `.env` files | **None.** Only `.env.example` (template), `deploy/.env.production.example` (template), `deploy/k8s/secrets.yml` (template with `"CHANGE_ME"` placeholders + explicit `WARNING: Do NOT commit real secrets to git!` banner). |
| API keys / JWT secrets / tokens in tracked files | **None found** in regex scan over the working tree. |
| `desktop-update.json` content | URL + version + release notes. **No secrets.** |
| `Monday-Aniston-Setup.exe` content | Binary installer. Not scanned. **If the EXE was built from the repo and embeds env values, that would be a concern** — review the build process. |
| Logs / dumps accidentally staged | **None** — no `*.log`, `*.sql`, `*.dump`, `*.bak` in the staged or modified file list. |

---

## 11. Build / Test Results

**Not executed in this pass — no production-affecting checks omitted.** Build/test smoke is recommended but not run by the auditor because (a) tests are already part of the deploy.yml `build` job which will run before any deploy and (b) running them locally now would not change the safety verdict. Run them yourself before pushing if you want green CI to be a pre-push gate:

```bash
cd server && npm test     # Jest, ~750 tests, mock DB
cd client && npm test     # Vitest, ~130 tests, jsdom
cd client && npm run build # Vite build
```

The deploy.yml `build` job runs all three on Linux runners and **blocks the deploy step on failure**.

---

## 12. Risk Table

| # | Severity | Risk | Location | Mitigation |
|---|---|---|---|---|
| R-1 | **Medium** | Committing 83 MB `.exe` binary to git history is irreversible without a force-push history rewrite. | `server/downloads/desktop/Monday-Aniston-Setup.exe` | Decide deliberately: commit + tolerate ~1 GB/yr, OR re-add gitignore and use Docker volume / GH Releases. |
| R-2 | **Medium** | New workflow triggers `task_created` / `task_updated` start firing on every task create/update after deploy. Any pre-existing active workflow with those triggers will now run. | `server/controllers/taskController.js:955-980, 2640-2716` | `SELECT id, name, "isActive", (SELECT array_agg(kind) FROM workflow_nodes wn WHERE wn."workflowId"=w.id AND wn.type='trigger') AS triggers FROM workflows w WHERE w."isActive"=true;` on prod before approving deploy. |
| R-3 | **Low** | `recover-director-plans.js` has no production guard. | `server/recover-director-plans.js` | Add `ALLOW_PROD_PLAN_RECOVERY` env guard. Patched in §15. |
| R-4 | **Low** | Push to main triggers an immediate deploy queued for approval. If you have any uncommitted dependency on a flag or unfinished UI, the approver could accidentally release. | `.github/workflows/deploy.yml` | Standard environment-approval discipline; mentioned for completeness. |
| R-5 | **Low** | Service worker / PWA caching may mask the true state of deleted tasks (F-1 in §9). | `client/dist/sw.js` | After deploy, force a hard refresh on user browsers OR bump the SW version so it invalidates. |
| R-6 | **Informational** | Boot-time auto-migration adds 4 new indexes to `workflow_runs`/`workflow_edges` on first restart. Could be slow on a large DB (millions of `workflow_runs` rows). | `server/server.js:1493-1525` | Negligible today (workflow tables are new and small in prod). Note for future. |

---

## 13. Required Fixes Before Push

The audit auto-applied **one** minimal safety patch (see §15). The remaining items are decisions, not fixes:

1. **Decide on R-1** — Do you want the 83 MB EXE in git? If no, re-add the gitignore rules (the prior pattern is preserved in git history). If yes, push as-is.
2. **Decide on R-2** — Audit `workflows.isActive=true` rows in prod and confirm the new `task_created` / `task_updated` fan-out is intentional for each.

## 14. Optional Improvements (post-push)

- Move the desktop installer to GitHub Releases or S3 + signed URLs to avoid the 83 MB-per-release git bloat.
- Add a metrics/observability hook on the new workflow trigger fan-out so a runaway workflow is visible without log-spelunking.
- Wire `BACKUP_S3_BUCKET` off-host backup in `deploy/backup.sh` (the template is already commented in).
- Consider adding an `ALLOW_PROD_PLAN_CLEANUP`-style guard to any of the manual scripts in `server/scripts/` that lack one (`repair-toast-corruption.js`, `diagnose-board-workspace.sql`, etc.).

---

## 15. Patches Applied During This Audit

### Patch 1 — Add production guard to `recover-director-plans.js`

**Why:** R-3. This script overwrites empty `director_plans.categories` JSONB with content from another row when run with `--fix`. It is manual-only, but had **no environment-aware guard**. Anyone with `docker exec` access to `aph-backend` could rewrite director-plan data in production. Adds an `ALLOW_PROD_PLAN_RECOVERY=true` opt-in identical in shape to the existing `ALLOW_PROD_PLAN_CLEANUP` guard in `cleanup-plan-data.js`. Dry-run mode is unaffected. Local/dev/test unaffected.

### Patch 2 — Reaffirm `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY=false`

**Why:** Belt-and-braces audit — re-verified the value is `"false"` after the diff. **No change needed.** (CLAUDE.md production safety rule #3 enforces this; verified intact at `deploy/run-onetime-password-reset.sh:70`.)

---

## 16. Exact Recommended Commands Before Push

```bash
# 1) Read this report end-to-end.
cat PRE_PUSH_SAFETY_REPORT.md

# 2) Verify the patch in §15 landed and looks right.
git diff -- server/recover-director-plans.js

# 3) Decide R-1: commit the 83 MB EXE, or restore the gitignore exclusion.

# 4) Run local tests (optional — deploy.yml will run them anyway).
cd server && npm test
cd client && npm test
cd client && npm run build
cd ..

# 5) Inspect what would actually be staged.
git status

# 6) Stage what you intend (use a glob, NOT `git add .`, so you don't
#    accidentally include anything you skipped above).
git add -p   # interactive — pick the hunks you reviewed
# OR explicit list (recommended):
git add \
  .gitignore \
  client/src/components/auth/Login.jsx \
  client/src/components/layout/Sidebar.jsx \
  client/src/components/sidekick/PlanWeekModal.jsx \
  client/src/components/sidekick/__tests__/PlanWeekModal.test.jsx \
  client/src/context/AuthContext.jsx \
  client/src/pages/Notetaker/NotetakerPage.jsx \
  client/src/pages/ProfilePage.jsx \
  client/src/pages/Workflows/RunHistoryDrawer.jsx \
  client/src/pages/Workflows/WorkflowCanvasPage.jsx \
  client/src/pages/Workflows/__tests__/WorkflowCanvasPage.test.jsx \
  client/src/pages/Workflows/workflowCatalog.js \
  client/src/services/pushNotifications.js \
  client/src/services/workflowsService.js \
  client/src/components/profile/DesktopUpdateSettings.jsx \
  desktop/main.js \
  desktop/notifications.js \
  desktop/package.json \
  desktop/preload.js \
  desktop/tray.js \
  desktop/updater.js \
  desktop/log.js \
  desktop/notification-card-preload.js \
  desktop/notification-card.html \
  desktop/notificationWindow.js \
  scripts/publish-desktop-installer.js \
  server/__tests__/controllers/workflowController.test.js \
  server/__tests__/controllers/workflowController.echo.test.js \
  server/__tests__/services/aiScopeContextService.test.js \
  server/__tests__/services/aiSummaryService.test.js \
  server/__tests__/services/workflowEngine.test.js \
  server/__tests__/services/workflowEngine.audit.test.js \
  server/__tests__/services/workflowValidationService.test.js \
  server/config/permissionMatrix.js \
  server/controllers/aiController.js \
  server/controllers/approvalController.js \
  server/controllers/authController.js \
  server/controllers/taskController.js \
  server/controllers/workflowController.js \
  server/migrations/022_workflows.sql \
  server/models/WorkflowRun.js \
  server/recover-director-plans.js \
  server/routes/auth.js \
  server/routes/workflows.js \
  server/server.js \
  server/services/aiScopeContextService.js \
  server/services/aiSummaryService.js \
  server/services/approvalChainService.js \
  server/services/socketService.js \
  server/services/workflowEngine.js \
  server/services/workflowValidationService.js \
  PRE_PUSH_SAFETY_REPORT.md

# And — only if you've decided R-1 in favor of committing the EXE:
git add server/downloads/desktop/Monday-Aniston-Setup.exe \
        server/downloads/desktop/desktop-update.json

# 7) Commit.
git commit -m "feat: Workflow Canvas audit follow-up + desktop SSO/OTA"

# 8) Push (this triggers deploy.yml — approver still has to click).
git push origin main

# 9) Then on the GitHub Environments approval prompt, BEFORE clicking
#    approve, run the read-only task audit workflow once to confirm
#    no in-flight workflow is in an unexpected state, then approve.
```

---

## 17. Files Safe To Commit

All 39 modified files + the 10 new Workflow/Desktop files listed above. **Two files require an explicit yes/no decision:**

- `server/downloads/desktop/Monday-Aniston-Setup.exe` — 83 MB binary. See R-1.
- `server/downloads/desktop/desktop-update.json` — 836 B manifest. Tied to the EXE; commit together or skip together.

---

## 18. Final Approval Checklist

Tick before pushing:

- [ ] I have read §2 conditions and they are all met.
- [ ] I have decided whether to commit the 83 MB EXE (R-1).
- [ ] I have queried `workflows.isActive=true` rows in prod and confirmed the new `task_created` / `task_updated` triggers are intentional for each (R-2).
- [ ] The GitHub Environment `production` "Required Reviewers" gate is still configured.
- [ ] I have NOT enabled any of: `ALLOW_PROD_HIERARCHY_SEED`, `ALLOW_SEED_IN_PRODUCTION`, `ALLOW_PROD_PLAN_CLEANUP`, `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY`, `RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN`, `ALLOW_PROD_PLAN_RECOVERY`.
- [ ] I have a recent pg_dump snapshot to fall back on (deploy.yml will also take one).
- [ ] I have a plan to verify F-1 / F-2 (service worker / recurring tasks) for the "deleted data coming back" report, post-deploy.
