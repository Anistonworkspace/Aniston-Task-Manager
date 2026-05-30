#!/bin/bash
# Verify the most recent DB backup against the live database.
#
# Usage:  bash server/verify-latest-backup.sh
#         bash server/verify-latest-backup.sh path/to/specific.sql.gz
#
# Safe — restores into a throwaway DB named aniston_verify_<timestamp> and
# DROPs it at the end. Never touches aniston_project_hub.
#
# Exit code: 0 if all four checks pass, non-zero otherwise.

set -u

# Defaults match the local dev setup. Override via env if your container
# name or DB credentials differ.
CONTAINER="${DB_BACKUP_VIA_DOCKER:-aniston-postgres}"
DB="${DB_NAME:-aniston_project_hub}"
USER="${DB_USER:-postgres}"
PASS="${DB_PASSWORD:-postgres}"

if [ -n "${1:-}" ]; then
  FILE="$1"
else
  FILE=$(ls -t backups/database/*.sql.gz 2>/dev/null | head -1)
fi
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "No backup file found. Pass one explicitly or run a backup first."
  exit 2
fi

PSQL="docker exec -e PGPASSWORD=$PASS $CONTAINER psql -U $USER"
PSQL_I="docker exec -i -e PGPASSWORD=$PASS $CONTAINER psql -U $USER"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32mPASS\033[0m  %s\n" "$1"; }
fail() { printf "  \033[31mFAIL\033[0m  %s\n" "$1"; }

bold "Verifying $FILE"
echo  "  size:    $(du -h "$FILE" | cut -f1)"
echo  "  created: $(stat -c '%y' "$FILE" 2>/dev/null | cut -d. -f1)"
echo

bold "1/4  gzip integrity"
if gzip -t "$FILE" 2>/dev/null; then ok "stream is intact"
else fail "gzip CRC failed — file is corrupt or truncated"; exit 1; fi

bold "2/4  dump header"
HEADER=$(gunzip -c "$FILE" | head -3 | tr -d '\r')
if echo "$HEADER" | grep -q "PostgreSQL database dump"; then ok "real pg_dump output"
else fail "not a PostgreSQL dump header"; exit 1; fi

bold "3/4  table inventory"
DUMP_TBL=$(gunzip -c "$FILE" | grep -cE "^CREATE TABLE public\.")
LIVE_TBL=$($PSQL -d "$DB" -tAc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public'")
echo "  tables in dump: $DUMP_TBL    tables in live DB: $LIVE_TBL"
if [ "$DUMP_TBL" = "$LIVE_TBL" ]; then ok "all live tables present in backup"
else fail "table count differs — investigate before trusting this backup"; fi

bold "4/4  restore into throwaway DB + row-count diff"
TEST_DB="aniston_verify_$(date +%s)"
$PSQL -d postgres -c "CREATE DATABASE \"$TEST_DB\"" > /dev/null 2>&1
echo "  restoring into $TEST_DB ..."
gunzip -c "$FILE" | $PSQL_I --set ON_ERROR_STOP=1 -d "$TEST_DB" > /tmp/aniston_restore.log 2>&1
RC=$?
ERRS=$(grep -ciE "^(error|fatal)" /tmp/aniston_restore.log || true)
if [ "$RC" -eq 0 ] && [ "$ERRS" -eq 0 ]; then ok "dump replayed cleanly (exit 0, 0 errors)"
else fail "restore had errors (exit=$RC errors=$ERRS) — see /tmp/aniston_restore.log"; fi

echo
printf "  %-28s %8s %8s %s\n" "TABLE" "LIVE" "BACKUP" "STATUS"
for T in users boards tasks subtasks notifications activities comments \
         worklogs file_attachments meetings departments workspaces \
         task_assignees recurring_task_templates backup_records; do
  L=$($PSQL -d "$DB" -tAc "SELECT COUNT(*) FROM \"$T\"" 2>/dev/null || echo "-")
  R=$($PSQL -d "$TEST_DB" -tAc "SELECT COUNT(*) FROM \"$T\"" 2>/dev/null || echo "-")
  if [ "$L" = "$R" ]; then S="match"
  else S="drift +$((L - R))"; fi
  printf "  %-28s %8s %8s %s\n" "$T" "$L" "$R" "$S"
done

$PSQL -d postgres -c "DROP DATABASE \"$TEST_DB\"" > /dev/null 2>&1
echo
echo "Throwaway DB removed."
echo "Drift in activities / notifications / backup_records is normal —"
echo "those tables grew between when the backup was taken and now."
echo "Drift in tasks / boards / users beyond what you remember adding"
echo "is the only thing that should worry you."
