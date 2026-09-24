#!/usr/bin/env bash
#
# WOROOD HUB — roll back to a previous release
#
#   sudo bash deploy/rollback.sh                          # previous release
#   sudo bash deploy/rollback.sh 20260924T081500Z-a1b2c3d # a specific one
#   sudo bash deploy/rollback.sh --list                   # what is available
#
# This rolls back CODE ONLY. Migrations are forward-only by design: if the
# release being rolled back from changed the schema destructively, the
# previous code may not run against the current database. In that case you
# need the EBS snapshot taken before the deploy, not this script. The script
# warns when it detects that the schema has moved.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy.env
source "${SCRIPT_DIR}/deploy.env"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mfailed:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"
[[ -L "$CURRENT_LINK" ]] || die "no current release symlink at ${CURRENT_LINK}"

CURRENT_TARGET="$(readlink -f "$CURRENT_LINK")"
mapfile -t RELEASES < <(find "$RELEASES_DIR" -maxdepth 1 -mindepth 1 -type d | sort -r)

list_releases() {
  printf '\n  %-34s %-22s %s\n' "RELEASE" "BUILT" ""
  for dir in "${RELEASES[@]}"; do
    local marker="" built="unknown" desc=""
    [[ "$dir" == "$CURRENT_TARGET" ]] && marker=" <- current"
    if [[ -f "${dir}/RELEASE" ]]; then
      built="$(awk '/^built_at/ {print $2}' "${dir}/RELEASE")"
      desc="$(awk '/^git_describe/ {print $2}' "${dir}/RELEASE")"
    fi
    printf '  %-34s %-22s %s%s\n' "$(basename "$dir")" "$built" "$desc" "$marker"
  done
  printf '\n'
}

if [[ "${1:-}" == "--list" ]]; then
  list_releases
  exit 0
fi

# ---------------------------------------------------------------------------
# Pick the target
# ---------------------------------------------------------------------------
if [[ -n "${1:-}" ]]; then
  TARGET="${RELEASES_DIR}/${1}"
  [[ -d "$TARGET" ]] || { warn "no such release: ${1}"; list_releases; exit 1; }
else
  TARGET=""
  for dir in "${RELEASES[@]}"; do
    if [[ "$dir" != "$CURRENT_TARGET" ]]; then
      TARGET="$dir"
      break
    fi
  done
  [[ -n "$TARGET" ]] || die "no previous release on disk to roll back to"
fi

[[ "$TARGET" != "$CURRENT_TARGET" ]] || die "$(basename "$TARGET") is already the current release"
[[ -f "${TARGET}/api/${API_ENTRYPOINT}" ]] || die "${TARGET} looks incomplete — no api/${API_ENTRYPOINT}"

# ---------------------------------------------------------------------------
# Warn if the schema has moved since the target was built
# ---------------------------------------------------------------------------
TARGET_MIGRATIONS=0
CURRENT_MIGRATIONS=0
MIG_SUBDIR="$(dirname "${MIGRATE_ENTRYPOINT}")/migrations"
[[ -d "${TARGET}/api/${MIG_SUBDIR}" ]] && TARGET_MIGRATIONS="$(find "${TARGET}/api/${MIG_SUBDIR}" -name '*.sql' | wc -l)"
[[ -d "${CURRENT_TARGET}/api/${MIG_SUBDIR}" ]] && CURRENT_MIGRATIONS="$(find "${CURRENT_TARGET}/api/${MIG_SUBDIR}" -name '*.sql' | wc -l)"

log "Rolling back"
printf '    from  %s\n' "$(basename "$CURRENT_TARGET")"
printf '    to    %s\n' "$(basename "$TARGET")"

if (( CURRENT_MIGRATIONS > TARGET_MIGRATIONS )); then
  printf '\n'
  warn "the current release carries ${CURRENT_MIGRATIONS} migrations, the target ${TARGET_MIGRATIONS}."
  warn "the database schema is AHEAD of the code you are rolling back to."
  warn "if those migrations were additive the old code will usually still run."
  warn "if they dropped or renamed anything, restore the pre-deploy snapshot instead."
  printf '\n'
  if [[ "${FORCE:-no}" != "yes" ]]; then
    read -r -p "    Continue anyway? [y/N] " reply
    [[ "$reply" == [yY] ]] || die "aborted"
  fi
fi

# ---------------------------------------------------------------------------
# Swap and verify
# ---------------------------------------------------------------------------
ln -sfn "$TARGET" "${CURRENT_LINK}.new"
mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"
systemctl restart "${API_SERVICE}.service"
systemctl reload nginx
ok "symlink swapped and service restarted"

HEALTH_URL="http://127.0.0.1:${API_PORT}${HEALTH_PATH}"
healthy=0
for (( i = 0; i < HEALTH_TIMEOUT_SECONDS; i++ )); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done

if (( healthy )); then
  ok "healthy after ${i}s"
  printf '\n\033[1;32mRolled back to %s.\033[0m\n\n' "$(basename "$TARGET")"
else
  printf '\n'
  journalctl -u "${API_SERVICE}.service" -n 40 --no-pager | sed 's/^/    /'
  die "the rollback target is also unhealthy. This is usually a database or
    configuration problem rather than a code problem — check the logs above
    before rolling back further."
fi
