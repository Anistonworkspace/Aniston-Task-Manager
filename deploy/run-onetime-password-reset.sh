#!/usr/bin/env bash
# ============================================================
# One-time guarded password-reset hook, invoked from
# .github/workflows/deploy.yml inside the SSH session on the
# production EC2 host AFTER the backend health check passes.
#
# Behavior:
#   * If RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN is anything
#     other than the literal string "true", this script logs
#     "skipped" and exits 0 — deploy continues unchanged.
#   * If the flag is "true":
#       1. Verify aph-backend container is up.
#       2. Read CLIENT_URL from the running container (so the
#          printed URLs use whatever production was deployed
#          with — never localhost).
#       3. Fail loudly if NODE_ENV inside the container is
#          anything but "production".
#       4. Run the script in DRY-RUN with strict-deployment
#          flags. If it does not resolve EXACTLY the two
#          expected accounts (Sunny + Muskan), abort.
#       5. Re-run with --execute. The script's own internal
#          validation re-checks the same constraints; if any
#          row outside the expected set somehow appeared
#          between dry-run and execute, the script aborts
#          mid-flight inside its own DB transaction.
#       6. The script writes a row into system_maintenance_runs
#          with key "password-reset-sunny-muskan-2026-05".
#          Future deploys with the flag still on short-circuit
#          inside the script and exit 0.
#
# Idempotent: re-running with the flag still on after the first
# successful execute is a no-op (script exits 0 on marker hit).
#
# This script DOES NOT print anything to a file. The reset URLs
# are echoed to stdout exactly once and end up in the GitHub
# Actions workflow log only. Copy them out of the log and
# disable RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN immediately.
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

# ── Gate 1: feature flag ────────────────────────────────────
FLAG_VALUE="${RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN:-}"
if [ "$FLAG_VALUE" != "true" ]; then
  log "RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN is '${FLAG_VALUE:-(unset)}' — skipping. Deploy continues."
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

# ── Gate 5: DB host inside the container must NOT be a host that
# looks like a developer machine. The compose file pins this to
# "postgres", which is the Docker service DNS name.
CONTAINER_DB_HOST=$(docker exec "${BACKEND_CONTAINER}" sh -c 'printf %s "$DB_HOST"' || true)
if [ -z "$CONTAINER_DB_HOST" ]; then
  fail "Container DB_HOST is empty. Refusing to run."
fi
log "Container DB_HOST='${CONTAINER_DB_HOST}'."

# ── Step A: DRY-RUN with strict validation ─────────────────
log "Running DRY-RUN with strict validation..."
set +e
DRYRUN_OUTPUT=$(docker exec \
  -e ALLOW_SPECIFIC_PASSWORD_RESET=true \
  "${BACKEND_CONTAINER}" \
  node "${SCRIPT_PATH}" \
    --email "${EXPECTED_EMAIL_1}" \
    --email "${EXPECTED_EMAIL_2}" \
    --expected-email "${EXPECTED_EMAIL_1}" \
    --expected-email "${EXPECTED_EMAIL_2}" \
    --require-exact-count 2 \
    --client-url "${CONTAINER_CLIENT_URL}" \
    --maintenance-key "${MAINTENANCE_KEY}" \
    --executed-by "${EXECUTED_BY}" \
    --ttl-hours "${TTL_HOURS}" \
    --allow-production \
  2>&1)
DRYRUN_RC=$?
set -e

printf '%s\n' "$DRYRUN_OUTPUT"

if [ $DRYRUN_RC -ne 0 ]; then
  fail "Dry-run exited with code ${DRYRUN_RC}. Refusing to execute."
fi

# Detect "already completed — skipping" early-out so we treat it as success.
if printf '%s' "$DRYRUN_OUTPUT" | grep -q 'Already completed — skipping'; then
  log "Maintenance key already recorded — nothing to do. Marker prevents re-run."
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
  node "${SCRIPT_PATH}" \
    --email "${EXPECTED_EMAIL_1}" \
    --email "${EXPECTED_EMAIL_2}" \
    --expected-email "${EXPECTED_EMAIL_1}" \
    --expected-email "${EXPECTED_EMAIL_2}" \
    --require-exact-count 2 \
    --client-url "${CONTAINER_CLIENT_URL}" \
    --maintenance-key "${MAINTENANCE_KEY}" \
    --executed-by "${EXECUTED_BY}" \
    --ttl-hours "${TTL_HOURS}" \
    --allow-production \
    --execute \
  2>&1)
EXECUTE_RC=$?
set -e

printf '%s\n' "$EXECUTE_OUTPUT"

if [ $EXECUTE_RC -ne 0 ]; then
  fail "Execute exited with code ${EXECUTE_RC}. Inspect the output above. ${MAINTENANCE_KEY} marker NOT inserted (transaction rolled back)."
fi

# ── Final banner — make the URLs impossible to miss in the log ─
cat <<BANNER

================================================================================
  ONE-TIME PASSWORD RESET COMPLETED
  Maintenance key: ${MAINTENANCE_KEY}
  Token TTL:       ${TTL_HOURS} hours
  Expires:         see "expires=" line above

  IMMEDIATE ACTIONS REQUIRED:
    1. Copy each /reset-password?token=... URL above out of this log.
    2. Send each URL to the matching user over a SECURE channel
       (Microsoft Teams DM, password manager share, in-person).
       Do NOT paste them into Jira, email, or chat groups.
    3. After confirming both users have set their new password,
       set RUN_ONE_TIME_PASSWORD_RESET_SUNNY_MUSKAN to false
       (or delete the variable) in GitHub repo Settings → Variables.
    4. The DB marker '${MAINTENANCE_KEY}' now exists in
       system_maintenance_runs and will short-circuit any future
       runs — but you should still flip the flag off so the deploy
       step is a clean no-op rather than an emit-marker-already-set log.
================================================================================
BANNER

log "Done."
exit 0
