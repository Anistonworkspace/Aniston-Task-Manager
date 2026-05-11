# Pre-Push Safety Report — Aniston Task Manager

Generated: 2026-05-11
Branch: `main`
Repository: Aniston-Task-Manager
Scope: pre-push audit + two targeted production-safety fixes.

This report documents the two safety changes that were just applied to the
working tree, the remaining behavior the deploy workflow will perform, and
the exact files to stage before pushing. No commit, push, deploy, or
production-DB command was executed while producing this report.

---

## 1. Changes Made

Two files were modified in the working tree. Both are local-only edits — they
are NOT staged or committed.

### 1.1 `deploy/run-onetime-password-reset.sh`

- `FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY` changed from `"true"` to `"false"`.
- Diff (relevant hunk):

  ```diff
  -FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY="true"
  +FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY="false"
   FORCE_AUTO_RUN_MAINTENANCE_KEY="password-reset-sunny-muskan-auto-2026-05-05"
  ```

- Effect: the deploy workflow still invokes the wrapper after every
  successful health check, but the wrapper now resolves the effective
  flag to `"false"` and exits 0 at Gate 1 with a "PASSWORD RESET DID NOT
  RUN" banner. No `docker exec` is issued and no DB connection is opened.
- Manual execution paths are unchanged:
  - GitHub Actions repository variable
    `RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN=true`
  - `workflow_dispatch` input `run_password_reset_sunny_muskan=true`
  - Either still triggers the reset, with the same dry-run + execute
    sequence and the same `system_maintenance_runs` marker idempotency.
- The script itself was not removed. The maintenance key constant was
  not touched.

### 1.2 `server/seed-hierarchy.js`

A production safety guard was inserted at the top of the file, before any
DB write. Diff:

```diff
 const { sequelize } = require('./config/db');

+// ── Production safety guard ─────────────────────────────────────────────────
+// This script issues raw INSERT/UPDATE statements against `hierarchy_levels`
+// and `users`, including a re-derivation of `users.hierarchyLevel` from
+// `role`. The deploy workflow invokes it unconditionally after a successful
+// health check, which means it would silently overwrite hand-tuned
+// hierarchyLevel values in production on every push to main.
+//
+// Default behavior in production is now SKIP. Set ALLOW_PROD_HIERARCHY_SEED=true
+// to run it intentionally (e.g. for a one-off bootstrap of a fresh prod DB).
+// Local/dev/test environments are unaffected.
+if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_HIERARCHY_SEED !== 'true') {
+  console.log('Skipping hierarchy seed in production. Set ALLOW_PROD_HIERARCHY_SEED=true to run intentionally.');
+  process.exit(0);
+}
+
 const DEFAULT_LEVELS = [
```

- Effect in production (`NODE_ENV=production`):
  - With `ALLOW_PROD_HIERARCHY_SEED` unset or anything other than `"true"`,
    the process logs the skip message and exits 0 before touching the DB.
  - With `ALLOW_PROD_HIERARCHY_SEED=true`, the original behavior runs in
    full (create `hierarchy_levels`, insert defaults, re-derive
    `users.hierarchyLevel` from `role`).
- Effect in local/dev/test (`NODE_ENV` is unset, `development`, or `test`):
  - Existing behavior is preserved. The guard does nothing.
- The original seed logic was not removed or rewritten beyond the guard
  insertion.

---

## 2. Production Safety Result

- **Sunny/Muskan password reset will not auto-force-run on deploy
  anymore.** The hardcoded `FORCE_AUTO_RUN_…="false"` short-circuits the
  wrapper at Gate 1 on every future deploy. Only explicit
  `workflow_dispatch` or repository-variable opt-in can trigger it.
- **Hierarchy seed will not mutate production users/hierarchy by
  default.** Step 8 of the deploy script (`docker exec aph-backend node
  seed-hierarchy.js || true`) still fires, but the script now exits
  early without writing to `hierarchy_levels` or `users` unless
  `ALLOW_PROD_HIERARCHY_SEED=true` is supplied on that container.
