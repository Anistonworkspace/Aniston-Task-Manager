#!/bin/bash
# PostgreSQL Backup Script for Monday Aniston
# Run: docker exec aph-postgres sh /backup.sh
# Or schedule via cron on the host:
#   0 2 * * * docker exec aph-postgres pg_dump -U postgres aniston_project_hub | gzip > ~/backups/db-$(date +\%Y\%m\%d).sql.gz

set -e

BACKUP_DIR="/backups"
DB_NAME="${POSTGRES_DB:-aniston_project_hub}"
DB_USER="${POSTGRES_USER:-postgres}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/db_${TIMESTAMP}.sql.gz"

# Create backup directory if not exists
mkdir -p "$BACKUP_DIR"

echo "[Backup] Starting PostgreSQL backup: ${DB_NAME}"
pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"
echo "[Backup] Created: ${BACKUP_FILE} ($(du -h "$BACKUP_FILE" | cut -f1))"

# Retain only last 30 daily backups
KEEP=30
TOTAL=$(ls -1 "$BACKUP_DIR"/db_*.sql.gz 2>/dev/null | wc -l)
if [ "$TOTAL" -gt "$KEEP" ]; then
  DELETE=$((TOTAL - KEEP))
  ls -1t "$BACKUP_DIR"/db_*.sql.gz | tail -n "$DELETE" | xargs rm -f
  echo "[Backup] Cleaned up ${DELETE} old backups (keeping ${KEEP})"
fi

echo "[Backup] Done."
