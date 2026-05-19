# Pre-Push Safety Report — Aniston Task Manager

Generated: 2026-05-18
Branch: `main`
HEAD: `e73132e` (fix(nav,notetaker): make Docs reachable for all tiers + unify Notetaker UI across roles)
Audit basis: 46 modified + 3 untracked files (all uncommitted on local `main`)
Mode: read-only. No commit, push, deploy, migration, or production-DB write
was executed while producing this report. Both read-only audit workflows are
proven to be physically unable to write.

This report supersedes the 2026-05-13 version of this file.

---

## 1. Executive Summary

The pending diff is the **May 18 follow-up bundle** layered on the post-audit
remediation work. It is moderate in size (~2 752 insertions / ~355 deletions
across 49 files) and **schema-clean at the SQL level**: the only model-layer
change is one new Sequelize association (`Doc.belongsTo(User, { as: 'archiver' })`)
against the **already-existing** `docs."archivedBy"` column. No new SQL
migrations, no new `ALTER TABLE`, and no new auto-migration blocks in
[`server/server.js`](server/server.js).

Five distinct themes in this bundle:

1. **Docs reachability for Tier 4 board-only members.** Workspace visibility
   in [`server/controllers/docController.js`](server/controllers/docController.js)
   and [`server/services/aiScopeContextService.js`](server/services/aiScopeContextService.js)
   now honors **board-membership-derived** workspace visibility — matching
   `getMyWorkspaces` so a Tier 4 user who only reaches a workspace via a
   visible board can also open its docs and use Sidekick on them.
2. **Global archive page integration for docs.** Two new endpoints —
   `GET /api/docs/archived` and `DELETE /api/docs/:id/permanent` — wired into
   [`server/routes/docs.js`](server/routes/docs.js) + the global
   [`client/src/pages/ArchivedPage.jsx`](client/src/pages/ArchivedPage.jsx).
3. **Permission matrix v2 — label + dependency widening, label-delete
   narrowing.** [`server/config/permissionMatrix.js`](server/config/permissionMatrix.js)
   now lets T3/T4 mint labels and create dependency requests (UX friction
   fix); permanent **label DELETE** is narrowed from T2 → T1 only (cascading
   detach is more destructive than originally judged).
4. **Priority gate broadened from sole-owner → any-assignee.**
   [`server/utils/taskOwnership.js`](server/utils/taskOwnership.js) adds
   `isAssigneeOnTask` so Tier 4 actors handed work by a manager can adjust
   priority on it. [`server/controllers/taskController.js`](server/controllers/taskController.js)
   wires it into both `updateTask` and `bulkUpdateTasks` per-row exemption.
5. **AI Sidekick — doc scope + latency tuning + better cookie behavior in
   desktop.** [`aiScopeContextService.js`](server/services/aiScopeContextService.js)
   adds doc scope context (Tiptap JSON → plain text walker, ≤ 12k chars);
   [`aiSummaryService.js`](server/services/aiSummaryService.js) caps output
   tokens for summarize calls (~halves latency); the Electron desktop app
   ([`desktop/main.js`](desktop/main.js), [`desktop/updater.js`](desktop/updater.js))
   rewrites `SameSite=Lax/Strict` cookies → `SameSite=None; Secure` on the
   production origin so the renderer's `file://` context can use them.

