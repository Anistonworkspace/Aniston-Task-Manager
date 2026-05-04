#!/usr/bin/env bash
# ============================================================
# One-time guarded password-reset hook, invoked from
# .github/workflows/deploy.yml inside the SSH session on the
# production EC2 host AFTER the backend health check passes.
#
# Inputs (env, all forwarded by ssh-action):
#   RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN
#       The literal string "true" enables the run. Anything
#       else (unset, "false", "TRUE", etc.) is a clean skip.
#   ONETIME_RESET_RERUN_KEY
#       Optional. A fresh, never-before-used key like
#       "password-reset-sunny-muskan-2026-05-rerun-1". When
#       set, this run uses the rerun key as its marker
#       (overrides the original maintenance-key marker check).
#       Useful when Sunny/Muskan re-forgot their password
#       after a previous reset and the original marker is
#       already in place.
#
# Behavior:
#   * If the flag is not "true", logs a *very* loud skip
#     message and exits 0. Deploy continues unchanged. No
#     docker exec is issued and no DB connection is opened.
#   * If the flag is "true":
#       1. Verify aph-backend container is up.
#       2. Read CLIENT_URL from the running container.
#       3. Fail if NODE_ENV != "production" inside container.
#       4. Run the script in DRY-RUN with strict-deployment
#          flags + the rerun-key (when set). Confirms exactly
#          two users (Sunny + Muskan) resolve.
#       5. Re-run with --execute. Script's own validation
#          re-checks the same constraints inside its DB
#          transaction.
#       6. Marker row goes into system_maintenance_runs with
#          either the original key or the rerun key — exactly
#          one of those, never both for the same run.
#
# Idempotent: once the marker for the effective key exists,
# re-running the wrapper with the same key is a no-op exit 0.
# ============================================================

set -euo pipefail

# ── Constants ───────────────────────────────────────────────
BACKEND_CONTAINER="aph-backend"
SCRIPT_PATH="/app/scripts/reset-specific-user-passwords.js"
EXPECTED_EMAIL_1="mehta.sunny@anistonav.com"
EXPECTED_EMAIL_2="rawat.muskan@anistonav.com"
MAINTENANCE_KEY="password-reset-sunny-muskan-2026-05"
TTL_HOURS="${ONETIME_RESET_TTL_HOURS:-4}"
EXECUTED_BY="${ONETIME_RESET_EXECUTED_BY:-github-actions}"

log() { printf '[onetime-pw-reset] %s\n' "$*"; }
fail() { log "FAILED: $*"; exit 1; }

# ── Echo what we received from CI/CD up-front ──────────────
FLAG_VALUE="${RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN:-}"
RERUN_KEY="${ONETIME_RESET_RERUN_KEY:-}"

cat <<EOF
[onetime-pw-reset] ┌─ Inputs received from deploy environment ───────────────────────
[onetime-pw-reset] │ RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN = '${FLAG_VALUE:-(unset)}'
[onetime-pw-reset] │ ONETIME_RESET_RERUN_KEY                  = '${RERUN_KEY:-(empty)}'
[onetime-pw-reset] │ Built-in maintenance key                 = '${MAINTENANCE_KEY}'
[onetime-pw-reset] │ Token TTL hours                          = '${TTL_HOURS}'
[onetime-pw-reset] │ Executed-by label                        = '${EXECUTED_BY}'
[onetime-pw-reset] └─────────────────────────────────────────────────────────────────
EOF

# ── Gate 1: feature flag ────────────────────────────────────
if [ "$FLAG_VALUE" != "true" ]; then
  cat <<EOF

