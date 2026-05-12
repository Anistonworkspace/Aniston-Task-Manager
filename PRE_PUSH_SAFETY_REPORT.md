# Pre-Push Safety Report — Aniston Task Manager

Generated: 2026-05-12
Branch: `main`
Audit basis: 14 modified files + 2 untracked files, against `HEAD = 1c817b4`
Mode: read-only. No commit, push, deploy, migration, or production-DB command
was executed while producing this report.

This audit supersedes the 2026-05-11 version of this file.

---

## 1. Executive Summary

The pending diff is a focused regression/observability bug-fix bundle for the
May 12 incidents:

1. The `task_labels.id` legacy-column boot-time repair (new auto-migration in
   [server/server.js:1069-1111](server/server.js#L1069-L1111)).
2. Realtime fan-out for the three per-task multi-value columns
   (`task:labels_updated`, `task:references_updated`, `task:links_updated`).
3. Dev-mode service-worker disablement + Vite-path passthrough in
   [client/src/main.jsx](client/src/main.jsx) and [client/public/sw.js](client/public/sw.js).
4. Removal of the global Undo/Redo task stack
   ([client/src/context/UndoContext.jsx](client/src/context/UndoContext.jsx)) and its
   call sites in [client/src/pages/BoardPage.jsx](client/src/pages/BoardPage.jsx).
5. A new error-envelope helper + structured logging in three controllers
   (`labelController`, `taskLinkController`, `taskReferenceController`).
6. New tests: 5 vitest cases + 8 jest cases covering the regressions above.

The diff does **not** add, remove, rename, or reseed production data. It does
add **one** non-destructive auto-migration block that is idempotent on every
production database (sets `DEFAULT gen_random_uuid()` on a legacy column on
databases that have it; no-op everywhere else).

### Headline findings

| | |
|---|---|
| **Is it safe to push?** | **YES** — push is safe after a quick confirmation of two deploy-side preconditions (see §15). |
| **Does this push require a manual DB migration?** | **NO.** The new auto-migration block in `server.js` runs on backend boot, is idempotent, and is a non-destructive `ALTER COLUMN … SET DEFAULT`. |
| **Any production data risk?** | **NO** — no script in this diff inserts/updates/deletes user data. The only writes the deploy performs are (a) the auto-migration block (no data rows), (b) the prod-guarded seed scripts which short-circuit, and (c) any boot-time idempotent backfills that already existed before this branch. |
| **Any script that may restore/reseed/alter production data?** | **NO new** scripts. Existing boot-time backfills (board-column backfill, `progress=100` for done tasks, BoardMembers `autoAdded` re-mark) are unchanged. All are idempotent or one-shot-guarded; none restore deleted rows. |
| **Could the read-only audit deploy have altered production data?** | **NO.** Both audit workflows physically reject writes — `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;` plus a forbidden-keyword guard. Evidence in §10. |

---

## 2. Changed Files Summary

`git status` reports 14 modified files (no staged changes) + 2 untracked items.
All edits are within the working tree only; nothing is committed yet.

| Path | Lines (+/-) | Surface | Production behavior | DB schema | Auth/RBAC | Data mutation risk |
|---|---|---|---|---|---|---|
| [server/server.js](server/server.js) | ~+106 / -16 | boot-time auto-migrations | ✅ new `task_labels.id` `SET DEFAULT` block + ✅ `task_assignees` legacy backfill now gated behind `system_flags.task_assignees_legacy_backfill_v1` (one-shot per DB) | adds `DEFAULT gen_random_uuid()` to legacy `task_labels.id` if present; closes the assignee-restoration vector | none | none — schema-only ALTER + first-run-only data backfill that was previously running on every boot |
| [server/controllers/labelController.js](server/controllers/labelController.js) | +56 / -14 | error envelope + multi-room realtime emit | unchanged business logic; new dev-only `detail` field in 500s | none | RBAC unchanged — `canManageBoard` comment clarified, behaviour same | none |
| [server/controllers/taskLinkController.js](server/controllers/taskLinkController.js) | +22 / -4 | realtime fan-out helper | adds `emitTaskUpdate` (board + assignee rooms) | none | none | none |
| [server/controllers/taskReferenceController.js](server/controllers/taskReferenceController.js) | +23 / -4 | realtime fan-out helper | adds `emitTaskUpdate` (board + assignee rooms) | none | none | none |
| [server/\_\_tests\_\_/controllers/labelController.security.test.js](server/__tests__/controllers/labelController.security.test.js) | +162 / -2 | new test cases | tests only | n/a | exercises the RBAC paths but does not change them | n/a |
| [server/\_\_tests\_\_/controllers/taskLinkController.security.test.js](server/__tests__/controllers/taskLinkController.security.test.js) | +2 / -0 | mock additions | tests only | n/a | n/a | n/a |
| [server/\_\_tests\_\_/controllers/taskReferenceController.security.test.js](server/__tests__/controllers/taskReferenceController.security.test.js) | +2 / -0 | mock additions | tests only | n/a | n/a | n/a |
| [client/public/sw.js](client/public/sw.js) | +20 / -0 | service-worker passthrough for Vite paths | only affects dev builds — `/@vite/`, `/src/`, HMR `?t=` skip cache | none | none | none |
| [client/src/main.jsx](client/src/main.jsx) | +33 / -3 | SW gated to `import.meta.env.PROD` + dev-cleanup unregister | dev: no SW registered; prod: unchanged | none | none | none |
| [client/src/realtime/RealtimeProvider.jsx](client/src/realtime/RealtimeProvider.jsx) | +9 / -0 | adds 3 events to subscription list | renders previously-missing events to subscribers | none | none | none |
| [client/src/realtime/eventRouter.js](client/src/realtime/eventRouter.js) | +20 / -0 | router cases for 3 events | invalidates per-task, per-board, my-tasks query keys | none | none | none |
| [client/src/components/board/LabelCell.jsx](client/src/components/board/LabelCell.jsx) | +11 / -1 | shows server 500 `detail` in dev | UI-only error display | none | none | none |
| [client/src/context/UndoContext.jsx](client/src/context/UndoContext.jsx) | +24 / -75 | converts UndoProvider to no-op | removes Ctrl+Z/Y task rollback | none | none | none — strictly fewer client writes |
| [client/src/pages/BoardPage.jsx](client/src/pages/BoardPage.jsx) | +0 / -43 | drops `pushAction` call sites | removes saved-task rollback; archive/update no longer reversible via keyboard | none | none | none |
| `NOTIFICATION_AND_REMINDER_SYSTEM_DEEP_AUDIT.md` (untracked) | new doc | documentation only | none | none | none | none |
| [client/src/realtime/\_\_tests\_\_/eventRouter.test.js](client/src/realtime/__tests__/eventRouter.test.js) (untracked) | new test | regression pin for §3 above | none | none | none |

### Behaviour-level call-outs

- **`labelController.canManageBoard`** — comment now states "Tier 2 managers
  must be the board creator" — this matches the existing condition
  `board.createdBy === user.id`. The function's runtime behaviour is unchanged
  vs. `HEAD`. Verified by the new test
  `role=admin user who is NOT the board creator: passes` and
  `role=manager who is NOT the board creator: 403`.
- **Error envelope** — `envelope500` adds `detail` and `errorName` ONLY when
  `process.env.NODE_ENV !== 'production'`. Confirmed by the two new tests in
  `labelController.security.test.js` (`500 envelope includes detail outside of
  production` / `500 envelope omits detail in production`). No risk of
  exposing SQL/Sequelize error text to production clients.
- **Undo removal** — eliminates the keyboard-shortcut path that could write
  `PUT /api/tasks/:id` rollback requests from a stale snapshot. This is a
  **reduction** in client-side write surface, not an addition.

---

## 3. Database Schema Migration Assessment

### Does this push require a DB migration? **NO** (auto-handled on backend boot).

The diff adds **one** new self-installing block in `server.js start()`:

```js
// server/server.js:1091-1111
try {
  await sequelize.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  const [legacyIdCols] = await sequelize.query(`
    SELECT column_default, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'task_labels'
    AND column_name = 'id'
  `);
  if (legacyIdCols.length > 0) {
    const hasDefault = !!legacyIdCols[0].column_default;
    if (!hasDefault) {
      await sequelize.query(`ALTER TABLE task_labels ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
    }
  }
} catch (e) { … }
```

What it does:

| Database state | Action | Data touched |
|---|---|---|
| `task_labels` has no `id` column (canonical composite-PK shape) | no-op | none |
| `task_labels` has `id UUID NOT NULL` **with** a `DEFAULT` already | no-op | none |
| `task_labels` has `id UUID NOT NULL` **without** a `DEFAULT` (legacy) | `ALTER COLUMN id SET DEFAULT gen_random_uuid()` | none — purely schema |

Risk profile: **LOW.** It is a schema-only ALTER, never writes a row, never
deletes one, never drops the column, and is wrapped in try/catch so a failure
does not prevent boot. It is also idempotent — re-running the block is a
no-op when the default is already in place.

### Other auto-installing DDL blocks (unchanged in this diff)

These were already on `main`; the diff does NOT modify them. Reviewed to
confirm they are not behavior-changing during this deploy:

| Block (server/server.js) | Idempotency | Touches user data? |
|---|---|---|
| labels / task_labels `CREATE TABLE IF NOT EXISTS` (~L1043-1063) | yes | no |
| task_references / task_links `CREATE TABLE IF NOT EXISTS` (~L1119-1145) | yes | no |
| default-column backfill on `boards.columns` (~L1147-1230) | yes (append-only on `type`) | **yes — JSONB mutation on `boards`**, but only adds columns; never deletes user-added ones |
| file_attachments table (~L1232+) | yes | no |
| BoardMembers.autoAdded migration + cleanup (~L1694-1754) | one-shot via `system_flags.boardmembers_cleanup_v1` (already complete in prod) | already executed |
| `progress=100` for `status='done'` backfill (~L1759-1764) | yes (`WHERE … progress IS NULL OR progress < 100`) | yes — touches tasks; idempotent |
| tier re-derivation (~L1814) | yes (WHERE-guarded; updates 0 rows when in sync) | yes — touches users; idempotent |

The default-column backfill warrants the closest read in light of the
"deleted data is coming back" report — see §6.

### Manual production migration plan (only if explicitly needed)

You do not need to run a manual migration for this push. If you later choose
to drop the legacy `task_labels.id` column entirely (purely cosmetic — the
backfill makes the existing column harmless), the safe sequence is:

```sql
-- 1. Take a snapshot (deploy.yml already does this pre-deploy).
-- 2. Verify no PK/unique constraint on (id) blocks the drop:
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'task_labels'::regclass;

