#!/usr/bin/env bash
#
# WOROOD HUB — restore a backup, and the quarterly restore rehearsal
#
#   worood-hub-restore --list
#   worood-hub-restore --rehearse                  # restore latest into a scratch DB
#   worood-hub-restore --into worood_hub_test s3://.../worood_hub-2026....dump
#   worood-hub-restore --into worood_hub --force   # PRODUCTION restore, latest dump
#
# A backup you have never restored is a hypothesis. --rehearse is the cheap
# way to turn it into a fact: it restores the most recent dump into a
# throwaway database on this instance, counts the rows that matter, verifies
# the double-booking constraint survived, and drops it again.
#
# Restoring over the live database requires --force and a typed confirmation,
# because it is destructive and irreversible.

set -Eeuo pipefail

for candidate in \
  "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deploy.env" \
  "/opt/worood-hub/deploy/deploy.env"; do
  if [[ -f "$candidate" ]]; then
    # shellcheck source=deploy.env
    source "$candidate"
    break
  fi
done

: "${DB_NAME:?deploy.env not found}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is not set}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mfailed:\033[0m %s\n' "$*" >&2; exit 1; }

TARGET_DB=""
SOURCE_URI=""
MODE="restore"
FORCE="no"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)     MODE="list"; shift ;;
    --rehearse) MODE="rehearse"; shift ;;
    --into)     TARGET_DB="$2"; shift 2 ;;
    --force)    FORCE="yes"; shift ;;
    s3://*)     SOURCE_URI="$1"; shift ;;
    *)          die "unrecognised argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root: sudo $0 ..."
command -v aws        >/dev/null || die "aws CLI not installed"
command -v pg_restore >/dev/null || die "pg_restore not on PATH"

PREFIX="${BACKUP_PREFIX:-postgres}"

# ---------------------------------------------------------------------------
# --list
# ---------------------------------------------------------------------------
if [[ "$MODE" == "list" ]]; then
  log "Backups in s3://${BACKUP_BUCKET}/${PREFIX}/"
  aws s3 ls "s3://${BACKUP_BUCKET}/${PREFIX}/" --recursive --human-readable \
    | grep '\.dump$' | sort -r | head -40
  printf '\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# Find the dump
# ---------------------------------------------------------------------------
if [[ -z "$SOURCE_URI" ]]; then
  log "Finding the most recent dump"
  LATEST_KEY="$(aws s3 ls "s3://${BACKUP_BUCKET}/${PREFIX}/" --recursive \
    | grep '\.dump$' | sort -k1,2 | tail -1 | awk '{print $4}')"
  [[ -n "$LATEST_KEY" ]] || die "no .dump objects under s3://${BACKUP_BUCKET}/${PREFIX}/"
  SOURCE_URI="s3://${BACKUP_BUCKET}/${LATEST_KEY}"
fi
ok "source: ${SOURCE_URI}"

WORK_DIR="$(mktemp -d /tmp/worood-hub-restore.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
LOCAL_DUMP="${WORK_DIR}/$(basename "$SOURCE_URI")"

aws s3 cp "$SOURCE_URI" "$LOCAL_DUMP" --only-show-errors || die "download failed"

# pg_restore runs as the postgres user, but mktemp -d gives the directory
# mode 0700 owned by root. Without this, the restore fails with a permission
# error on a file that is plainly there, which is a confusing five minutes.
chmod 0711 "$WORK_DIR"
chmod 0644 "$LOCAL_DUMP"
ok "downloaded $(numfmt --to=iec "$(stat -c%s "$LOCAL_DUMP")")"

pg_restore --list "$LOCAL_DUMP" >/dev/null 2>&1 || die "the dump is not readable by pg_restore"

# ---------------------------------------------------------------------------
# Decide the destination
# ---------------------------------------------------------------------------
if [[ "$MODE" == "rehearse" ]]; then
  TARGET_DB="${DB_NAME}_rehearsal_$(date -u +%Y%m%d)"
  ok "rehearsal target: ${TARGET_DB} (will be dropped at the end)"
fi

[[ -n "$TARGET_DB" ]] || die "specify a destination with --into <database>, or use --rehearse"