================================================================================
  PASSWORD RESET DID NOT RUN

  Reason: RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN is '${FLAG_VALUE:-(unset)}',
  not the literal string 'true'.

  To run the one-time Sunny/Muskan production password reset on the next
  deploy, do EITHER of the following BEFORE deploying:

    A) Set a GitHub Actions repository VARIABLE (not a secret):
         Settings → Secrets and variables → Actions → Variables tab → New
           Name:  RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN
           Value: true                                  (lowercase, exact)
       Then push to main, or click "Run workflow" in Actions.

    B) Trigger the workflow manually with a dispatch input:
         Actions → Build & Deploy → Run workflow
           run_password_reset_sunny_muskan: true
       Optionally also set:
           onetime_reset_rerun_key: password-reset-sunny-muskan-2026-05-rerun-1
       (only if a previous reset has already used the original key.)

  Deploy continues. No DB activity took place during this step.
================================================================================
EOF
  exit 0
fi

log "Flag is true. Beginning guarded one-time password reset."

# ── Gate 2: backend container present and running ──────────
if ! docker ps --format '{{.Names}}' | grep -q "^${BACKEND_CONTAINER}\$"; then
  fail "Backend container '${BACKEND_CONTAINER}' is not running. Aborting reset hook."
fi
log "Backend container '${BACKEND_CONTAINER}' is running."

# ── Gate 3: NODE_ENV inside container must be production ───
CONTAINER_NODE_ENV=$(docker exec "${BACKEND_CONTAINER}" sh -c 'printf %s "$NODE_ENV"' || true)
if [ "$CONTAINER_NODE_ENV" != "production" ]; then
  fail "Container NODE_ENV is '${CONTAINER_NODE_ENV:-(unset)}', not 'production'. Refusing to run."
fi
log "Container NODE_ENV=production confirmed."

# ── Gate 4: read CLIENT_URL from container, validate ───────
CONTAINER_CLIENT_URL=$(docker exec "${BACKEND_CONTAINER}" sh -c 'printf %s "$CLIENT_URL"' || true)
if [ -z "$CONTAINER_CLIENT_URL" ]; then
  fail "Container CLIENT_URL is empty. Refusing to run (URLs would be unusable)."
fi
case "$CONTAINER_CLIENT_URL" in
  *localhost*|*127.0.0.1*|*0.0.0.0*)
    fail "Container CLIENT_URL='${CONTAINER_CLIENT_URL}' looks like a local URL. Refusing to run."
    ;;
esac
log "Container CLIENT_URL='${CONTAINER_CLIENT_URL}' looks production-shaped."

# ── Gate 5: DB host inside the container present ───────────
CONTAINER_DB_HOST=$(docker exec "${BACKEND_CONTAINER}" sh -c 'printf %s "$DB_HOST"' || true)
if [ -z "$CONTAINER_DB_HOST" ]; then
  fail "Container DB_HOST is empty. Refusing to run."
fi
log "Container DB_HOST='${CONTAINER_DB_HOST}'."

# ── Build the script argv (rerun-key optional) ─────────────
SCRIPT_ARGS=(
  --email           "${EXPECTED_EMAIL_1}"
  --email           "${EXPECTED_EMAIL_2}"
  --expected-email  "${EXPECTED_EMAIL_1}"
  --expected-email  "${EXPECTED_EMAIL_2}"
  --require-exact-count 2
  --client-url      "${CONTAINER_CLIENT_URL}"
  --maintenance-key "${MAINTENANCE_KEY}"
  --executed-by     "${EXECUTED_BY}"
  --ttl-hours       "${TTL_HOURS}"
  --allow-production
)
if [ -n "$RERUN_KEY" ]; then
  SCRIPT_ARGS+=( --rerun-key "$RERUN_KEY" )
  log "Rerun key '${RERUN_KEY}' supplied — it will be used as THIS run's marker."
fi

# ── Step A: DRY-RUN with strict validation ─────────────────
log "Running DRY-RUN with strict validation..."
set +e
DRYRUN_OUTPUT=$(docker exec \
  -e ALLOW_SPECIFIC_PASSWORD_RESET=true \
  "${BACKEND_CONTAINER}" \
  node "${SCRIPT_PATH}" "${SCRIPT_ARGS[@]}" \
  2>&1)
DRYRUN_RC=$?
set -e

printf '%s\n' "$DRYRUN_OUTPUT"

