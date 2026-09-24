#!/usr/bin/env bash
#
# WOROOD HUB — nightly logical backup to S3
#
#   worood-hub-backup              # run a backup now
#
# Run by worood-hub-backup.timer at 23:30 UTC. Takes a custom-format pg_dump
# plus the role definitions, verifies the dump is readable before uploading,
# and puts both in S3 with server-side encryption.
#
# Custom format (-Fc) rather than plain SQL, because that is what makes
# selective restore possible — recovering one accidentally deleted table
# without rolling back the entire database.
#
# Retention is the bucket's lifecycle policy, not this script's job. The
# instance role deliberately has no s3:DeleteObject, so a compromised
# instance cannot erase its own backup history.

set -Eeuo pipefail

# Resolve deploy.env whether this runs from the repo or from /usr/local/bin.
for candidate in \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.env" \
  "/opt/worood-hub/deploy/deploy.env"; do
  if [[ -f "$candidate" ]]; then
    # shellcheck source=deploy.env
    source "$candidate"
    break
  fi
done

: "${DB_NAME:?deploy.env not found — set DB_NAME and BACKUP_BUCKET in the environment}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is not set}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DAY="$(date -u +%Y/%m/%d)"
WORK_DIR="$(mktemp -d /tmp/worood-hub-backup.XXXXXX)"
DUMP="${WORK_DIR}/${DB_NAME}-${STAMP}.dump"
GLOBALS="${WORK_DIR}/globals-${STAMP}.sql"

# journald is the log destination — this runs unattended, so everything it
# says needs to be findable with journalctl -u worood-hub-backup.
log() { printf '[worood-hub-backup] %s\n' "$*"; }
die() { printf '[worood-hub-backup] FAILED: %s\n' "$*" >&2; rm -rf "$WORK_DIR"; exit 1; }

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

command -v pg_dump >/dev/null || die "pg_dump not on PATH"
command -v aws     >/dev/null || die "aws CLI not installed — snap install aws-cli --classic"

log "starting backup of ${DB_NAME}"

# ---------------------------------------------------------------------------
# Dump
# ---------------------------------------------------------------------------
# Runs as the postgres system user via the unit's User= directive, so peer
# authentication applies and no password is needed or stored.
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
        --file="$DUMP" "$DB_NAME" \
  || die "pg_dump failed"

# Role definitions are not in a per-database dump, and a restore onto a fresh
# instance needs them or every GRANT fails.
pg_dumpall --globals-only --no-role-passwords --file="$GLOBALS" \
  || die "pg_dumpall --globals-only failed"

DUMP_BYTES="$(stat -c%s "$DUMP")"
(( DUMP_BYTES > 1024 )) || die "dump is only ${DUMP_BYTES} bytes — refusing to upload it"

# ---------------------------------------------------------------------------
# Verify before uploading
# ---------------------------------------------------------------------------
# A dump that cannot be listed cannot be restored. Catching that here is the
# difference between a failed backup and a backup you only discover is
# useless during an incident.
TABLE_COUNT="$(pg_restore --list "$DUMP" 2>/dev/null | grep -c 'TABLE DATA' || true)"
(( TABLE_COUNT > 0 )) || die "pg_restore --list found no table data in the dump"

for required in core_users mr_reservations; do
  pg_restore --list "$DUMP" | grep -q " ${required}\$\|${required} " \
    || log "WARNING: expected table ${required} not found in the dump"
done

log "dump ok: $(numfmt --to=iec "$DUMP_BYTES"), ${TABLE_COUNT} tables"

# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------
S3_BASE="s3://${BACKUP_BUCKET}/${BACKUP_PREFIX:-postgres}/${DAY}"

aws s3 cp "$DUMP" "${S3_BASE}/$(basename "$DUMP")" \
  --sse AES256 --only-show-errors \
  || die "upload of the dump failed"

aws s3 cp "$GLOBALS" "${S3_BASE}/$(basename "$GLOBALS")" \
  --sse AES256 --only-show-errors \
  || die "upload of the globals failed"

# ---------------------------------------------------------------------------
# Confirm it landed
# ---------------------------------------------------------------------------
REMOTE_BYTES="$(aws s3api head-object \
  --bucket "$BACKUP_BUCKET" \
  --key "${BACKUP_PREFIX:-postgres}/${DAY}/$(basename "$DUMP")" \
  --query 'ContentLength' --output text 2>/dev/null || echo 0)"

[[ "$REMOTE_BYTES" == "$DUMP_BYTES" ]] \
  || die "uploaded size ${REMOTE_BYTES} does not match local ${DUMP_BYTES}"

log "uploaded ${S3_BASE}/$(basename "$DUMP") ($(numfmt --to=iec "$DUMP_BYTES"))"
log "done"
