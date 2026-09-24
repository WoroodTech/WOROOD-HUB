#!/usr/bin/env bash
#
# WOROOD HUB — one-time EC2 instance preparation
#
#   sudo bash deploy/ec2-bootstrap.sh
#
# Idempotent: safe to re-run. It will not regenerate secrets that already
# exist, and it will not overwrite an nginx site that certbot has since
# edited.
#
# Prepares: Node, PostgreSQL with the required extensions and tuning, the
# service account, the environment file, nginx, the systemd units, the
# firewall, and unattended security upgrades.
#
# It does NOT deploy the application. Run deploy/release.sh for that.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy.env
source "${SCRIPT_DIR}/deploy.env"

STAMP_FILE="${CONFIG_DIR}/.bootstrapped"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mfailed:\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "line $LINENO failed. Nothing further was changed; fix the cause and re-run."' ERR

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
log "Preflight"

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"

if ! grep -qi ubuntu /etc/os-release; then
  die "this script targets Ubuntu Server. Found: $(sed -n 's/^PRETTY_NAME=//p' /etc/os-release)"
fi

CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
ARCH="$(dpkg --print-architecture)"
ok "Ubuntu ${CODENAME} on ${ARCH}"

# The data volume must be mounted before PostgreSQL is installed, or the
# cluster is initialised on the root volume and then hidden by the mount.
# This is the single most expensive mistake available at this step, so it is
# a hard stop rather than a warning.
if ! mountpoint -q /var/lib/postgresql; then
  if [[ "${ALLOW_ROOT_VOLUME_DB:-no}" == "yes" ]]; then
    warn "/var/lib/postgresql is not a separate mount — continuing because ALLOW_ROOT_VOLUME_DB=yes"
  else
    die "/var/lib/postgresql is not a separate mount.
    Mount the data volume first (runbook §9), or re-run with
    ALLOW_ROOT_VOLUME_DB=yes if you genuinely intend the database to live
    on the root volume."
  fi
else
  ok "data volume mounted at /var/lib/postgresql ($(df -h --output=size /var/lib/postgresql | tail -1 | tr -d ' '))"
fi

TOTAL_MB="$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)"
ok "${TOTAL_MB} MB RAM detected"

if [[ -f "$STAMP_FILE" ]]; then
  warn "already bootstrapped on $(cat "$STAMP_FILE") — re-running idempotently"
fi

# ---------------------------------------------------------------------------
# Base packages
# ---------------------------------------------------------------------------
log "Base packages"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg lsb-release \
  git build-essential \
  nginx \
  ufw fail2ban unattended-upgrades \
  jq unzip rsync \
  postgresql-common \
  redis-server
ok "base packages installed"

# ---------------------------------------------------------------------------
# Node.js
# ---------------------------------------------------------------------------
log "Node.js ${NODE_MAJOR}.x"

if command -v node >/dev/null && [[ "$(node -v)" == v${NODE_MAJOR}.* ]]; then
  ok "already present: $(node -v)"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  rm -f /tmp/nodesource_setup.sh
  apt-get install -y -qq nodejs
  ok "installed $(node -v), npm $(npm -v)"
fi

# ---------------------------------------------------------------------------
# PostgreSQL
# ---------------------------------------------------------------------------
log "PostgreSQL ${PG_VERSION}"