- **Production deploy can still trigger automatically after a push to
  `main`.** The `Build & Deploy` workflow in
  `.github/workflows/deploy.yml` is unchanged. Build → SSH → pull →
  rebuild image → restart containers → health check → seed-users.js →
  seed-hierarchy.js (now no-op in prod) → run-onetime-password-reset.sh
  (now no-op in prod) → setup backup cron — all of those still happen
  in that order.
- **No production data was modified during this fix.** All work was
  local file edits and read-only Git commands. No `docker exec`, no
  `psql`, no `npm run`, no script invocation against any database was
  performed.

---

## 3. Database Migration Status

- **No separate or manual DB migration is required before push.** Every
  schema change introduced by this branch has a matching auto-installing
  block in `server/server.js` `start()` that runs at container boot,
  using `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT
  EXISTS`, `DO $$ … IF NOT EXISTS$$` guards for constraints, and
  `WHERE … IS NULL` for backfills. The deploy workflow rebuilds and
  restarts the container, so these blocks land automatically.
- **Stage `server/migrations/016_add_user_language.sql` and
  `server/migrations/run_016.js`** alongside this push. They are
  currently untracked. They are not strictly required (the auto-installing
  block in `server.js` does the same `ADD COLUMN IF NOT EXISTS` +
  `CHECK` constraint), but they are the canonical audit-trail companion
  to the in-server migration and they match the 001–015 pattern already
  in the migrations folder.
- **No Prisma migration is needed.** This project uses Sequelize. The
  repository contains no Prisma schema, no Prisma client output, and no
  `prisma migrate` invocation. Migrations are SQL files in
  `server/migrations/` plus startup-time guarded blocks in
  `server/server.js`.

---

## 4. Remaining Deploy Side Effects

After a push to `main`, the deploy workflow restarts the backend
container. The `start()` function in `server/server.js` will run the
following write-capable blocks on every restart. **None of them deletes
user-authored content like tasks, comments, files, or work logs.** They
do, however, mutate metadata / membership rows in ways worth knowing:

| Behavior | Location | Idempotent? | Can delete user-authored data? |
|---|---|---|---|
| `CREATE TABLE / ADD COLUMN / CREATE INDEX IF NOT EXISTS` for all new tables in this branch (`pending_login_tokens`, `task_references`, `task_links`, `users.language`, etc.) | `server/server.js` startup blocks | Yes (schema-level idempotent) | No |
| Idempotent backfills gated by `WHERE … IS NULL` — `tasks.completedAt`, `tasks.progress=100 WHERE status='done'`, `permission_grants.effect`, `task_approval_flows.stage`, `recurring_task_templates.daysOfMonth`, etc. | various `server/server.js` blocks | Yes (re-running matches 0 rows) | No |
| **`users.tier` re-derivation on every boot** — `UPDATE users SET tier = CASE WHEN isSuperAdmin THEN 1 WHEN role IN ('admin','manager') THEN 2 WHEN role='assistant_manager' THEN 3 ELSE 4 END` | `server/server.js` (~line 1812) | Idempotent given stable `(role, isSuperAdmin)` | No — overwrites any **hand-tuned `tier`** that diverged from the derived value |
| **`BoardMembers.autoAdded` re-marking on every boot** — `UPDATE "BoardMembers" SET "autoAdded"=false` for board creators and for admin/manager/assistant_manager users | `server/server.js` (~lines 1631-1640) | Yes (same rows re-flipped to the same value) | No |
| **`BoardMembers` stale cleanup on every boot** — `DELETE FROM "BoardMembers" WHERE "autoAdded"=true AND user has no active task on that board` | `server/server.js` (~lines 1643-1649) | Yes for the dataset — repeatedly removes rows that meet the predicate | Only removes board-membership rows. **Does not delete tasks, comments, files, or any user-authored content.** A removed user can be re-added by reassignment or via Board Settings. |
| **Board columns backfill on every boot** — append `labels` / `references` / `links` columns to every board's `columns` JSONB, normalize `Link → Link/URL` and `References → Reference` titles | `server/server.js` (~lines 1107-1156) | Effectively idempotent (only appends columns of types the board doesn't already have) | No — append-only; existing user-customised columns and their order are preserved |
| One-time cleanup of `director_plans` + `time_blocks` | `server/cleanup-plan-data.js` invoked from `server/server.js` | Yes — gated by `system_flags.flag = 'cleanup_plan_data_v1'`. After first successful run it is a single `SELECT` that silently exits. | Already ran in prod historically; further runs are no-ops unless the marker is removed. |
| `seed-users.js` invocation in deploy | `deploy/deploy.yml` step `[8/9]` | Yes — refuses to run in prod without `ALLOW_SEED_IN_PRODUCTION=true`, and even then will not overwrite an existing super admin. | No |
| `seed-hierarchy.js` invocation in deploy | `deploy/deploy.yml` step `[8/9]` | **Now skipped in prod** by the guard added in §1.2. Set `ALLOW_PROD_HIERARCHY_SEED=true` on the container to opt in. | No (and now no-op in prod by default) |
| `run-onetime-password-reset.sh` invocation in deploy | `deploy/deploy.yml` step `[9/9]` | **Now no-op on auto-deploy** after the flip in §1.1. Manual `workflow_dispatch` opt-in still works. | No (and now no-op on auto-deploy) |