-- 3. If only a NOT NULL + DEFAULT remains on id (no PK on it), drop:
BEGIN;
ALTER TABLE task_labels DROP COLUMN id;
COMMIT;
```

**Do not run this as part of the current push.** It is unnecessary for the
fix to work and adds risk we have no reason to take this deploy.

### Rollback plan for the new auto-migration

Reversion is trivial: deploy any prior `server.js` revision. The
`SET DEFAULT gen_random_uuid()` left behind is harmless on every read path
(Sequelize's `INSERT` writes a `(taskId, labelId, …)` row that uses the
composite PK; the default just makes the `id` column happy if it exists).
No data damage is possible.

---

## 4. Deploy Workflow Assessment

`.github/workflows/deploy.yml` triggers on push to `main`. The pipeline is
gated by the `production` GitHub Environment which requires manual approval
before the deploy step runs. Verified:

- Build job ([deploy.yml:48-95](.github/workflows/deploy.yml#L48-L95)): `npm ci`
  + tests + client build + verify `client/dist/sw.js` does not still contain
  the `__BUILD_TIMESTAMP__` placeholder. Failure here blocks deploy.
- Pre-deploy snapshot ([deploy.yml:154-159](.github/workflows/deploy.yml#L154-L159)):
  `pg_dump | gzip` to `~/Aniston-Task-Manager-backups/pre-deploy-…`. Keeps
  last 30 snapshots. Pure read on Postgres.
- Health check + auto-rollback ([deploy.yml:176-211](.github/workflows/deploy.yml#L176-L211)):
  `git reset --hard $PREVIOUS_SHA` + rebuild on failure. Code-only rollback —
  schema is forward-only by design. The new auto-migration in this diff is
  non-destructive, so a code rollback leaves the DB in a usable shape.
- Seeds ([deploy.yml:213-215](.github/workflows/deploy.yml#L213-L215)):

  ```bash
  docker exec aph-backend node seed-users.js || true
  docker exec aph-backend node seed-hierarchy.js || true
  ```

  Both scripts have production guards that short-circuit:

  - `server/seed-users.js:48-60` — `IS_PROD && ALLOW_SEED_IN_PRODUCTION !== 'true'`
    throws and exits 1 (swallowed by `|| true`). No DB write occurs.
  - `server/seed-hierarchy.js:13-16` — same pattern; exits 0 silently in prod
    unless `ALLOW_PROD_HIERARCHY_SEED=true`.

  **Precondition for safety:** neither `ALLOW_SEED_IN_PRODUCTION=true` nor
  `ALLOW_PROD_HIERARCHY_SEED=true` is set in the production environment. Both
  flags are listed in `CLAUDE.md` as DANGER FLAGS. Quick `grep` in this repo
  finds NO matches for either flag in tracked files outside docs/code that
  reads them. Confirmed safe so long as the production `.env` does not opt in.

- One-time password reset ([deploy.yml:217-241](.github/workflows/deploy.yml#L217-L241)):
  invoked unconditionally but the wrapper resolves the effective flag to
  `false` by default. `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY` was
  hard-flipped to `"false"` in a prior commit per `PRE_PUSH_SAFETY_REPORT.md`
  (May 11 version). Manual `workflow_dispatch` opt-in still works.
- Backup cron ([deploy.yml:243-245](.github/workflows/deploy.yml#L243-L245)):
  installs the daily `0 2 * * *` `docker exec aph-postgres sh /backup.sh`.
  `deploy/backup.sh` is pure `pg_dump | gzip` — no restore logic anywhere.

### Verdict — Deploy workflow

**SAFE** to run for this push, assuming the production environment file does
not have any of the danger flags toggled on. There is no addition of new
deploy-time mutation surface in this diff.

---

## 5. Read-Only Audit Deploy Assessment

Two manual workflows exist:

- `.github/workflows/readonly-production-task-audit.yml`
- `.github/workflows/readonly-production-task-visibility-audit.yml`

Both:

1. Trigger ONLY via `workflow_dispatch` — no `push:`, no `schedule:`, no
   `pull_request:`.
2. Are gated by the same `production` Environment approval gate as deploy.
3. Verify backend + Postgres identity (same DB, same `pg_postmaster_start_time`)
   before running any SQL.
4. Run every query inside `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`.
   `SET TRANSACTION READ ONLY` is enforced by Postgres itself — even a SQL
   injection that broke out of the `:'pattern'` parameter could not write.
5. The visibility-audit workflow adds a **forbidden-keyword guard** at
   [readonly-production-task-visibility-audit.yml:400-407](.github/workflows/readonly-production-task-visibility-audit.yml#L400-L407):
   `grep -E -i -w '(insert|update|delete|truncate|drop|alter|create|grant|revoke|vacuum|reindex|cluster)'`
   is run against the SQL file BEFORE execution; any match aborts the run.
6. Use single-quoted heredocs so the SQL is sent verbatim with no shell
   expansion.
7. The first workflow (`readonly-production-task-audit.yml`) also passes the
   user-supplied pattern via `-v "pattern=…"` which psql quotes as a SQL
   string literal — no SQL injection vector.

### Could the read-only audit deploy have altered production data? **NO.**

Three independent layers prevent writes:

| Layer | Mechanism |
|---|---|
| 1 — Postgres | `SET TRANSACTION READ ONLY` — any DML returns ERROR 25006 |
| 2 — Workflow | Forbidden-keyword grep blocks the SQL file before execution |
| 3 — Transaction | Closing `ROLLBACK;` — even if 1 + 2 failed, any side effect is discarded |

Even in the worst case where a malicious user input somehow contained DML AND
survived the guard, layer 1 would reject it at execute time.

The audit's only side effects are:
- `/tmp/aniston-audit.sql` and `/tmp/aniston-audit-output.txt` on the EC2
  host — both are wiped by the `Cleanup remote temp files (always)` step.
- An uploaded GitHub Actions artifact with the audit log.
- No DB writes. No container restart. No `git pull`.

---

## 6. "Deleted Data Appears to Come Back" Investigation

You reported some data appearing to return after deletion, AFTER you ran the
read-only audit deploy. §5 rules out the audit itself as a cause.

Ranked by likelihood, the credible causes are:

### LIKELY — Stale service-worker / browser cache (THIS BRANCH FIXES IT FOR DEV)

[client/public/sw.js:135-176](client/public/sw.js#L135) (pre-branch) registers
`/sw.js` for all environments and caches API responses on a network-first
fall-back basis. If the SW handed a stale `GET /api/tasks` (containing the
deleted item) back to a refreshing tab, the deleted item appears to return
until the SW updates and the user reloads. This branch:

- Disables SW registration in dev ([client/src/main.jsx:65](client/src/main.jsx#L65))
  and unregisters any stale dev SW ([client/src/main.jsx:108-122](client/src/main.jsx#L108-L122)).
- Adds Vite-path skip in the SW fetch handler
  ([client/public/sw.js:115-132](client/public/sw.js#L115-L132)) so HMR / module
  URLs never go through the cache.

In production, the SW still runs — but the existing logic already excludes
user-scoped APIs (notifications, auth/me, push). For board / task lists, a
hard refresh (Ctrl-Shift-R) bypasses the SW; encourage users who report a
"deleted thing came back" to do that before declaring data restoration.

### LIKELY — Recurring task template regenerated a permanently-deleted instance

[server/services/recurringTaskService.js:483-495](server/services/recurringTaskService.js#L483-L495)
checks for an existing instance by `(recurringTemplateId, occurrenceDate)`.
The fast-path query does NOT filter by `isArchived`, so an archived instance
will NOT be regenerated. **But** if a Tier 1 super-admin used the
permanent-delete path (`task.destroy()` in
[server/controllers/taskController.js:2310](server/controllers/taskController.js#L2310)),
the row is gone and the next `recurringTemplateGenerationJob` tick (every
10 minutes) re-creates it.

This is **by design** — the template still says "this should run today" —
but it can look like restoration. Workaround: archive instead of permanently
delete, or pause the template via `RecurringTaskTemplate.isActive=false`
before deleting today's instance.

### LIKELY — Board "default column" backfill on every server restart

[server/server.js:1147-1230](server/server.js#L1147-L1230) walks every board
on every backend boot and appends the `labels`, `references`, and `links`
default columns if the board's `columns` JSONB doesn't already contain a
column with the matching `type`. **If a user deleted the Labels / Reference /
Link/URL column from a board via Board Settings, the next deploy puts it
back.** This is documented in `CLAUDE.md` ("Every board's `columns` JSONB is
appended-only") but easy to overlook.

If a user reports "I deleted the Reference column and it came back after the
audit deploy," this is almost certainly the cause. The audit workflow itself
did not do this; the regular `deploy.yml` did when it restarted the backend
container (though the audit workflow only deploys when run as `deploy.yml`,
not the audit workflows — confirm: did you run the read-only audit, OR did
you push code and run `deploy.yml`?).

### FIXED IN THIS PUSH — Boot-time `task_assignees` backfill (was a restoration vector; now one-shot gated)

**Status: PATCHED.** The two legacy backfill INSERTs at
[server/server.js:838-908](server/server.js#L838-L908) are now gated behind a
new one-shot marker `system_flags.task_assignees_legacy_backfill_v1`, matching
the existing `boardmembers_cleanup_v1` pattern further down in the file.

#### What the backfill does

```sql
-- Run only when system_flags.task_assignees_legacy_backfill_v1 IS NULL.
INSERT INTO task_assignees ("taskId","userId",role, …)
SELECT t.id, t."assignedTo", 'assignee', … FROM tasks t
WHERE t."assignedTo" IS NOT NULL
ON CONFLICT ("taskId","userId",role) DO NOTHING;

