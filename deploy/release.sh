#!/usr/bin/env bash
#
# WOROOD HUB — build and release
#
#   sudo bash deploy/release.sh              # release the current checkout
#   sudo bash deploy/release.sh v1.2.0       # fetch and release a tag
#
# Builds the API and the web bundle into a timestamped release directory,
# swaps an atomic symlink, restarts the service, and waits for the health
# endpoint. If the new release does not come up healthy within
# HEALTH_TIMEOUT_SECONDS, the symlink is swapped back and the previous
# release is restarted — so a failed deploy costs seconds of downtime rather
# than an outage.
#
# Migrations are NOT run here. They run in the service unit's ExecStartPre,
# so a migration that fails prevents the new version from serving traffic at
# all, and it fails the health gate below, which triggers the rollback.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy.env
source "${SCRIPT_DIR}/deploy.env"

TARGET_REF="${1:-}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mfailed:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"
[[ -d "$REPO_DIR/.git" ]] || die "no git checkout at ${REPO_DIR}"
[[ -f "$API_ENV_FILE" ]] || die "no ${API_ENV_FILE} — run ec2-bootstrap.sh first"

# Remember where we were, so the rollback path has somewhere to go.
#
# Only a directory that actually contains a runnable release counts. On the
# very first deploy the symlink points at the bootstrap placeholder, and
# "rolling back" to that would restart the service against nothing and turn
# a failed deploy into a confusing one.
PREVIOUS_RELEASE=""
if [[ -L "$CURRENT_LINK" ]]; then
  candidate="$(readlink -f "$CURRENT_LINK")"
  if [[ -f "${candidate}/api/${API_ENTRYPOINT}" ]]; then
    PREVIOUS_RELEASE="$candidate"
  fi
fi

# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------
log "Source"

cd "$REPO_DIR"

if [[ -n "$TARGET_REF" ]]; then
  git fetch --all --tags --prune
  git checkout --detach "$TARGET_REF"
  ok "checked out ${TARGET_REF}"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  warn "working tree is dirty — releasing uncommitted changes"
  git status --short | sed 's/^/         /'
fi

GIT_SHA="$(git rev-parse --short HEAD)"
GIT_DESC="$(git describe --tags --always --dirty 2>/dev/null || echo "$GIT_SHA")"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${GIT_SHA}"
RELEASE_DIR="${RELEASES_DIR}/${RELEASE_ID}"

ok "releasing ${GIT_DESC} as ${RELEASE_ID}"

[[ -e "$RELEASE_DIR" ]] && die "release directory already exists: ${RELEASE_DIR}"
install -d -m 0755 "${RELEASE_DIR}/api" "${RELEASE_DIR}/web"

# Anything that goes wrong from here leaves a half-built release behind.
# Clean it up rather than filling the disk with abandoned attempts.
cleanup_failed_build() {
  local code=$?
  if (( code != 0 )) && [[ -d "$RELEASE_DIR" ]] && [[ "$(readlink -f "$CURRENT_LINK" 2>/dev/null)" != "$RELEASE_DIR" ]]; then
    warn "removing incomplete release ${RELEASE_ID}"
    rm -rf "$RELEASE_DIR"
  fi
  exit $code
}
trap cleanup_failed_build EXIT

# ---------------------------------------------------------------------------
# Build the API
# ---------------------------------------------------------------------------
log "Building API"

cd "${REPO_DIR}/${API_DIR}"
[[ -f package.json ]] || die "no package.json in ${REPO_DIR}/${API_DIR} — check API_DIR in deploy.env"

npm ci --no-audit --no-fund
eval "$API_BUILD_CMD"

[[ -d "$API_BUILD_OUT" ]] || die "build produced no ${API_BUILD_OUT}/ — check API_BUILD_CMD and API_BUILD_OUT in deploy.env"
ok "compiled to ${API_BUILD_OUT}/"

cp -a "${API_BUILD_OUT}/." "${RELEASE_DIR}/api/"
cp package.json "${RELEASE_DIR}/api/"
[[ -f package-lock.json ]] && cp package-lock.json "${RELEASE_DIR}/api/"

# Migration SQL is data the runner reads at runtime, not code the compiler
# bundles, so it has to be copied explicitly. If it is missing at runtime the
# migration step is a silent no-op and the schema never advances, which is a
# far worse failure than a loud one.
MIG_SRC="${REPO_DIR}/${API_DIR}/${MIGRATIONS_SRC}"
MIG_DEST="${RELEASE_DIR}/api/$(dirname "${MIGRATE_ENTRYPOINT}")/migrations"
if [[ -d "$MIG_SRC" ]]; then
  install -d "$MIG_DEST"
  cp -a "${MIG_SRC}/." "${MIG_DEST}/"
  ok "$(find "$MIG_DEST" -name '*.sql' | wc -l) migration files staged"
else
  warn "no migrations at ${MIG_SRC} — check MIGRATIONS_SRC in deploy.env"
fi

log "Installing production dependencies"
cd "${RELEASE_DIR}/api"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
ok "$(du -sh node_modules | cut -f1) of production dependencies"

