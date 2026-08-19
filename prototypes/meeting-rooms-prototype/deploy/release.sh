#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# WOROOD HUB — build and release on the EC2 instance
#   sudo -u worood bash deploy/release.sh [git-ref]
# ---------------------------------------------------------------------------
set -euo pipefail

REF="${1:-main}"
APP_DIR="/opt/worood-hub"
SRC_DIR="${APP_DIR}/src"
REPO="${WOROOD_REPO:-git@github.com:worood/worood-hub.git}"

echo "==> Fetching ${REF}"
if [[ -d "${SRC_DIR}/.git" ]]; then
  git -C "$SRC_DIR" fetch --all --prune
  git -C "$SRC_DIR" checkout "$REF"
  git -C "$SRC_DIR" reset --hard "origin/${REF}"
else
  git clone "$REPO" "$SRC_DIR"
  git -C "$SRC_DIR" checkout "$REF"
fi

echo "==> Building API"
cd "${SRC_DIR}/apps/api"
npm ci --omit=dev --ignore-scripts
npm install --no-save typescript @types/node
npm run build

echo "==> Building portal"
cd "${SRC_DIR}/apps/web"
npm ci
npm run build

echo "==> Publishing"
rm -rf "${APP_DIR}/api"
mkdir -p "${APP_DIR}/api"
cp -r "${SRC_DIR}/apps/api/dist" "${APP_DIR}/api/dist"
cp -r "${SRC_DIR}/apps/api/node_modules" "${APP_DIR}/api/node_modules"
cp "${SRC_DIR}/apps/api/package.json" "${APP_DIR}/api/"
# The migration runner reads .sql files from beside the compiled output.
mkdir -p "${APP_DIR}/api/dist/db/migrations"
cp "${SRC_DIR}/apps/api/src/db/migrations/"*.sql "${APP_DIR}/api/dist/db/migrations/"

rm -rf "${APP_DIR}/web"
cp -r "${SRC_DIR}/apps/web/dist" "${APP_DIR}/web"

echo "==> Restarting service (migrations run in ExecStartPre)"
sudo systemctl restart worood-hub-api
sleep 4
sudo systemctl is-active --quiet worood-hub-api && echo "    service is active"

echo "==> Health check"
curl -fsS http://127.0.0.1:3000/api/v1/health && echo

echo "Release complete: $(git -C "$SRC_DIR" rev-parse --short HEAD)"