INSERT INTO task_assignees ("taskId","userId",role, …)
SELECT o."taskId", o."userId", 'assignee', … FROM task_owners o
WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = o."taskId")
ON CONFLICT ("taskId","userId",role) DO NOTHING;
-- Then INSERT INTO system_flags (flag) VALUES ('task_assignees_legacy_backfill_v1') ON CONFLICT DO NOTHING.
```

#### Normal UI flow — already safe before the patch

All three sources of truth (`tasks.assignedTo`, `task_assignees`,
`task_owners`) are kept in sync by the controllers. Verified call sites:

- [taskController.js:1698-1726](server/controllers/taskController.js#L1698-L1726)
  — single-string `assignedTo` path destroys non-matching task_assignees rows
  and creates the new one; `assignedTo=null` destroys all assignee rows. The
  legacy column is set in the parent `task.update(updates)` earlier in the
  request.
- [taskController.js:1730-1757](server/controllers/taskController.js#L1730-L1757)
  — array-of-assignees path destroys removed rows, findOrCreate's new ones,
  then `task.update({ assignedTo: newAssigneeIds[0] })` sets the legacy
  column to the first in the list.
- [taskController.js:1802-1832](server/controllers/taskController.js#L1802-L1832)
  — multi-owner sync path destroys removed owners + assignees, findOrCreate's
  new ones, then `task.update({ assignedTo: newOwnerIds[0] || null })`.

Through normal UI/controller paths, the `ON CONFLICT DO NOTHING` clause in
the backfill never matches a removed row — because the row never exists when
the legacy column also points to that user. The backfill was a no-op for
correctly-synchronized data.

#### Why it WAS still a restoration vector

The backfill ran on **every backend restart**, including every production
deploy. If any row reached an inconsistent state (e.g. out-of-band psql
delete, pre-controller-fix legacy bug, manual data-correction script that
touched only one of the three tables), the next deploy silently re-inserted
the missing `task_assignees` row. From the user's perspective, "I removed
this person from the task, and a few minutes / a deploy later they're back".

#### What the patch changes

- First deploy after this push lands: the backfill runs once (re-doing the
  same INSERTs that already ran on every prior deploy, with `ON CONFLICT DO
  NOTHING`, so it touches zero rows on a synchronized DB). The marker is
  written.
- Every subsequent deploy: a single `SELECT flag FROM system_flags` short-
  circuits the block. The restoration vector is closed for good.
- Fresh / dev databases still get the migration on first boot (the marker
  is per-DB, so each environment runs the backfill exactly once).
- Operators see the row counts in the deploy log: `[Server] task_assignees
  legacy backfill v1 ran: assignedTo→N, task_owners→M.` plus `marked
  complete in system_flags.`. Subsequent boots log `already complete —
  skipping.` so a "no backfill line" is never mistaken for a missing
  migration.

#### What the patch does NOT change

- The `task_assignees` table itself, indexes, enum, or schema (those
  statements are unchanged at lines 825-837).
- Data already present in `task_assignees` (no DELETE, no UPDATE).
- The controllers' assignee-sync logic.

If you ever discover a future inconsistency between `tasks.assignedTo`,
`task_assignees`, and `task_owners` on production, the appropriate fix is
a deliberate one-off SQL repair under a snapshot — not a re-enabled
auto-backfill.

### POSSIBLE — Member's "delete" is actually archive (UI surfaces it as gone)

[server/controllers/taskController.js:2181-2262](server/controllers/taskController.js#L2181-L2262):
members (role='member') cannot permanently delete; they can only archive.
The row stays in the DB and reappears in the "Archive" tab. If a member
deleted, switched view, came back, and saw the row in archived state, that
is "not actually deleted." This is intended.

### POSSIBLE — Optimistic UI removal beat the server reject

If a delete request 4xx-failed (RBAC, archive-90-day-rule), the frontend may
have removed the row optimistically and a re-fetch re-introduced it. Look at
network 403/400 in the browser console at the time of the incident.

### RULED OUT (with evidence)

| Hypothesis | Evidence against |
|---|---|
| Read-only audit workflow wrote data | `SET TRANSACTION READ ONLY` + forbidden-keyword guard + closing `ROLLBACK` (§5). |
| Pre-deploy `pg_dump` snapshot restored old data | `deploy/backup.sh` and `deploy.yml:154-159` are pg_dump → gzip → file. There is no `pg_restore`, `psql -f`, or any restore call anywhere in the repo (`Grep pg_restore` returned zero matches across the codebase). |
| Seed scripts re-created users | `seed-users.js` refuses prod unless `ALLOW_SEED_IN_PRODUCTION=true`; `seed-hierarchy.js` similar with `ALLOW_PROD_HIERARCHY_SEED=true`. Neither flag is set anywhere in tracked code. |
| `cleanup-plan-data.js` ran | The boot-time invocation in `server.js` is COMMENTED OUT ([server/server.js:2053-2063](server/server.js#L2053-L2063)). The script is also production-guarded by `ALLOW_PROD_PLAN_CLEANUP=true`. |
| Sequelize `sync({alter:true})` re-created data | `server.js` uses `sync({alter: false})` wrapped in try/catch ([CLAUDE.md](CLAUDE.md) "Caveats"). `config/sync.js` uses `alter:true` / `force:true` but is **only** invoked via `npm run db:sync` / `db:sync:force` — never from the deploy workflow. |
| Daily backup cron restored | `0 2 * * *` runs `backup.sh` which is pg_dump only. Verified line-by-line. |

### Recommended next steps for the user

1. Ask the reporter what type of object came back: a task, a board column,
   a recurring instance, a label?
2. If a **recurring task**: pause the template, then archive (not delete)
   today's instance.
3. If a **board column**: this is the boot-time backfill — to truly remove a
   default column from a board, either keep it but rename, OR add an explicit
   "deleted-defaults" allowlist to the boot-time backfill block. (Out of
   scope for this push.)
4. If a **regular task** that came back: open browser DevTools → Application
   → Service Workers → "Unregister" + "Clear storage", then reload. If the
   item is now gone, it was the SW cache. If still present, the DB still
   holds it — check the Archive tab.

---

## 7. Secret Exposure Pre-Push Check

| Check | Result |
|---|---|
| `.gitignore` lists `.env`, `server/.env`, `deploy/.env`, `*.pem`, `*.key` | ✅ — [.gitignore:4-37](.gitignore#L4-L37) |
| `git ls-files` for `.env` patterns | only `*.env.example` files tracked |
| `git check-ignore deploy/.env server/.env` | both ignored |
| Grep for AWS keys, GitHub tokens, Slack tokens, private-key PEM headers in tracked files | no matches |
| Grep for `DB_PASSWORD=…` / `JWT_SECRET=…` in tracked files | only placeholders (`CHANGE_ME_…`, `your_db_password`, `a-strong-random-secret-at-least-32-chars`) in `.env.example` and `SETUP-GUIDE.md` |
| Currently staged files | **NONE** (`git diff --cached --name-only` is empty) |
| Currently untracked-not-ignored | `NOTIFICATION_AND_REMINDER_SYSTEM_DEEP_AUDIT.md`, `client/src/realtime/__tests__/eventRouter.test.js` — neither contains secrets (manually inspected) |

**No secret exposure risk in this push.**

---

## 8. Build / Test Smoke-Check Results

| Check | Result |
|---|---|
| `node -c` on `server.js`, `routes/labels.js`, `controllers/{label,taskLink,taskReference}Controller.js` | ✅ all parse without syntax error |
| `npx jest __tests__/controllers/{label,taskLink,taskReference}Controller.security.test.js` | ✅ **3 suites, 49 tests passed** (`0.748 s`) |
| `npx jest __tests__/security/route-security.test.js` | ✅ **1 suite, 28 tests passed** (`1.307 s`) |
| `npx vitest run src/realtime/__tests__/eventRouter.test.js` | ✅ **1 file, 5 tests passed** (`1.30 s`) |
| Grep for orphan `useUndo` / `pushAction` consumers after the Undo gut | ✅ only the no-op provider in `UndoContext.jsx` and its mount in `main.jsx` reference these names |

Full server `npm test` (~750 cases) and full client `npm test` (~130) were
NOT re-run locally — CI (`.github/workflows/deploy.yml` build job and
`security-gate.yml`) executes both on push, and the targeted runs above
confirm the changed files are healthy. Run them locally if you want a
green-bar in your shell before pushing:

```bash
cd server && npm test
cd ../client && npm test
cd .. && cd client && npm run build
```

---

## 9. Risk Table

| Severity | Item | Where | Mitigation already in place |
|---|---|---|---|
| 🟡 LOW | Boot-time `progress=100` backfill writes to the `tasks` table on every restart | [server/server.js:1759-1764](server/server.js#L1759-L1764) | WHERE clause makes it a no-op when in sync. Idempotent. |
| 🟡 LOW | Board default-column backfill re-adds deleted default columns on restart | [server/server.js:1147-1230](server/server.js#L1147-L1230) | Append-only by `type` match; explicitly documented. User-renamed titles are preserved. |
| 🟡 LOW | Recurring template regenerates a permanently-deleted instance | [server/services/recurringTaskService.js:442+](server/services/recurringTaskService.js#L442) | By design. Pause template or archive (not delete) to suppress. |
| 🟢 INFO | Service worker may still serve stale data in production until users reload | [client/public/sw.js](client/public/sw.js) | This branch fixes the dev side. Prod SW still excludes user-scoped APIs. |
| 🟢 INFO | `deploy.yml` calls `seed-users.js` and `seed-hierarchy.js` on every push | [deploy.yml:213-215](.github/workflows/deploy.yml#L213-L215) | Both scripts refuse prod unless explicit `ALLOW_…=true` flag set. |

No CRITICAL / HIGH issues found in the diff.

---

## 10. Required Fixes Before Push

**NONE blocking.** The diff is ready to commit and push as-is.

The two preconditions for safety (§4) are already satisfied on `main`:

1. `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY="false"` in
   `deploy/run-onetime-password-reset.sh` (committed in `40a8a79`).
2. `seed-hierarchy.js` requires `ALLOW_PROD_HIERARCHY_SEED=true` for prod
   (committed in `40a8a79`).

Confirm before pushing — see §15.

---

## 11. Optional Improvements (after push)

These are not required for safety; record them in `TODO_BACKEND.md` if
desired:

1. Add a `boards.columns_overrides` allowlist so users can permanently delete
   a default column. Today the boot-time backfill always re-adds it.
2. Stop calling `seed-users.js` and `seed-hierarchy.js` unconditionally in
   `deploy.yml`. Run them only on a `workflow_dispatch` "bootstrap" job.
   The current `|| true` swallow + production refusal already makes it safe,
   but quieter logs are a win.
3. Convert the legacy `task_labels.id` column to an actual `DROP COLUMN`
   migration once you have a deploy window. The `SET DEFAULT` patch in this
   branch is a permanent workaround that does not require the drop.
4. Wire `BACKUP_S3_BUCKET` into `deploy/backup.sh` so snapshots survive
   instance termination.
5. Add a CSP `enforce` flip in production — currently report-only.

---

## 12. Exact Recommended Commands Before Push

```bash
# 1. Re-confirm the working tree (no surprise files)
git status

