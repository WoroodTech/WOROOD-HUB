# WOROOD HUB

Modular enterprise intranet portal for Worood. Module 1 is the **Meeting Room Reservation System**.

The full technical design — stack rationale, database structure, architecture, security model and AWS EC2 sizing — is in [`docs/WOROOD-HUB-Technical-Design.md`](docs/WOROOD-HUB-Technical-Design.md).

---

## Stack

Node.js 22 · TypeScript · NestJS · Drizzle ORM · PostgreSQL 16 · React 18 · Vite · nginx · systemd

## Running locally

Requires Node 22 and either Docker or a local PostgreSQL 16.

```bash
# 1. Database
docker compose up -d                # or use an existing PostgreSQL 16 instance

# 2. API  (http://localhost:3000, docs at /api/docs)
cd apps/api
cp .env.example .env                # then set DATABASE_URL and the JWT secrets
npm install
npm run db:reset                    # migrate + seed 8 rooms, 7 employees, sample bookings
npm run dev

# 3. Portal  (http://localhost:5173)
cd ../web
npm install
npm run dev
```

Sign in with `admin@worood.co` / `Worood@2026`. Other demo accounts are listed on the login screen.

## Tests

```bash
cd apps/api
npm test                            # 20 unit tests — availability arithmetic
npm run test:e2e                    # 56 end-to-end tests against a running API
```

`test:e2e` includes the concurrency check: eight simultaneous requests for one slot must produce exactly one booking and seven `409 Conflict` responses.

## Deploying to EC2

```bash
sudo bash deploy/ec2-bootstrap.sh   # once, on a fresh Ubuntu 24.04 instance
sudo -u worood bash deploy/release.sh
sudo certbot --nginx -d hub.worood.co
```

`ec2-bootstrap.sh` installs Node, PostgreSQL with `btree_gist`, nginx, the firewall and the systemd unit, and generates the environment file with fresh secrets. `release.sh` builds both applications and restarts the service; migrations run before the process starts, so a failed migration never serves traffic.

## How double booking is prevented

Not by checking before inserting — that races. A PostgreSQL GiST exclusion constraint makes non-overlap an invariant of the database itself:

```sql
EXCLUDE USING gist (
  room_id                             WITH =,
  tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status IN ('PENDING', 'CONFIRMED'))
```

The API translates SQLSTATE `23P01` into a `409` that names the meeting already holding the slot.

## Adding a module

1. `src/modules/<key>/` — controllers, services, DTOs
2. One SQL migration creating `<prefix>_*` tables
3. A `registerHubModule({ … })` descriptor declaring navigation, portlets and permissions
4. Two lines in `app.module.ts`

Navigation, the dashboard grid and the RBAC permission set all follow from the descriptor. No existing module or the portal shell is edited.