[[ -f "${RELEASE_DIR}/api/${API_ENTRYPOINT}" ]] \
  || die "entrypoint missing: ${RELEASE_DIR}/api/${API_ENTRYPOINT} — check API_ENTRYPOINT in deploy.env"

# ---------------------------------------------------------------------------
# Build the web bundle
# ---------------------------------------------------------------------------
log "Building portal"

cd "${REPO_DIR}/${WEB_DIR}"
[[ -f package.json ]] || die "no package.json in ${REPO_DIR}/${WEB_DIR} — check WEB_DIR in deploy.env"

npm ci --no-audit --no-fund
eval "$WEB_BUILD_CMD"

[[ -d "$WEB_BUILD_OUT" ]] || die "build produced no ${WEB_BUILD_OUT}/ — check WEB_BUILD_CMD in deploy.env"
cp -a "${WEB_BUILD_OUT}/." "${RELEASE_DIR}/web/"
[[ -f "${RELEASE_DIR}/web/index.html" ]] || die "no index.html in the web bundle"
ok "$(du -sh "${RELEASE_DIR}/web" | cut -f1) bundle, $(find "${RELEASE_DIR}/web" -type f | wc -l) files"

# ---------------------------------------------------------------------------
# Record what this release is
# ---------------------------------------------------------------------------
cat > "${RELEASE_DIR}/RELEASE" <<META
release_id   ${RELEASE_ID}
git_describe ${GIT_DESC}
git_sha      $(git -C "$REPO_DIR" rev-parse HEAD)
built_at     $(date -u +%Y-%m-%dT%H:%M:%SZ)
built_by     ${SUDO_USER:-root}
node         $(node -v)
META

chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$RELEASE_DIR"
chmod -R go-w "$RELEASE_DIR"

# ---------------------------------------------------------------------------
# Activate
# ---------------------------------------------------------------------------
log "Activating"

# Atomic: build the new symlink beside the old one, then rename over it.
# A plain `ln -sfn` unlinks first and leaves a window where nginx has no root.
ln -sfn "$RELEASE_DIR" "${CURRENT_LINK}.new"
mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"
ok "current -> ${RELEASE_ID}"

systemctl restart "${API_SERVICE}.service"
systemctl reload nginx

# ---------------------------------------------------------------------------
# Health gate
# ---------------------------------------------------------------------------
log "Waiting for health"

# Checked on loopback rather than through nginx, so a DNS or certificate
# problem cannot be mistaken for an application failure.
#
# nginx proxies /api/ to the Node process without rewriting the path, so the
# application sees the same path the browser sent. If your nginx config
# strips the prefix instead, set HEALTH_PATH in deploy.env to the path the
# application itself serves.
HEALTH_URL="http://127.0.0.1:${API_PORT}${HEALTH_PATH}"

healthy=0
for (( i = 0; i < HEALTH_TIMEOUT_SECONDS; i++ )); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  if ! systemctl is-active --quiet "${API_SERVICE}.service"; then
    warn "service stopped during startup"
    break
  fi
  sleep 1
done

if (( healthy )); then
  ok "healthy after ${i}s at ${HEALTH_URL}"
else
  printf '\n\033[1;31mHealth check failed.\033[0m Last 40 log lines:\n\n'
  journalctl -u "${API_SERVICE}.service" -n 40 --no-pager | sed 's/^/    /'

  if [[ -n "$PREVIOUS_RELEASE" ]] && [[ -d "$PREVIOUS_RELEASE" ]]; then
    log "Rolling back to $(basename "$PREVIOUS_RELEASE")"
    ln -sfn "$PREVIOUS_RELEASE" "${CURRENT_LINK}.new"
    mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"
    systemctl restart "${API_SERVICE}.service" || true
    systemctl reload nginx || true
    warn "rolled back. The failed release is kept at ${RELEASE_DIR} for inspection."
    trap - EXIT
    exit 1
  fi

  die "no previous release to roll back to — the instance is down.
    Investigate with: journalctl -u ${API_SERVICE} -n 200
    A migration failure is the most likely cause on a first deploy."
fi

trap - EXIT

# ---------------------------------------------------------------------------
# Prune
# ---------------------------------------------------------------------------
log "Pruning old releases"

mapfile -t all_releases < <(find "$RELEASES_DIR" -maxdepth 1 -mindepth 1 -type d | sort -r)
kept=0
for dir in "${all_releases[@]}"; do
  if [[ "$dir" == "$(readlink -f "$CURRENT_LINK")" ]] || (( kept < KEEP_RELEASES )); then
    (( kept++ ))
    continue
  fi
  rm -rf "$dir"
  ok "removed $(basename "$dir")"
done
ok "${kept} releases kept, $(df -h --output=avail "$DEPLOY_ROOT" | tail -1 | tr -d ' ') free"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
cat <<SUMMARY

$(printf '\033[1;32m%s\033[0m' "Released ${GIT_DESC} (${RELEASE_ID}).")

  systemctl status ${API_SERVICE}
  journalctl -u ${API_SERVICE} -f
  curl -s https://${HUB_HOSTNAME}${HEALTH_PATH}

  Roll back:  bash ${SCRIPT_DIR}/rollback.sh

SUMMARY