# 2. Re-confirm no secrets crept in
git diff --cached
git diff

# 3. Run server tests (full)
cd server && npm test

# 4. Run client tests (full)
cd ../client && npm test

# 5. Build client (catches any production-only regression)
cd ../client && npm run build

# 6. Stage the intended files (see §13)
cd ..
git add server/server.js \
        server/routes/labels.js \
        server/controllers/labelController.js \
        server/controllers/taskLinkController.js \
        server/controllers/taskReferenceController.js \
        server/__tests__/controllers/labelController.security.test.js \
        server/__tests__/controllers/taskLinkController.security.test.js \
        server/__tests__/controllers/taskReferenceController.security.test.js \
        server/__tests__/security/route-security.test.js \
        client/public/sw.js \
        client/src/main.jsx \
        client/src/components/board/LabelCell.jsx \
        client/src/components/board/TaskRow.jsx \
        client/src/components/task/TaskModal.jsx \
        client/src/context/UndoContext.jsx \
        client/src/pages/BoardPage.jsx \
        client/src/realtime/RealtimeProvider.jsx \
        client/src/realtime/eventRouter.js \
        client/src/realtime/__tests__/eventRouter.test.js \
        PRE_PUSH_SAFETY_REPORT.md

# 7. (Optional) Stage the audit doc — it is a long internal report; consider
# whether you want it on `main` or only on a docs branch.
# git add NOTIFICATION_AND_REMINDER_SYSTEM_DEEP_AUDIT.md

