#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# WOROOD HUB — EC2 bootstrap (Ubuntu 22.04/24.04 LTS, arm64 or x86_64)
#
# Run once on a fresh instance as root. Idempotent: safe to re-run.
#   sudo bash ec2-bootstrap.sh
# ---------------------------------------------------------------------------
set -euo pipefail

APP_USER="worood"
APP_DIR="/opt/worood-hub"
NODE_MAJOR=22
DB_NAME="worood_hub"
DB_USER="worood"

echo "==> Updating base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ca-certificates gnupg ufw fail2ban unattended-upgrades nginx

echo "==> Installing Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing PostgreSQL 16 (single-instance deployment)"
apt-get install -y postgresql-16 postgresql-contrib-16

echo "==> Creating application user and directory"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "==> Creating database role and database"
DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 28)"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres createdb -O "${DB_USER}" "${DB_NAME}"

# btree_gist backs the no-double-booking exclusion constraint.
sudo -u postgres psql -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS btree_gist;"
sudo -u postgres psql -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
sudo -u postgres psql -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS citext;"

echo "==> PostgreSQL tuning for a 4 GB instance"
PG_CONF="/etc/postgresql/16/main/conf.d/worood.conf"
cat > "$PG_CONF" <<'EOF'
shared_buffers = 1GB
effective_cache_size = 3GB
work_mem = 16MB
maintenance_work_mem = 256MB
max_connections = 100
wal_level = replica
random_page_cost = 1.1          # gp3 SSD, not spinning disk
log_min_duration_statement = 500ms
timezone = 'UTC'
EOF
systemctl restart postgresql

echo "==> Writing environment file"
ENV_FILE="${APP_DIR}/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}
JWT_ACCESS_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=2592000
CORS_ORIGINS=https://hub.worood.co
DEFAULT_TIMEZONE=Africa/Cairo
DB_POOL_MAX=15
EOF
  chown "$APP_USER":"$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "    Generated ${ENV_FILE} — database password stored there only."
fi

echo "==> Firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> Nginx site"
cp "$(dirname "$0")/nginx/worood-hub.conf" /etc/nginx/sites-available/worood-hub
ln -sf /etc/nginx/sites-available/worood-hub /etc/nginx/sites-enabled/worood-hub
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> systemd service"
cp "$(dirname "$0")/systemd/worood-hub-api.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable worood-hub-api

echo "==> Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

cat <<'EOF'

Bootstrap complete.

Next steps:
  1. Deploy the application:   sudo -u worood bash deploy/release.sh
  2. Issue a TLS certificate:  sudo apt-get install -y certbot python3-certbot-nginx
                               sudo certbot --nginx -d hub.worood.co
  3. Schedule backups:         sudo cp deploy/backup.sh /usr/local/bin/worood-backup
                               sudo crontab -e   →   0 1 * * * /usr/local/bin/worood-backup

EOF