All of these effects are **expected**. They are the intended outcome of
this branch landing. The two changes in §1 close the two paths that
previously rewrote `users.hierarchyLevel` and reset two specific user
passwords on every push.

---

## 5. Git Safety Result

- **Current branch:** `main`
- **Currently staged files:** none (`git diff --cached --name-only`
  returns empty).
- **Modified files (55):** all client/server source files plus the two
  files modified for this fix:
  - `deploy/run-onetime-password-reset.sh`
  - `server/seed-hierarchy.js`
  Full list available via `git status --short`.
- **Untracked files (21):** new tests, new components, new server
  controllers / routes / models / utils, the `client/src/i18n/` folder,
  and the two migration files
  `server/migrations/016_add_user_language.sql` /
  `server/migrations/run_016.js`.
- **Sensitive-file scan:** `git ls-files | grep -Ei
  '(\.env|secret|key|pem|p12|keystore|jks|apk|aab|dump|backup|artifact|token|credential|private|\.log$)'`
  returns:
  - `client/src/components/common/KeyboardShortcuts.jsx` — source file (false positive on `key`)
  - `deploy/.env.production.example` — template, all values are `CHANGE_ME_…`
  - `deploy/backup.sh` — `pg_dump` wrapper, not a backup payload
  - `deploy/k8s/secrets.yml` — Kubernetes manifest template, values are `CHANGE_ME`
  - `server/.env.example` — template, no real values
  - `server/controllers/apiKeyController.js` — source file
  - `server/middleware/apiKeyAuth.js` — source file
  - `server/models/ApiKey.js` — source file
  - `server/models/RefreshToken.js` — source file
  - `server/routes/apiKeys.js` — source file
  Every hit is either an intentional template with no real secret or a
  source file whose name happens to match the regex. **No real secrets,
  tokens, keystores, certificates, APKs, dumps, or logs are tracked.**
- **Ignored sensitive files (confirmed kept out by `.gitignore`):**
  `server/.env`, `deploy/.env`, `server/logs/`, `node_modules/`,
  `client/node_modules/`, `client/dist/`, `*.png` screenshots at the
  repo root, `.claude/`, `.playwright-mcp/`.

No risky file is staged or tracked.

---

## 6. Final Push Verdict