if [ $DRYRUN_RC -ne 0 ]; then
  # State-drift exit (5) is the script's "marker exists but users need
  # another reset" signal. Surface that with extra-loud guidance.
  if [ $DRYRUN_RC -eq 5 ]; then
    cat <<EOF

================================================================================
  STATE DRIFT — RESET REFUSED

  The original maintenance marker exists in the production DB, but at least
  one of the target users is no longer in the expected post-reset state.
  Likely cause: the user redeemed their previous reset link, set a password,
  and forgot it again.

  To intentionally reset both users one more time, set this on the next
  deploy:

    A) GitHub Actions repository variable:
         ONETIME_RESET_RERUN_KEY = password-reset-sunny-muskan-2026-05-rerun-1
       (pick the next free -rerun-N suffix if -rerun-1 is already used)

    B) Or workflow_dispatch input:
         onetime_reset_rerun_key: password-reset-sunny-muskan-2026-05-rerun-1

  Then re-run the deploy. The rerun key fires exactly once per fresh value.
================================================================================
EOF
  fi
  fail "Dry-run exited with code ${DRYRUN_RC}. Refusing to execute."
fi

# Detect "already completed — skipping" early-out so we treat it as success.
if printf '%s' "$DRYRUN_OUTPUT" | grep -q 'Already completed — skipping'; then
  log "Marker already recorded — nothing to do. Re-run prevented at DB level."
  log "You can safely set RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN=false now."
  exit 0
fi

# Defense in depth: count the inline ✓ markers the script prints during
# the lookup phase. There must be exactly two — one per expected account.
HIT_COUNT=$(printf '%s' "$DRYRUN_OUTPUT" | grep -E '^  ✓ (mehta\.sunny|rawat\.muskan)@anistonav\.com:' | wc -l | tr -d ' ')
if [ "$HIT_COUNT" != "2" ]; then
  fail "Dry-run resolved ${HIT_COUNT} matching account(s); expected exactly 2. Refusing to execute."
fi
log "Dry-run resolved exactly 2 accounts (Sunny + Muskan). Proceeding to execute."

# ── Step B: EXECUTE with the same flags + --execute ────────
log "Running EXECUTE..."
set +e
EXECUTE_OUTPUT=$(docker exec \
  -e ALLOW_SPECIFIC_PASSWORD_RESET=true \
  "${BACKEND_CONTAINER}" \
  node "${SCRIPT_PATH}" "${SCRIPT_ARGS[@]}" --execute \
  2>&1)
EXECUTE_RC=$?
set -e

printf '%s\n' "$EXECUTE_OUTPUT"

if [ $EXECUTE_RC -ne 0 ]; then
  fail "Execute exited with code ${EXECUTE_RC}. Inspect the output above. Marker NOT inserted (transaction rolled back)."
fi

# Effective key that the script just wrote into the marker table.
EFFECTIVE_KEY="${RERUN_KEY:-$MAINTENANCE_KEY}"

# ── Final banner — make the URLs impossible to miss in the log ─
cat <<BANNER

================================================================================
  ONE-TIME PASSWORD RESET COMPLETED
  Effective marker key: ${EFFECTIVE_KEY}
  (Original key:        ${MAINTENANCE_KEY})
  Token TTL:            ${TTL_HOURS} hours
  Expires:              see "expires=" line above

  IMMEDIATE ACTIONS REQUIRED:
    1. Copy each /reset-password?token=... URL above out of this log.
    2. Send each URL to the matching user over a SECURE channel
       (Microsoft Teams DM, password manager share, in-person).
       Do NOT paste them into Jira, email, or chat groups.
    3. After confirming both users have set their new password,
       set RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN to false
       (or delete the variable) in GitHub repo Settings → Variables.
       Also clear ONETIME_RESET_RERUN_KEY if it was set.
    4. The marker for '${EFFECTIVE_KEY}' now exists in
       system_maintenance_runs and will short-circuit any future
       runs of THIS key. To force another reset later, pick a
       fresh rerun key like '${MAINTENANCE_KEY}-rerun-N'.
================================================================================
BANNER

log "Done."
exit 0
