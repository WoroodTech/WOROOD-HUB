#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# WOROOD HUB — nightly logical backup to Amazon S3
#
# EBS snapshots (via AWS Backup) protect the whole volume; this adds a
# portable, restorable dump so a single corrupted table does not require
# restoring the entire instance.
#
#   sudo crontab -e   →   0 1 * * * /usr/local/bin/worood-backup
# ---------------------------------------------------------------------------
set -euo pipefail

BUCKET="${WOROOD_BACKUP_BUCKET:-s3://worood-hub-backups}"
DB_NAME="worood_hub"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="/tmp/${DB_NAME}-${STAMP}.dump"

echo "[$(date -u)] starting backup"

# Custom format: supports selective table restore with pg_restore.
sudo -u postgres pg_dump --format=custom --compress=9 --file="$TMP" "$DB_NAME"

SIZE="$(du -h "$TMP" | cut -f1)"
echo "  dump created: ${SIZE}"

aws s3 cp "$TMP" "${BUCKET}/postgres/${DB_NAME}-${STAMP}.dump" \
  --storage-class STANDARD_IA \
  --sse AES256

rm -f "$TMP"

# Local retention is unnecessary — S3 lifecycle rules handle expiry:
#   30 days STANDARD_IA → 180 days GLACIER_IR → expire at 365 days.
echo "[$(date -u)] backup complete"