```text
Safe to push: YES

Reason:
  - The two production-safety blockers identified by the pre-push audit are now closed:
    (a) FORCE_AUTO_RUN_SUNNY_MUSKAN_RESET_ON_DEPLOY is now "false", so the deploy will
        no longer force a password reset for Sunny/Muskan.
    (b) seed-hierarchy.js now refuses to write in production unless
        ALLOW_PROD_HIERARCHY_SEED=true, so the deploy will no longer rewrite
        users.hierarchyLevel on every push.
  - All schema changes ship via guarded auto-installing blocks in server.js
    plus the canonical migration files (016) in server/migrations/. No manual
    DB migration step is required.
  - No secrets, dumps, keystores, APKs, logs, or production credentials are
    staged or tracked. The real .env files are gitignored.
  - The read-only audit workflows are genuinely read-only (SET TRANSACTION
    READ ONLY + ROLLBACK + forbidden-keyword guard) and could not have
    modified production data.

Blockers:
  None.

Warnings:
  - The deploy will restart the backend container, which re-runs idempotent
    startup migrations and these in-place re-derivations:
      * users.tier is recomputed from (role, isSuperAdmin) on every boot.
      * BoardMembers.autoAdded is re-flipped to false for board creators and
        admin/manager/assistant_manager users on every boot.
      * Stale auto-added BoardMembers rows (no active task) are deleted on
        every boot. This removes board-membership rows only; no tasks,
        comments, files, or work logs are affected.
      * Every existing board gets the labels/references/links columns
        appended to its columns JSONB, and "Link" / "References" titles are
        normalized to "Link/URL" / "Reference".
    These are intended. Acknowledge before pushing.
  - The most likely cause of "data appearing again" reported earlier is the
    tier-based visibility hotfix on this branch (commit 4117043), not a DB
    restore. Confirm with the read-only SELECTs in the pre-push audit when
    you next have prod DB access.

Files to stage:
  All 55 modified files, including:
    deploy/run-onetime-password-reset.sh
    server/seed-hierarchy.js
    server/server.js
    server/models/index.js, server/models/User.js, server/models/Board.js
    server/controllers/**  (modified)
    server/jobs/**  (modified)
    server/middleware/**  (modified)
    server/routes/**  (modified)
    server/services/**  (modified)
    server/utils/**  (modified)
    server/__tests__/**  (modified + new)
    client/src/**  (modified)
  All 21 untracked files, including:
    server/migrations/016_add_user_language.sql
    server/migrations/run_016.js
    server/models/PendingLoginToken.js
    server/models/TaskLink.js
    server/models/TaskReference.js
    server/controllers/taskLinkController.js
    server/controllers/taskReferenceController.js
    server/routes/taskLinks.js
    server/routes/taskReferences.js
    server/utils/taskNotificationRecipients.js
    server/utils/taskOverdueEligibility.js
    server/__tests__/controllers/authController.singleSession.test.js
    server/__tests__/controllers/taskController.tier2EditParity.test.js
    server/__tests__/jobs/  (folder of new test files)
    server/__tests__/services/assignmentNotificationService.test.js
    server/__tests__/utils/taskNotificationRecipients.test.js
    server/__tests__/utils/taskOverdueEligibility.test.js
    client/src/components/board/LinksCell.jsx
    client/src/components/board/ReferenceCell.jsx
    client/src/context/LanguageContext.jsx
    client/src/hooks/useNavBadgeCounts.js
    client/src/i18n/  (folder)
    client/src/utils/i18nLabels.js
  Plus PRE_PUSH_SAFETY_REPORT.md (this report) if you want it captured in
  the commit; or omit it if you prefer to keep it as a local artefact.

Files not to stage:
  None. Nothing sensitive is in the working tree. The .gitignore already
  excludes server/.env, deploy/.env, server/logs/, node_modules/,
  client/dist/, .claude/, .playwright-mcp/, root-level *.png screenshots,
  *.pem, and *.log.

Recommended next commands:
  # 1. Final visual confirmation of what will be committed
  git status --short
  git diff --stat
  git diff -- deploy/run-onetime-password-reset.sh server/seed-hierarchy.js

  # 2. Stage explicitly (avoid `git add .`)
  git add deploy/run-onetime-password-reset.sh server/seed-hierarchy.js
  git add server/server.js server/models server/controllers server/jobs \
          server/middleware server/routes server/services server/utils \
          server/__tests__
  git add server/migrations/016_add_user_language.sql server/migrations/run_016.js
  git add client/src
  # (optionally) git add PRE_PUSH_SAFETY_REPORT.md

  # 3. Sanity-check that nothing sensitive crept into the staged set
  git diff --cached --name-only | grep -Ei \
    '(\.env$|secret|\.pem|p12|keystore|jks|apk|aab|dump|backup|\.log$|token|credential|private)'
  #    Expect: empty output.

  # 4. Run tests locally before committing
  cd server && npm test
  cd ../client && npm run build

  # 5. Commit (one focused commit message) — do NOT push yet
  git commit -m "<short message describing the branch work + the two safety flips>"

  # 6. Push when you are ready for deploy to fire
  git push origin main
```

---

End of report.