if [[ "$TARGET_DB" == "$DB_NAME" ]]; then
  [[ "$FORCE" == "yes" ]] || die "refusing to restore over the live database ${DB_NAME} without --force"
  printf '\n\033[1;31mThis will DESTROY the current contents of %s.\033[0m\n' "$DB_NAME"
  printf 'Take an EBS snapshot first if you have not.\n\n'
  read -r -p "Type the database name to confirm: " typed
  [[ "$typed" == "$DB_NAME" ]] || die "confirmation did not match — nothing was changed"
  systemctl stop "${API_SERVICE}.service" || true
  warn "${API_SERVICE} stopped for the duration of the restore"
fi

# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------
log "Restoring into ${TARGET_DB}"

sudo -u postgres psql -qX -c "DROP DATABASE IF EXISTS ${TARGET_DB};"
sudo -u postgres createdb -O "$DB_USER" "$TARGET_DB"

# Extensions first. pg_restore recreates them from the dump, but doing it
# explicitly means a dump taken before an extension was added still lands in
# a database that has it.
for ext in btree_gist citext pgcrypto; do
  sudo -u postgres psql -qX -d "$TARGET_DB" -c "CREATE EXTENSION IF NOT EXISTS ${ext};"
done

# --exit-on-error is deliberately NOT set: a restore that skips an already
# existing extension should not abort the whole job. Errors are counted below
# instead, which is more informative than a hard stop on the first one.
RESTORE_LOG="${WORK_DIR}/restore.log"
# shellcheck disable=SC2024  # the script already runs as root; the redirect is root's, which is what we want
sudo -u postgres pg_restore --dbname="$TARGET_DB" --no-owner --no-privileges \
  --jobs=2 "$LOCAL_DUMP" > "$RESTORE_LOG" 2>&1 || true

ERROR_COUNT="$(grep -c '^pg_restore: error' "$RESTORE_LOG" || true)"
if (( ERROR_COUNT > 0 )); then
  warn "${ERROR_COUNT} pg_restore errors:"
  grep '^pg_restore: error' "$RESTORE_LOG" | head -20 | sed 's/^/         /'
fi

# ---------------------------------------------------------------------------
# Verify what actually came back
# ---------------------------------------------------------------------------
log "Verifying"

q() { sudo -u postgres psql -tAX -d "$TARGET_DB" -c "$1" 2>/dev/null || echo "?"; }

printf '    %-28s %s\n' "core_users"            "$(q 'SELECT count(*) FROM core_users')"
printf '    %-28s %s\n' "core_roles"            "$(q 'SELECT count(*) FROM core_roles')"
printf '    %-28s %s\n' "core_audit_logs"       "$(q 'SELECT count(*) FROM core_audit_logs')"
printf '    %-28s %s\n' "mr_rooms"              "$(q 'SELECT count(*) FROM mr_rooms')"
printf '    %-28s %s\n' "mr_reservations"       "$(q 'SELECT count(*) FROM mr_reservations')"
printf '    %-28s %s\n' "applied migrations"    "$(q 'SELECT count(*) FROM core_migrations')"

# The exclusion constraint is the single most important thing in this schema.
# A restore that silently loses it produces a database that accepts double
# bookings, which is worse than a restore that visibly failed.
CONSTRAINT_PRESENT="$(q "SELECT count(*) FROM pg_constraint WHERE conname = 'mr_reservations_no_overlap'")"
if [[ "$CONSTRAINT_PRESENT" == "1" ]]; then
  ok "mr_reservations_no_overlap present"
else
  warn "mr_reservations_no_overlap IS MISSING — this restore would accept double bookings"
fi

# ---------------------------------------------------------------------------
# Finish
# ---------------------------------------------------------------------------
if [[ "$MODE" == "rehearse" ]]; then
  log "Cleaning up the rehearsal database"
  sudo -u postgres psql -qX -c "DROP DATABASE IF EXISTS ${TARGET_DB};"
  ok "dropped ${TARGET_DB}"
  cat <<SUMMARY

$(printf '\033[1;32m%s\033[0m' "Rehearsal complete.")

  Record the elapsed time of this run. That figure, plus the time to launch
  a replacement instance, is Worood's real recovery time objective — and it
  is usually longer than anyone guessed.

SUMMARY
elif [[ "$TARGET_DB" == "$DB_NAME" ]]; then
  systemctl start "${API_SERVICE}.service"
  ok "${API_SERVICE} restarted"
  printf '\n\033[1;32mProduction restore complete.\033[0m Verify the portal before telling anyone it is back.\n\n'
else
  printf '\n\033[1;32mRestored into %s.\033[0m Drop it when you are finished with it.\n\n' "$TARGET_DB"
fi