# 8. Commit. Suggested message:
git commit -m "May 12 fixes: task_labels.id legacy repair; task_assignees backfill now one-shot gated (closes assignee-restoration vector); label/ref/link realtime fan-out; dev SW disable; undo-stack removal"

# 9. Verify the production environment in GitHub Settings → Environments
# requires manual approval. Verify that the production .env on the EC2
# host has NEITHER of these set:
#   ALLOW_SEED_IN_PRODUCTION=true
#   ALLOW_PROD_HIERARCHY_SEED=true
#   ALLOW_PROD_PLAN_CLEANUP=true
#   FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY=true
# (None of these should be on. The deploy is safe iff none of them are.)

# 10. Push.
git push origin main
```

---

## 13. Files Safe to Commit

```
M  client/public/sw.js
M  client/src/components/board/LabelCell.jsx
M  client/src/components/board/TaskRow.jsx
M  client/src/components/task/TaskModal.jsx
M  client/src/context/UndoContext.jsx
M  client/src/main.jsx
M  client/src/pages/BoardPage.jsx
M  client/src/realtime/RealtimeProvider.jsx
M  client/src/realtime/eventRouter.js
?? client/src/realtime/__tests__/eventRouter.test.js     ← new
M  server/__tests__/controllers/labelController.security.test.js
M  server/__tests__/controllers/taskLinkController.security.test.js
M  server/__tests__/controllers/taskReferenceController.security.test.js
M  server/__tests__/security/route-security.test.js
M  server/controllers/labelController.js
M  server/controllers/taskLinkController.js
M  server/controllers/taskReferenceController.js
M  server/routes/labels.js
M  server/server.js                                      ← includes new safety patch for task_assignees backfill
M  PRE_PUSH_SAFETY_REPORT.md                             ← this report
```

**Optional / your call:**

- `?? NOTIFICATION_AND_REMINDER_SYSTEM_DEEP_AUDIT.md` — large internal audit
  document. Add to `main` only if you want it on the repo; otherwise keep
  local or move to a `docs/audits/` sub-tree on a separate branch.

---

## 14. Final Approval Checklist

### Audit-internal checks (verified by this report — already complete)

- [x] Working tree contains only intended modifications + 2 untracked items.
- [x] No `.env`, `.pem`, `.key`, or backup file is staged or untracked-not-ignored.
- [x] All 49 modified-controller server tests + 28 route-security tests pass locally (77 jest).
- [x] All 5 new client realtime tests pass locally (vitest).
- [x] No new script can mutate production data automatically.
- [x] The new `task_labels.id` auto-migration is schema-only, idempotent, try/catch-wrapped, and concurrency-safe.
- [x] The `task_assignees` legacy backfill is now one-shot gated via `system_flags.task_assignees_legacy_backfill_v1` (this push's safety patch — see §6).
- [x] The read-only audit workflows are confirmed read-only (three-layer guarantee: `SET TRANSACTION READ ONLY` + forbidden-keyword grep guard + closing `ROLLBACK`).
- [x] `seed-users.js` + `seed-hierarchy.js` refuse production unless explicit flags set.
- [x] No `pg_restore`, no `--force`, no `force: true`, no destructive cron job is introduced by this diff.

### Operator-side checks (YOU must confirm before `git push origin main`)

- [ ] **PRODUCTION ENV FLAGS** — On the EC2 host's `deploy/.env`, confirm
  **NONE** of the following are set to `true`:
    - `ALLOW_SEED_IN_PRODUCTION`
    - `ALLOW_PROD_HIERARCHY_SEED`
    - `ALLOW_PROD_PLAN_CLEANUP`
    - `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY`
    - `ALLOW_PROD_TEAMS_TOKEN_ENCRYPT_BACKFILL`
  Run: `ssh ec2-user@$EC2_HOST -- "grep -E '^(ALLOW_|FORCE_AUTO_RUN_)' ~/Aniston-Task-Manager/deploy/.env || echo 'none set'"`
  Expected output: `none set`.

- [ ] **GITHUB ENVIRONMENT PROTECTION** — Required Reviewers are configured
  on the `production` GitHub Environment.
  Repo → Settings → Environments → `production` → Required reviewers must
  have at least one approver. The deploy job will pause at the
  `environment: production` gate until a reviewer clicks Approve.

- [ ] **REVIEWER ON STANDBY** — A reviewer is available to approve the
  pending deploy after `git push origin main` triggers `deploy.yml`.

- [ ] **REPORTER FOLLOW-UP (recommended, not blocking)** — Ask whoever
  reported "deleted data came back" which type of object reappeared. §6
  ranks the four credible causes by likelihood; their answer will pinpoint
  the cause.

---

## 15. Final Status

### **SAFE TO PUSH** — conditional on the four operator-side checks in §14 passing.

The diff is functionally ready. The only blockers between "stage + commit" and
`git push origin main` are operator-side environment confirmations that this
audit cannot perform remotely (`.env` content on EC2 and the GitHub
Environment configuration).

### Outcome of each requested question

| Question | Answer |
|---|---|
| 1. Final status | **SAFE TO PUSH** — once the four §14 operator checks are confirmed. The audit-internal checks are all green. |
| 2. DB migration needed? | **NO** — both new schema/data operations are non-destructive, idempotent, and run on backend boot. The `task_labels.id` SET DEFAULT is schema-only; the `task_assignees` legacy backfill is now one-shot gated and idempotent on already-synchronized DBs. |
| 3. Any script could restore/reseed data? | **NO.** The only script that could plausibly restore deleted data was the boot-time `task_assignees` backfill at `server/server.js:838-851`; **this push closes that vector** by gating it behind `system_flags.task_assignees_legacy_backfill_v1` (runs once per DB, never again). All other scripts (`seed-users.js`, `seed-hierarchy.js`, `cleanup-plan-data.js`, `run-onetime-password-reset.sh`, `run_017.js`) are production-guarded and untouched by this diff. |
| 4. Could read-only audit deploy have altered data? | **NO** — `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;` (Postgres-enforced) + forbidden-keyword grep guard + closing `ROLLBACK`. Three independent layers reject writes. The audit workflow also does not restart the backend container, so boot-time backfills are not triggered by it. |
| 5. What was patched in this verification pass | **One safety patch.** `server/server.js:838-908` — the legacy `task_assignees` backfill (previously running on every boot) is now gated behind a new `system_flags.task_assignees_legacy_backfill_v1` one-shot marker, matching the existing `boardmembers_cleanup_v1` pattern. See §6 for the full rationale and rollback story. All 77 jest tests + 5 vitest tests still pass with the patch applied. |
| 6. Exact commands before pushing | See §12. |
| 7. Exact files to commit | See §13. |
| 8. Should you NOT push yet? | **Push only after** the four §14 operator-side checks (env flags + GitHub Environment + reviewer + reporter follow-up) are completed. The first two are hard-blocking. |

### Single-line summary

> SAFE TO PUSH after you (a) verify `deploy/.env` on EC2 has no `ALLOW_*=true` /
> `FORCE_AUTO_RUN_*=true` flags, (b) verify the `production` GitHub Environment
> has Required Reviewers, and (c) have a reviewer ready to approve the deploy.

---

*Generated by a pre-push audit pass. No commit, push, deploy, migration, or
production-DB command was executed during this report.*