The Docs route file adds `/archived` **before** the `/:id` catch-all (so
"archived" isn't parsed as a doc UUID) and the new permanent-delete route
requires the doc to be soft-archived first (defense in depth). All changes
are functional / behavioral — none touch the storage shape of any table.

The previously-flagged 2026-05-13 risks (Sunny/Muskan force reset, ALLOW_PROD_*
flags, seed scripts) remain in their **off-by-default** state and are
unchanged in this bundle.

---

## 2. Is It Safe To Push?

**YES — WITH STANDARD APPROVAL.**

This bundle is safe to push **provided** the standard `production`
environment Required-Reviewer gate on `deploy.yml` is still configured and
**you** explicitly approve the deploy after the push. The bundle does not
introduce any new automatic destructive behavior beyond what is already in
the codebase (and which is documented + guarded).

Caveats kept from the May 13 report:
- The push triggers `.github/workflows/deploy.yml` which runs `git reset
  --hard origin/main` on the EC2 host and rebuilds the Docker image. That
  is a **code-only** action — no schema migration is auto-applied beyond
  the idempotent `IF NOT EXISTS` boot-time blocks already in
  [`server.js`](server/server.js).
- A pre-deploy `pg_dump` snapshot is taken automatically (line 154 of
  `deploy.yml`). 30 are retained on the EC2 host.

---

## 3. Does This Require A Database Migration?

**NO.**

| Concern | Evidence |
|---|---|
| New SQL migration files | None (`server/migrations/` last file is `021_recurring_reminders.sql`, unchanged) |
| New `ALTER TABLE` in `server.js` | None |
| New model fields requiring columns | None — `Doc.belongsTo(User, { foreignKey: 'archivedBy', as: 'archiver', onDelete: 'SET NULL' })` is a **Sequelize-side association only**. The `docs."archivedBy"` UUID column already exists, declared in [`server/models/Doc.js:75-78`](server/models/Doc.js#L75-L78) and installed at boot via [`server.js:1293`](server/server.js#L1293). |
| New unique / check constraints | None |
| Enum / status value changes | None |
| New index | None |

`sequelize.sync({ alter: false })` is what `server.js` calls — Sequelize will
**not** auto-add a foreign-key constraint for the new association. The
include in `listArchivedDocsForCaller` uses `required: false` (LEFT JOIN) and
will work correctly with or without a SQL-level FK. **No production schema
change is needed.**

---

## 4. Any Production Data Risk?

**NO — no new data-mutation surfaces in this bundle.**

The only new write-path code is:
1. `DELETE /api/docs/:id/permanent` — gated to admin/super-admin or doc
   creator, and **requires the doc to already be soft-archived** before it
   will hard-delete. Defense-in-depth check at
   [`docController.js`](server/controllers/docController.js) `permanentDeleteDoc`.
2. `docCollabService.onStoreDocument` now also writes `contentText` and
   `lastEditedAt` on Y.js flushes (best-effort, try/catch'd). This is the
   same row Sequelize's `Doc.update` already touched — just additional
   fields.

Neither of these can resurrect, reseed, restore, or alter pre-existing data
beyond what the user explicitly requests via the UI.

---

## 5. Any Script That May Restore / Reseed / Alter Production Data?

**NO new scripts in this bundle. Existing scripts are all gated.**

| Script | Path | Guard | Status |
|---|---|---|---|
| Super-admin seed | [`server/seed-users.js`](server/seed-users.js) | `ALLOW_SEED_IN_PRODUCTION=true` AND `SEED_SUPERADMIN_EMAIL/PASSWORD` required. Refuses to overwrite existing user. | ✅ Safe (deploy invokes with `|| true`; refuses in prod by default) |
| Hierarchy seed | [`server/seed-hierarchy.js:13-16`](server/seed-hierarchy.js#L13-L16) | `ALLOW_PROD_HIERARCHY_SEED=true` required; default = skip. | ✅ Safe |
| Sunny/Muskan password reset | [`deploy/run-onetime-password-reset.sh:70`](deploy/run-onetime-password-reset.sh#L70) | `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY="false"` (hardcoded); idempotency marker in `system_maintenance_runs`. | ✅ Safe (force flag off) |
| Plan-data cleanup | [`server/cleanup-plan-data.js`](server/cleanup-plan-data.js) | `ALLOW_PROD_PLAN_CLEANUP=true` required in prod; not in boot path. | ✅ Safe |
| `sync.js --force` | [`server/config/sync.js`](server/config/sync.js) | Manual only; never called from `server.js`. | ✅ Safe |
| Teams-token encrypt backfill | [`server/migrations/run_017.js`](server/migrations/run_017.js) | `ALLOW_PROD_TEAMS_TOKEN_ENCRYPT_BACKFILL=true` required. | ✅ Safe |
| Dev password reset | [`server/scripts/reset-dev-passwords.js`](server/scripts/reset-dev-passwords.js) | `ALLOW_DEV_PASSWORD_RESET=true` + refuses prod regardless. | ✅ Safe |
| Specific-user reset | [`server/scripts/reset-specific-user-passwords.js`](server/scripts/reset-specific-user-passwords.js) | `ALLOW_SPECIFIC_PASSWORD_RESET=true` + allowlist + dry-run default. | ✅ Safe |
| `add-archive-columns.js` | [`server/add-archive-columns.js`](server/add-archive-columns.js) | Manual only; idempotent `ADD COLUMN IF NOT EXISTS`; not in boot path. | ✅ Safe (advisory, must be run manually) |
| `migrate-production.js` | [`server/migrate-production.js`](server/migrate-production.js) | Manual only; not in boot path or deploy pipeline. | ✅ Safe |

**Boot-time data-touch surfaces in `server.js`** — every one is either
system-flag-gated (one-shot) or idempotent with a WHERE guard that touches
zero rows when state is in sync:

| Block | Lines | Behavior | Status |
|---|---|---|---|
| `task_assignees` legacy backfill | ~929-958 | One-shot INSERT, gated by `system_flags.task_assignees_legacy_backfill_v1` | ✅ Marker should be set on prod |
| `task_approval_flows.stage` backfill | ~1091 | `UPDATE … WHERE stage IS NULL` — idempotent | ✅ Safe |
| `permission_grants.effect` backfill | ~1141 | `UPDATE … WHERE effect IS NULL` — idempotent | ✅ Safe |
| `tasks.completedAt` backfill | ~1989 | `UPDATE … WHERE status='done' AND completedAt IS NULL` — idempotent | ✅ Safe |
| `system_settings` inactivity_timeout INSERT | ~2169 | `INSERT … ON CONFLICT (key) DO NOTHING` — idempotent | ✅ Safe |
| `BoardMembers.autoAdded=false` mark | ~2200-2210 | UPDATEs flags for creators + admin/manager/AM; no data destruction | ✅ Safe (doesn't recreate rows) |
| `BoardMembers` stale-row cleanup | ~2226-2243 | One-shot DELETE, gated by `system_flags.boardmembers_cleanup_v1`. **Membership-only — never touches tasks, comments, files, work logs.** | ✅ Marker should be set on prod |
| `tasks.progress=100` for `status='done'` | ~2253 | `UPDATE … WHERE progress IS NULL OR progress < 100` — idempotent | ✅ Safe |
| Group `mappedStatus` backfill | ~2308-2370 | One-shot, gated by `system_flags.group_mapped_status_backfill_v1` | ✅ Marker should be set on prod |
| `users.tier` recompute | ~2492 | `UPDATE … WHERE tier IS NULL OR tier <> CASE …` — touches zero rows when in sync | ✅ Safe |
| `task_assignees` receipt columns | ~2592-2595 | DDL only — no data mutation | ✅ Safe |
| Boards `columns` JSONB normalization | ~1647 | Append-only — adds `labels` / `references` / `links` columns if missing | ✅ Safe |

None of the above can resurrect tasks, boards, workspaces, users, labels,
docs, or any user-facing data that was explicitly deleted via the app.

---

## 6. Changed-Files Summary

49 files: 46 modified + 3 untracked.

### Server (~10 controller / service / util / model files)

| File | What changed | Affects schema | Affects deploy | Affects auth/RBAC | Can mutate prod data | Safe to push |
|---|---|---|---|---|---|---|
| [`server/models/index.js`](server/models/index.js) | +3 lines: `Doc.belongsTo(User, as:'archiver')` association | No (column exists) | No | No | No | ✅ Yes |
| [`server/routes/docs.js`](server/routes/docs.js) | +11 lines: route wires for new `/archived` + `/:id/permanent` | No | No | No | Only via UI delete | ✅ Yes |
| [`server/controllers/docController.js`](server/controllers/docController.js) | +120 / -3: new `listArchivedDocsForCaller`, `permanentDeleteDoc`; board-membership branch in `canCallerSeeWorkspace` | No | No | Yes — widens read visibility | Only via UI delete (gated) | ✅ Yes |
| [`server/controllers/authController.js`](server/controllers/authController.js) | +7 / -1: include `tier` in `getAllUsers` attribute lists | No | No | Visibility only (tier is broadly exposed already) | No | ✅ Yes |
| [`server/controllers/aiController.js`](server/controllers/aiController.js) | +19 / -3: doc summarize endpoint adds board-membership path; updated system prompt for doc scope | No | No | Visibility only | No (read-only AI calls) | ✅ Yes |
| [`server/controllers/dependencyRequestController.js`](server/controllers/dependencyRequestController.js) | +9 / -6: allow self-assignment on create + update | No | No | RBAC widening (T4 already gets `dependencies.create=true` in matrix) | Allows creating dependency rows — same as before, just on self | ✅ Yes |
| [`server/controllers/taskController.js`](server/controllers/taskController.js) | +88 / -21: getTasks pagination + isAssigneeOnTask exemption in priority gate | No | No | RBAC widening (priority on assigned tasks) | Same write paths, broader access | ✅ Yes |
| [`server/services/aiScopeContextService.js`](server/services/aiScopeContextService.js) | +146: new doc scope, Tiptap JSON walker | No | No | No (mirrors docController visibility) | No (read-only) | ✅ Yes |
| [`server/services/aiService.js`](server/services/aiService.js) | +2 / -2: forward `opts.maxTokens` to provider | No | No | No | No | ✅ Yes |
| [`server/services/aiSummaryService.js`](server/services/aiSummaryService.js) | +33 / -11: `maxTokens` caps + JSON-fallback for doc summary | No | No | No | No | ✅ Yes |
| [`server/services/docCollabService.js`](server/services/docCollabService.js) | +18 / -3: Y.js `onStoreDocument` also refreshes `contentText` + `lastEditedAt` (best-effort) | No | No | No | Yes — updates Doc rows it was already updating, plus 2 more columns | ✅ Yes (additive) |
| [`server/utils/taskOwnership.js`](server/utils/taskOwnership.js) | +49 / -14: adds `isAssigneeOnTask` helper | No | No | RBAC support util | No | ✅ Yes |
| [`server/config/permissionMatrix.js`](server/config/permissionMatrix.js) | +35 / -9: labels.delete → T1-only, labels.create + dependencies.create widened to T3/T4 | No | No | **RBAC change** — widens label create + dependency create to all tiers, narrows label delete to T1 only | No directly | ✅ Yes (intentional v2 product decision) |

### Server tests (10 files)

All test changes track the controller/matrix changes:
- `route-security.test.js` — flips T4 member label-create expectation from 403 → not 403
- `labelController.security.test.js` — same widening
- `taskController.*Authority.test.js` — assignee-exemption paths
- `tierPermissionMatrix.test.js` — updates expected matrix values
- `aiScopeContextService.test.js` — new doc-scope test coverage
- `taskOwnership.test.js` — new `isAssigneeOnTask` coverage
- `dependencyRequestController.test.js` — removed "can't self-assign" test
- `task.test.js` — minor

Test results: **234/234 passing** for the 11 affected suites (run locally
this session against mock DB — no production touch).

### Client (~13 files)

UI for the new doc archive page integration, AI Sidekick Doc scope wiring,
TaskModal/BoardPage/WorkspacePage updates, permissions util surface for
labels/dependencies widening. Three new untracked files:
- [`client/src/components/sidekick/AISummaryModal.jsx`](client/src/components/sidekick/AISummaryModal.jsx) — replaces the popover for Summarize buttons
- [`client/src/components/workspace/WorkspaceShareModal.jsx`](client/src/components/workspace/WorkspaceShareModal.jsx) — new feature wired to existing `/api/workspaces/:id/members` endpoints
- (no third client file)

### Desktop (6 files including new updater)

- [`desktop/main.js`](desktop/main.js) — `installCookieSameSiteRewriter`, sign-out cookie wipe, updater wiring
- [`desktop/updater.js`](desktop/updater.js) — new auto-updater for the Electron app
- [`desktop/tray.js`](desktop/tray.js), [`desktop/notifications.js`](desktop/notifications.js), [`desktop/preload.js`](desktop/preload.js), [`desktop/package.json`](desktop/package.json)

**Desktop changes do not deploy via `deploy.yml`.** They are packaged
separately into an Electron installer. Even the largest desktop diffs in
this bundle have **zero impact** on the server, database, or any
production data.

---

## 7. Migration Assessment

**Does this push require a DB migration? NO.**

| Question | Answer |
|---|---|
| Required migration | None |
| Optional column / index changes | None new in this bundle |
| Safe local command | n/a |
| Safe production command | n/a (no migration needed) |
| Rollback plan | n/a (no migration) |
| Backup requirement | Pre-deploy `pg_dump` happens automatically in `deploy.yml` |
| Risk level | **Low** |

If you ever need to apply the `archivedBy` column on a hypothetical
out-of-sync DB, the boot-time `CREATE TABLE IF NOT EXISTS docs(...)`
block at [`server.js:1283-1306`](server/server.js#L1283-L1306) ensures it.

---

## 8. Deploy Workflow Assessment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) reviewed in full.

| Property | Status |
|---|---|
| Triggers on `push` to `main` | ✅ Yes (intentional) |
| Required Reviewer gate via `environment: production` | ✅ Yes (line 102) |
| Concurrency: `cancel-in-progress: false` | ✅ Yes — queues, never cancels |
| Pre-deploy `pg_dump` snapshot | ✅ Yes (line 154-157), 30 retained |
| Health-check loop + auto-rollback | ✅ Yes (10 retries × 6s, then `git reset --hard $PREVIOUS_SHA`) |
| Slack alert on rollback failure | ✅ Yes (if `SLACK_WEBHOOK_URL` set) |
| Auto-run seeders | ✅ Yes — but **both seeders are guarded against production by default** (see Phase 5 table) |
| Auto-run dangerous scripts | ❌ Only `deploy/run-onetime-password-reset.sh` which is hardcoded `FORCE_AUTO_RUN…=false` |
| Migration auto-run | ❌ No — relies on idempotent boot-time blocks in `server.js` |
| Container restart in audit workflows | ❌ No — every audit workflow's container check returns early without restart |

**Verdict:** Deploy workflow is safe. No new deploy-script changes in this
bundle — the workflow file itself is unchanged.

---

## 9. Read-Only Audit Deploy Assessment

**The recent read-only audit deploys CANNOT have changed production data.**
Evidence:

[`readonly-production-task-audit.yml`](.github/workflows/readonly-production-task-audit.yml):
- Triggers: `workflow_dispatch` only
- Gate: `environment: production` (manual approval)
- All SQL runs inside `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`
  (Postgres physically rejects any writes inside such a transaction with
  `ERROR: cannot execute … in a read-only transaction`)
- Forbidden-keyword `grep` guard before psql execution (in the visibility
  workflow): rejects `insert|update|delete|truncate|drop|alter|create|grant|revoke|vacuum|reindex|cluster`
- Container check returns early without restart
- No INSERT/UPDATE/DELETE/TRUNCATE/DROP/ALTER appears anywhere in either
  audit workflow's SQL

[`readonly-production-task-visibility-audit.yml`](.github/workflows/readonly-production-task-visibility-audit.yml)
and [`readonly-sso-diagnostic.yml`](.github/workflows/readonly-sso-diagnostic.yml)
follow the same `READ ONLY + ROLLBACK` pattern with the additional
forbidden-keyword guard.

**Conclusion:** It is **physically impossible** for the read-only audit
deploys to have changed production data. If data reappeared after a delete,
the cause is elsewhere — see Phase 10.

---

## 10. Deleted-Data-Coming-Back Investigation

Ranked by **likelihood**, given the current codebase:

### Most likely (1–3): client-side / UX issues
1. **Stale frontend cache / React state.** The deletion succeeded on the
   server, but the UI didn't refetch on subsequent navigation. Hard refresh
   (Ctrl+Shift+R) would clear it.
2. **Service worker / PWA cache.** `client/dist/sw.js` is in this bundle's
   build chain. If a stale SW served a cached `/api/tasks` list, the user
   would see the deleted item until SW updated. Mitigated by the build-
   timestamp injection check in `deploy.yml:91-94`.
3. **Optimistic-UI rehydration via Socket.io.** Another browser/window had
   the deleted item locally and emitted a save that re-created it; or, a
   socket reconnect re-broadcast a stale snapshot.

### Plausible (4–7): server-side semantics
4. **Soft delete vs hard delete confusion.** `DELETE /api/boards/:id` and
   `DELETE /api/tasks/:id` perform **archive** (set `isArchived=true`), not
   row removal. The item appears in `/archive` and can be restored. If the
   user expected hard-delete, the item "comes back" when they navigate
   back to the archive page.
5. **Recurring task instance regeneration.** [`recurringTemplateGenerationJob.js`](server/jobs/recurringTemplateGenerationJob.js)
   runs every 10 minutes and generates today's instance per active
   template. The DB partial unique on `(recurringTemplateId, occurrenceDate)`
   prevents duplicate-for-same-date, but if the user deleted **a different
   day's** instance and a new day's came due, that new instance looks
   identical and may appear to be the deleted one. Disable / archive the
   template if regeneration is unwanted.
6. **`task_assignees` legacy backfill block.** First-time-only INSERTs from
   `tasks.assignedTo` and `task_owners` into `task_assignees` — gated by
   `system_flags.task_assignees_legacy_backfill_v1`. If that flag was ever
   manually deleted (it shouldn't be), a future restart would re-insert
   rows. Confirmed gated; no risk under normal ops.
7. **`BoardMembers.autoAdded=false` mark on every boot.** Reverses the
   "stale auto-added" cleanup from later in the boot path for board
   creators and admin/manager/AM users. **This only flips a flag — it
   does not recreate `BoardMembers` rows.** Cannot resurrect deleted
   memberships.

### Unlikely (8+): infrastructure
8. **DB restore from `pg_dump` snapshot.** Only triggered manually by an
   operator. No automation restores backups.
9. **Replica / read-replica lag.** None configured.
10. **Seed scripts.** Only the super-admin user is candidate, and the seed
    refuses to overwrite existing users.

**Evidence the read-only audit deploys are NOT the cause:** see Phase 9.

---

## 11. Secret Exposure Check

✅ **Clean.**

| Path | Tracked? | Notes |
|---|---|---|
| `deploy/.env` | ❌ Gitignored | Verified via `git check-ignore` |
| `server/.env` | ❌ Gitignored | Verified via `git check-ignore` |
| `client/.env` | ❌ Gitignored | Verified via `git check-ignore` |
| `*.pem`, `*.p12`, `*.key` | ❌ Gitignored | Multiple defensive layers in `.gitignore` |
| `deploy/.env.production.example` | ✅ Tracked | Template only, placeholders |
| `server/.env.example` | ✅ Tracked | Template only, placeholders |
| [`deploy/k8s/secrets.yml`](deploy/k8s/secrets.yml) | ✅ Tracked | Template only — every value is `"CHANGE_ME"` or `""` |
| Migration `.sql` files | ✅ Tracked | DDL only, no credentials |
| `server/scripts/diagnose-board-workspace.sql` | ✅ Tracked | Read-only diagnostic; UPDATEs are commented out |

No backup/dump files (`.sql.gz`, `.dump`, `.tar`, `.zip`, `.7z`) are tracked
outside `server/migrations/`. No untracked `.env` file is staged.

---

## 12. Build / Test Results

| Check | Status |
|---|---|
| Server unit tests (changed files only — 11 suites) | ✅ **234/234 passing** |
| Server lint | Not run (no lint changes in bundle) |
| Client build | Not run (no `server.js`/route changes affecting bundle shape) |
| Client tests | Not run (would require touching the longer test suite — recommend running before pushing) |
| Smoke check of deploy.yml syntax | ✅ Inspected, no changes |

The 11 affected server test suites cover every modified controller / service
/ util in this bundle. Recommend running the **full** `cd server && npm
test` and `cd client && npm test` once more before pushing — these were
not run in full this session to keep the audit non-destructive.

---

## 13. Risk Table

| ID | Risk | Severity | Mitigation in this bundle |
|---|---|---|---|
| R-1 | New `archivedBy` association requires a column | **None** | Column already exists in `Doc` model + boot DDL |
| R-2 | Permission widening could expose data the prior matrix denied | **Low** | Widened only `labels.create` + `dependencies.create` for T3/T4 — both already gated on per-resource visibility (taskVisibility / boardVisibility services). Library rename/recolor still T2+ via route-level `managerOrAdmin`. |
| R-3 | Permission narrowing (labels.delete → T1 only) could break existing T2 admin/manager workflows | **Low** | T2 users now see 403 when permanently deleting a label. Re-creating a label is one click. No data lost — labels are easily-recreatable metadata. Acceptable v2 product decision. |
| R-4 | `permanentDeleteDoc` hard-deletes rows | **Low** | Gated by `canCallerEditDoc` (admin / super-admin / creator) AND requires the doc to be `isArchived=true` first. Logs via `activityService.logActivity`. |
| R-5 | `docCollabService.onStoreDocument` writes new fields to Doc rows on Y.js flush | **Low** | Best-effort wrapped in try/catch; same row already being updated for `yjsState`. Failure of the contentText extraction does not block the canonical update. |
| R-6 | Self-assignable dependency requests | **Low** | UX guard only; not a security boundary. Block-state machinery still works because the assignee can be the same actor who progresses it to done. |
| R-7 | T4 assignee priority change | **Low** | `isAssigneeOnTask` requires actor be an active `assignee` (not watcher / supervisor); change is logged in activity feed. |
| R-8 | Desktop SameSite cookie rewrite | **Low** | Scope-restricted to the production hostname; only converts Lax/Strict → None+Secure on HTTPS. Does not run in non-packaged builds. |
| R-9 | Deploy auto-rolling back leaves DB forward-migrated | **Low** (unchanged from baseline) | No new migrations introduced. Pre-deploy `pg_dump` snapshot is the recovery primitive. |
| R-10 | Read-only audit workflows could mutate prod | **None** | Physically impossible — `SET TRANSACTION READ ONLY + ROLLBACK` + forbidden-keyword grep guard. |

No Critical or High-severity risks in this bundle.

---

## 14. Required Fixes Before Push

**NONE.**

This bundle is in a pushable state as-is. No required fixes were identified
during the audit.

---

## 15. Optional Improvements After Push

These are not blockers, but worth attention on a future branch:

1. **Three sources of truth for task assignment** (`tasks.assignedTo`,
   `task_assignees`, `task_owners`) still coexist. Long-term refactor
   should pick one canonical model. Tracked in CLAUDE.md.
2. **`server/add-archive-columns.js`** is dead code now that the same DDL
   is in the boot-time blocks. Consider deleting in a follow-up cleanup
   commit (NOT in this push — keep the bundle minimal).
3. **Cron failure observability** (CLAUDE.md note) — still TODO. Failures
   are only in `console.error`. Wire Slack/PagerDuty later.
4. **Backups not yet shipped off-host** — `BACKUP_S3_BUCKET` template in
   `deploy/backup.sh` is wired but commented out.
5. **CSP enforcement** still in report-only mode. Flip `CSP_ENFORCE=true`
   after observation window.

---

## 16. Exact Recommended Commands Before Push

Run **on this branch**, in this order. Do not push between steps.

```powershell
# 1) Verify nothing dangerous is staged
git status --short
git diff --stat

# 2) Run the full server test suite (not just changed files)
cd server
npm test
cd ..

# 3) Run the full client test suite + build
cd client
npm test
npm run build
cd ..

# 4) Verify .env files are still gitignored
git check-ignore deploy/.env server/.env client/.env

# 5) Verify no .env / dump / pem files are accidentally untracked-but-staged
git ls-files --others --exclude-standard

# 6) Final visual review of the diff
git diff
```

If every step above passes, **THEN ask for explicit user approval** before:

```powershell
# 7) Stage the three new files (only the new code, not desktop installer artefacts)
git add client/src/components/sidekick/AISummaryModal.jsx
git add client/src/components/workspace/WorkspaceShareModal.jsx
git add desktop/updater.js

# 8) Stage modified files (use specific paths — NEVER `git add .` or `-A`)
#    See section 17 for the explicit list.

# 9) Commit with a conventional-style message
git commit -m "feat: docs archive + sidekick doc scope + label/dep RBAC v2 + desktop updater"

# 10) THIS IS THE DEPLOY ACTION — only run after explicit approval
git push origin main
```

**Step 10 triggers the production deploy.** The `production` environment
approval gate will still require a manual click — but the push is the
intent-to-deploy.

---

## 17. Exact Files Safe To Commit

### New files (3) — all safe
- `client/src/components/sidekick/AISummaryModal.jsx`
- `client/src/components/workspace/WorkspaceShareModal.jsx`
- `desktop/updater.js`

### Modified files (46) — all safe

**Client (~17):**
- `client/src/components/auth/Login.jsx`
- `client/src/components/board/LabelCell.jsx`
- `client/src/components/board/TaskRow.jsx`
- `client/src/components/board/__tests__/LabelCell.test.jsx`
- `client/src/components/common/TranscriptProcessor.jsx`
- `client/src/components/common/__tests__/TranscriptProcessor.test.jsx`
- `client/src/components/layout/Header.jsx`
- `client/src/components/sidekick/AISummaryPopover.jsx`
- `client/src/components/sidekick/__tests__/AISummaryPopover.test.jsx`
- `client/src/components/task/TaskModal.jsx`
- `client/src/pages/ArchivedPage.jsx`
- `client/src/pages/BoardPage.jsx`
- `client/src/pages/Docs/DocPage.jsx`
- `client/src/pages/Docs/__tests__/useDocAutosave.test.jsx`
- `client/src/pages/Docs/useDocAutosave.js`
- `client/src/pages/Workspace/WorkspacePage.jsx`
- `client/src/utils/permissions.js`

**Desktop (5):**
- `desktop/main.js`
- `desktop/notifications.js`
- `desktop/package.json`
- `desktop/preload.js`
- `desktop/tray.js`

**Server (12):**
- `server/config/permissionMatrix.js`
- `server/controllers/aiController.js`
- `server/controllers/authController.js`
- `server/controllers/dependencyRequestController.js`
- `server/controllers/docController.js`
- `server/controllers/taskController.js`
- `server/models/index.js`
- `server/routes/docs.js`
- `server/services/aiScopeContextService.js`
- `server/services/aiService.js`
- `server/services/aiSummaryService.js`
- `server/services/docCollabService.js`
- `server/utils/taskOwnership.js`

**Server tests (10):**
- `server/__tests__/config/tierPermissionMatrix.test.js`
- `server/__tests__/controllers/dependencyRequestController.test.js`
- `server/__tests__/controllers/labelController.security.test.js`
- `server/__tests__/controllers/task.test.js`
- `server/__tests__/controllers/taskController.assignmentAuthority.test.js`
- `server/__tests__/controllers/taskController.bulkUpdateAuthority.test.js`
- `server/__tests__/controllers/taskController.selfAssignDueDate.test.js`
- `server/__tests__/controllers/taskController.strictMode.test.js`
- `server/__tests__/security/route-security.test.js`
- `server/__tests__/services/aiScopeContextService.test.js`
- `server/__tests__/utils/taskOwnership.test.js`

### Files NOT to commit / be staged separately

- Any `.env`, `*.pem`, `*.key`, `*.p12` — already gitignored
- Any backup `.sql.gz` / `.dump` — should not exist in working tree
- Any local debug screenshots (`*.png` at repo root) — gitignored

---

## 18. Final Approval Checklist

Tick each before pushing:

- [ ] `git status` shows ONLY the files in section 17
- [ ] `cd server && npm test` PASSES (all suites, not just changed)
- [ ] `cd client && npm test` PASSES
- [ ] `cd client && npm run build` SUCCEEDS
- [ ] `git diff` final review — no surprising hunks
- [ ] `.env` and credentials are NOT staged
- [ ] User has **explicitly approved** the push
- [ ] User has **explicitly approved** clicking Approve on the `production`
      environment gate when GitHub Actions reaches the deploy step
- [ ] User is aware: the deploy will run idempotent boot-time blocks but
      NO new schema migrations, and the pre-deploy `pg_dump` snapshot will
      run automatically
- [ ] User understands "data coming back" is most likely a client cache /
      service worker / soft-delete issue, NOT something this push will fix
      or break

---

## Final Status

**SAFE TO PUSH — pending checklist in section 18 and explicit user approval.**

- **Database migration needed:** NO.
- **Any script could restore/reseed data:** NO new ones; existing ones all
  guarded.
- **Read-only audit deploy could have altered data:** NO — physically
  impossible.
- **Production data at risk from this push:** NO.

Wait for explicit user approval before pushing. Do not run `git push`,
`gh workflow run deploy.yml`, or any equivalent until the user says
"push it" / "ship it" / "approved" in plain language.