if [[ ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  ok "PGDG repository added"
fi

apt-get install -y -qq "postgresql-${PG_VERSION}" "postgresql-contrib-${PG_VERSION}"
ok "$(sudo -u postgres psql --version)"

PG_CONF_DIR="/etc/postgresql/${PG_VERSION}/main"
[[ -d "$PG_CONF_DIR" ]] || die "expected cluster config at ${PG_CONF_DIR} — is the cluster initialised?"

# --- tuning -----------------------------------------------------------------
# shared_buffers at 25% of RAM and effective_cache_size at 75% is the standard
# starting point and matches the design document's figures at both 4 GB and
# 8 GB. effective_cache_size is a planner hint, not an allocation.
SHARED_BUFFERS_MB=$(( TOTAL_MB / 4 ))
EFFECTIVE_CACHE_MB=$(( TOTAL_MB * 3 / 4 ))
MAINT_WORK_MEM_MB=$(( TOTAL_MB / 16 ))
(( MAINT_WORK_MEM_MB > 512 )) && MAINT_WORK_MEM_MB=512

install -d "${PG_CONF_DIR}/conf.d"
sed -e "s/@SHARED_BUFFERS@/${SHARED_BUFFERS_MB}MB/" \
    -e "s/@EFFECTIVE_CACHE_SIZE@/${EFFECTIVE_CACHE_MB}MB/" \
    -e "s/@MAINTENANCE_WORK_MEM@/${MAINT_WORK_MEM_MB}MB/" \
    "${SCRIPT_DIR}/postgres/worood-hub-tuning.conf" \
    > "${PG_CONF_DIR}/conf.d/worood-hub.conf"

# Ensure the drop-in directory is actually read — it is by default on Debian
# packaging, but an edited postgresql.conf may have lost the include.
if ! grep -qE "^\s*include_dir\s*=\s*'conf\.d'" "${PG_CONF_DIR}/postgresql.conf"; then
  echo "include_dir = 'conf.d'" >> "${PG_CONF_DIR}/postgresql.conf"
fi

ok "tuning written: shared_buffers=${SHARED_BUFFERS_MB}MB effective_cache_size=${EFFECTIVE_CACHE_MB}MB"

systemctl enable --now postgresql
systemctl restart postgresql
sleep 2

# Verify the database is not listening on anything but loopback. The tuning
# file sets listen_addresses, but a stale postgresql.conf could override it,
# and an exposed 5432 is the kind of thing nobody notices until it matters.
if ss -lntH 'sport = :5432' | grep -qv '127.0.0.1\|::1'; then
  die "PostgreSQL is listening on a non-loopback address. Check ${PG_CONF_DIR}/postgresql.conf for a later listen_addresses line."
fi
ok "PostgreSQL bound to loopback only"

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------
# Not optional. The sales module keeps the Shopify access token, the shared
# rate-limit bucket and the webhook queue in Redis; without it the module
# cannot fetch a token at all, so every sync fails and the dashboards stay
# empty. It used to be listed as "Module 2, uncomment when it ships" -- it has
# shipped.
log "Redis"

REDIS_CONF_SRC="${SCRIPT_DIR}/redis/worood-hub-redis.conf"
REDIS_CONF_DST="/etc/redis/redis.conf.d/worood-hub.conf"

if [[ -f "$REDIS_CONF_SRC" ]]; then
  install -d -m 0755 /etc/redis/redis.conf.d
  install -o redis -g redis -m 0640 "$REDIS_CONF_SRC" "$REDIS_CONF_DST"
  # Debian's packaged redis.conf does not include a conf.d directory by
  # default, so the include is added once rather than assumed.
  if ! grep -q 'redis.conf.d' /etc/redis/redis.conf; then
    printf '\n# WOROOD HUB overrides\ninclude %s\n' "$REDIS_CONF_DST" >> /etc/redis/redis.conf
  fi
  ok "installed ${REDIS_CONF_DST}"
else
  warn "no redis/worood-hub-redis.conf found — using the packaged defaults"
fi

systemctl enable --now redis-server >/dev/null 2>&1 || true
systemctl restart redis-server

# Same check as PostgreSQL above, for the same reason: an exposed 6379 holds a
# live Shopify access token and is the kind of thing nobody notices until it
# matters.
if ss -lntH 'sport = :6379' | grep -qv '127.0.0.1\|::1'; then
  die "Redis is listening on a non-loopback address. Check /etc/redis/redis.conf for a later bind line."
fi

if redis-cli ping 2>/dev/null | grep -q PONG; then
  ok "Redis answering on loopback"
else
  die "Redis installed but not answering. Check: journalctl -u redis-server -n 50"
fi

# ---------------------------------------------------------------------------
# Service account
# ---------------------------------------------------------------------------
log "Service account"

if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "user ${SERVICE_USER} exists"
else
  useradd --system --create-home --home-dir "/var/lib/${SERVICE_USER}" \
          --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "created system user ${SERVICE_USER}"
fi

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "$DEPLOY_ROOT" "$RELEASES_DIR"
install -d -o root -g "$SERVICE_GROUP" -m 0750 "$CONFIG_DIR"
ok "directories prepared under ${DEPLOY_ROOT}"

# ---------------------------------------------------------------------------
# Database role, database and extensions
# ---------------------------------------------------------------------------
log "Database"

ROLE_EXISTS="$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" || true)"

if [[ -f "$API_ENV_FILE" ]] && [[ "$ROLE_EXISTS" == "1" ]]; then
  # Both already exist — do not touch the password, or the running service
  # loses its database.
  DB_PASS=""
  ok "role ${DB_USER} and environment file both exist — password left alone"
else
  DB_PASS="$(openssl rand -hex 24)"
  if [[ "$ROLE_EXISTS" == "1" ]]; then
    sudo -u postgres psql -qX -v ON_ERROR_STOP=1 \
      -c "ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';"
    warn "role existed but no environment file — password reset"
  else
    sudo -u postgres psql -qX -v ON_ERROR_STOP=1 \
      -c "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';"
    ok "role ${DB_USER} created"
  fi
fi

if [[ "$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" || true)" != "1" ]]; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  ok "database ${DB_NAME} created"
else
  ok "database ${DB_NAME} exists"
fi

# btree_gist is not optional. The exclusion constraint that makes double
# booking impossible needs equality on room_id inside a GiST index, which
# btree_gist is what provides. Without it, migration 0002 fails and the
# service refuses to start — correct behaviour, opaque symptom.
for ext in btree_gist citext pgcrypto; do
  sudo -u postgres psql -qX -v ON_ERROR_STOP=1 -d "$DB_NAME" \
    -c "CREATE EXTENSION IF NOT EXISTS ${ext};"
done
ok "extensions: $(sudo -u postgres psql -tAc "SELECT string_agg(extname, ', ' ORDER BY extname) FROM pg_extension" -d "$DB_NAME")"

# ---------------------------------------------------------------------------
# Environment file
# ---------------------------------------------------------------------------
log "Environment file"

if [[ -f "$API_ENV_FILE" ]]; then
  ok "${API_ENV_FILE} exists — left untouched"
  warn "if you changed HUB_HOSTNAME, update CORS_ORIGIN and PORTAL_URL by hand"
else
  umask 077
  cat > "$API_ENV_FILE" <<ENVFILE
# WOROOD HUB — API environment
# Generated by ec2-bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# This file contains secrets. It is not in version control and must not be.

NODE_ENV=production
PORT=${API_PORT}
TZ=UTC

DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}

JWT_ACCESS_SECRET=$(openssl rand -base64 48)
JWT_REFRESH_SECRET=$(openssl rand -base64 48)
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d

CORS_ORIGIN=https://${HUB_HOSTNAME}
PORTAL_URL=https://${HUB_HOSTNAME}

# --- Redis (required by the sales module) ---
REDIS_URL=redis://127.0.0.1:6379

# --- Shopify ---
# The service REFUSES TO START until CLIENT_ID and CLIENT_SECRET are filled in.
# That is deliberate: with no fixture source to fall back on, a missing
# credential would otherwise mean a service that starts, fails every sync in a
# log nobody reads, and shows an empty store.
#
# Take both from the custom-distribution app in the Shopify Dev Dashboard.
# The client secret doubles as the webhook HMAC key.
SHOPIFY_TOKEN_STRATEGY=client_credentials
SHOPIFY_SHOP_DOMAIN=CHANGE_ME.myshopify.com
SHOPIFY_CLIENT_ID=CHANGE_ME
SHOPIFY_CLIENT_SECRET=CHANGE_ME
SHOPIFY_API_VERSION=2026-07
SHOPIFY_WEBHOOK_BASE_URL=https://${HUB_HOSTNAME}

# Scheduled sync. Set to false on all but one instance if this ever runs
# behind a load balancer.
SHOPIFY_SCHEDULE_ENABLED=true

# 200 for Advanced, 1000 for Plus.
SHOPIFY_COST_RESTORE_RATE=200
ENVFILE
  umask 022
  ok "generated ${API_ENV_FILE} with fresh secrets"
  warn "SHOPIFY_* placeholders must be filled in before the API will start"
  warn "edit ${API_ENV_FILE}, then: systemctl restart ${API_SERVICE}"
fi

chown root:"$SERVICE_GROUP" "$API_ENV_FILE"
chmod 0640 "$API_ENV_FILE"
ok "permissions: $(stat -c '%U:%G %a' "$API_ENV_FILE")"

# ---------------------------------------------------------------------------
# nginx
# ---------------------------------------------------------------------------
log "nginx"

# The rate-limit zone must live in the http context, so it is a separate file
# in conf.d rather than part of the server block.
install -m 0644 "${SCRIPT_DIR}/nginx/worood-hub-limits.conf" /etc/nginx/conf.d/worood-hub-limits.conf

SITE_AVAILABLE="/etc/nginx/sites-available/${APP_NAME}.conf"
SITE_ENABLED="/etc/nginx/sites-enabled/${APP_NAME}.conf"

if [[ -f "$SITE_AVAILABLE" ]] && grep -q "ssl_certificate" "$SITE_AVAILABLE"; then
  # certbot --nginx rewrites this file in place to add the certificate and
  # the redirect. Overwriting it here would silently remove TLS.
  warn "${SITE_AVAILABLE} already contains a TLS block (certbot-managed) — not overwriting"
  warn "to re-apply the template, move the file aside and re-run certbot afterwards"
else
  sed "s/@HUB_HOSTNAME@/${HUB_HOSTNAME}/g; s#@DEPLOY_ROOT@#${DEPLOY_ROOT}#g; s/@API_PORT@/${API_PORT}/g" \
    "${SCRIPT_DIR}/nginx/worood-hub.conf" > "$SITE_AVAILABLE"
  ok "site written for ${HUB_HOSTNAME}"
fi

ln -sfn "$SITE_AVAILABLE" "$SITE_ENABLED"
rm -f /etc/nginx/sites-enabled/default

# The web root does not exist until the first release. nginx refuses to start
# with a missing root on some configurations, so create a placeholder.
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0755 "${CURRENT_LINK}-placeholder/web"
if [[ ! -e "$CURRENT_LINK" ]]; then
  cat > "${CURRENT_LINK}-placeholder/web/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>WOROOD HUB</title>
<body style="font:16px system-ui;padding:3rem;max-width:34rem;margin:auto">
<h1>WOROOD HUB</h1><p>The instance is prepared. No release has been deployed yet.</p>
</body>
HTML
  ln -sfn "${CURRENT_LINK}-placeholder" "$CURRENT_LINK"
  ok "placeholder page installed until the first release"
fi

nginx -t
systemctl enable --now nginx
systemctl reload nginx
ok "nginx configured and reloaded"

# ---------------------------------------------------------------------------
# systemd units
# ---------------------------------------------------------------------------
log "systemd units"

render_unit() {
  local src="$1" dest="$2"
  sed -e "s#@DEPLOY_ROOT@#${DEPLOY_ROOT}#g" \
      -e "s#@CURRENT_LINK@#${CURRENT_LINK}#g" \
      -e "s#@API_ENV_FILE@#${API_ENV_FILE}#g" \
      -e "s/@SERVICE_USER@/${SERVICE_USER}/g" \
      -e "s/@SERVICE_GROUP@/${SERVICE_GROUP}/g" \
      -e "s#@API_ENTRYPOINT@#${API_ENTRYPOINT}#g" \
      -e "s#@MIGRATE_ENTRYPOINT@#${MIGRATE_ENTRYPOINT}#g" \
      -e "s/@API_MEMORY_MAX@/${API_MEMORY_MAX}/g" \
      -e "s/@WORKER_MEMORY_MAX@/${WORKER_MEMORY_MAX}/g" \
      "$src" > "$dest"
}

render_unit "${SCRIPT_DIR}/systemd/worood-hub-api.service" "/etc/systemd/system/${API_SERVICE}.service"
ok "${API_SERVICE}.service installed"

# The worker is Module 2's. Install it so it is ready, but do not enable it —
# starting a queue consumer with no queue configured just produces noise.
if [[ -f "${SCRIPT_DIR}/systemd/worood-hub-worker.service" ]]; then
  render_unit "${SCRIPT_DIR}/systemd/worood-hub-worker.service" "/etc/systemd/system/${WORKER_SERVICE}.service"
  ok "${WORKER_SERVICE}.service installed (not enabled — Module 2)"
fi

sed "s/@BACKUP_BUCKET@/${BACKUP_BUCKET}/g" \
  "${SCRIPT_DIR}/systemd/worood-hub-backup.service" \
  > /etc/systemd/system/worood-hub-backup.service
chmod 0644 /etc/systemd/system/worood-hub-backup.service
install -m 0644 "${SCRIPT_DIR}/systemd/worood-hub-backup.timer" /etc/systemd/system/
ok "backup service and timer installed (enable after creating the S3 bucket)"

systemctl daemon-reload
systemctl enable "${API_SERVICE}.service" >/dev/null
ok "${API_SERVICE} enabled (not started — no release deployed yet)"

# ---------------------------------------------------------------------------
# Scripts onto the PATH
# ---------------------------------------------------------------------------
log "Operator scripts"

install -m 0755 "${SCRIPT_DIR}/backup.sh"  /usr/local/bin/worood-hub-backup
install -m 0755 "${SCRIPT_DIR}/restore.sh" /usr/local/bin/worood-hub-restore
ok "worood-hub-backup and worood-hub-restore available on PATH"

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------
log "Firewall"

# No SSH rule. Access is via AWS Systems Manager Session Manager, which is an
# outbound connection from this instance — there is no inbound port to open.
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 80/tcp  comment 'HTTP - ACME challenge and redirect' >/dev/null
ufw allow 443/tcp comment 'HTTPS - portal' >/dev/null
ufw --force enable >/dev/null
ok "ufw active: $(ufw status | grep -c ALLOW) allow rules, default deny inbound"

# ---------------------------------------------------------------------------
# fail2ban and unattended upgrades
# ---------------------------------------------------------------------------
log "Hardening"

cat > /etc/fail2ban/jail.d/worood-hub.local <<'JAIL'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled  = true
logpath  = /var/log/nginx/error.log
JAIL

systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban
ok "fail2ban active"

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTOUP'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AUTOUP
ok "unattended security upgrades enabled (kernel updates still need a reboot)"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
date -u +%Y-%m-%dT%H:%M:%SZ > "$STAMP_FILE"

cat <<SUMMARY

$(printf '\033[1;32m%s\033[0m' "Bootstrap complete.")

  Node            $(node -v)
  PostgreSQL      $(sudo -u postgres psql -tAc 'SHOW server_version')
  shared_buffers  $(sudo -u postgres psql -tAc 'SHOW shared_buffers')
  Database        ${DB_NAME} owned by ${DB_USER}
  Service user    ${SERVICE_USER}
  Env file        ${API_ENV_FILE} ($(stat -c '%U:%G %a' "$API_ENV_FILE"))
  Web root        ${CURRENT_LINK}/web
  Hostname        ${HUB_HOSTNAME}

Next, in order:

  1. Issue the TLS certificate — the DNS A record must already resolve here:
       snap install --classic certbot && ln -sf /snap/bin/certbot /usr/bin/certbot
       certbot --nginx -d ${HUB_HOSTNAME} --agree-tos -m ${ADMIN_EMAIL} --redirect

  2. Deploy the first release:
       bash ${SCRIPT_DIR}/release.sh

  3. Create the S3 bucket, then enable nightly backups:
       systemctl enable --now worood-hub-backup.timer
       systemctl start worood-hub-backup.service   # run one now
       aws s3 ls s3://${BACKUP_BUCKET}/ --recursive

SUMMARY
