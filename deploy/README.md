# `deploy/` — WOROOD HUB operations

Everything needed to take a bare Ubuntu EC2 instance to a running portal, and to keep it running afterwards. The companion document is `WOROOD-HUB-AWS-Deployment-Runbook.md`, which covers the AWS side (account, region, IAM, security groups, DNS, backups, alarms); this directory is the part that lives on the instance.

---

## Before you run anything: verify `deploy.env`

Every assumption these scripts make about the repository is in `deploy.env`. Four of them were written against the Technical Design Document rather than against the code, and are the most likely to be wrong:

| Variable | Default | Check |
|---|---|---|
| `API_BUILD_CMD` / `WEB_BUILD_CMD` | `npm run build` | `jq .scripts apps/api/package.json` |
| `API_ENTRYPOINT` | `main.js` | is it `dist/main.js` after a build? |
| `MIGRATE_ENTRYPOINT` | `db/migrate.js` | where does `src/db/migrate.ts` compile to? |
| `HEALTH_PATH` | `/api/v1/health` | the design doc says `/health` in §5 and `/healthz` in §8.4 — pick one |

All four were checked against the code and are correct as they stand:
`main.js` and `db/migrate.js` are both present in `dist` after a build, and
`@Get('health')` on the core controller resolves to `/api/v1/health`.

Getting `HEALTH_PATH` wrong makes every deploy look like a failure and triggers an automatic rollback, so it is worth thirty seconds with `curl` before the first release.

---

## Before the first release: fill in the Shopify credentials

`ec2-bootstrap.sh` writes `/etc/worood-hub/api.env` with fresh JWT secrets and
`CHANGE_ME` placeholders for Shopify. **The API refuses to start until those are
real.**

```bash
sudo nano /etc/worood-hub/api.env     # SHOPIFY_SHOP_DOMAIN, CLIENT_ID, CLIENT_SECRET
sudo systemctl restart worood-hub-api
```

That refusal is deliberate. There used to be a fixture source replaying captured
JSON, so a missing credential was survivable. The fixtures are gone, and without
the check the failure would be the quietest kind there is: the service starts,
every sync fails in a log nobody reads, and the dashboards show an empty store.

Set `SHOPIFY_TOKEN_STRATEGY=offline` to run the portal with the sales module not
talking to Shopify at all.

---

## What happens by itself after the first start

About ninety seconds in, a bootstrap runs and decides for itself what is needed:
shop settings, the initial order import, webhook registration, and thirteen
months of hour-grain history. Then the recurring jobs take over — reconciliation
every 15 minutes, abandoned checkouts every 30, snapshots hourly, the nightly
capture and store-credit export at 02:00 Cairo, watchdog and retention at 03:00.

Every step is idempotent by inspection: restarting the service ten times
performs the work once. **Nothing needs to be POSTed by hand after a deploy.**

```bash
journalctl -u worood-hub-api -f | grep bootstrap
```

Expect `bootstrap: imported N orders`, `bootstrap: registered 15 webhook
topics`, `bootstrap: complete`. On a store the size of Worood's the import takes
minutes; the portal serves normally throughout, because it runs on a timer
rather than in a request.

If you see `bootstrap: webhooks not registered — SHOPIFY_WEBHOOK_BASE_URL is not
set`, that is the one thing to go back and fix. Reconciliation still covers you
every fifteen minutes in the meantime.

---

## After the first release: verify the figures

Deploying successfully is not the same as the numbers being right. One command
settles it:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://hub.worood.co/api/v1/sales/admin/sync/reconcile-check?date=2026-09-06" | jq .verdict
```

It compares three independent sources for one day — Shopify's own order count,
ShopifyQL's aggregate, and the mirror — and returns a plain verdict rather than
a table to interpret. Run it for a normal day, a day with refunds, and a day
with a cancellation.

Worth running every week or two thereafter. It is the cheapest thing that will
tell you something has broken, before anyone sees a wrong number and stops
trusting the screen.

---

## What is here

```
deploy/
├── deploy.env                        every path, version and build command — start here
├── ec2-bootstrap.sh                  one-time instance preparation (idempotent)
├── release.sh                        build, publish, swap, health-gate, auto-rollback
├── rollback.sh                       return to a previous release
├── backup.sh                         nightly pg_dump to S3, verified before upload
├── restore.sh                        restore, and the quarterly rehearsal
├── env/api.env.example               documents the runtime environment; the real one
│                                     is generated at /etc/worood-hub/api.env
├── nginx/
│   ├── worood-hub.conf               the site: TLS, SPA, API proxy, caching
│   └── worood-hub-limits.conf        rate-limit zones (http context — must be separate)
├── systemd/
│   ├── worood-hub-api.service        the API, hardened, migrations in ExecStartPre
│   ├── worood-hub-worker.service     Module 2 queue consumer (installed, not enabled)
│   ├── worood-hub-backup.service     nightly backup job
│   └── worood-hub-backup.timer       23:30 UTC
├── postgres/worood-hub-tuning.conf   memory, planner, logging, timeouts
├── redis/worood-hub-redis.conf       Module 2 only — queue semantics, not cache
└── cloudwatch/config.json            memory and disk metrics, log shipping
```

---

## First run, in order

```bash
# 1. Prepare the instance. Requires the data volume already mounted
#    at /var/lib/postgresql — the script refuses to continue otherwise.
sudo bash deploy/ec2-bootstrap.sh

# 2. TLS. The DNS A record must already point here.
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d hub.worood.co --agree-tos -m technology@worood.co --redirect

# 3. Uncomment the HSTS line in /etc/nginx/sites-available/worood-hub.conf,
#    then: sudo nginx -t && sudo systemctl reload nginx

# 4. First release.
sudo bash deploy/release.sh

# 5. Backups, once the S3 bucket exists.
sudo snap install aws-cli --classic
sudo systemctl enable --now worood-hub-backup.timer
sudo systemctl start worood-hub-backup.service
sudo journalctl -u worood-hub-backup -n 30
```

---

## Day to day

```bash
sudo bash deploy/release.sh v1.2.0     # release a tag
sudo bash deploy/rollback.sh --list    # what is on disk
sudo bash deploy/rollback.sh           # back one release
sudo worood-hub-restore --rehearse     # quarterly restore test
journalctl -u worood-hub-api -f        # live logs
```

---

## How a release works, and why

Releases are published into `/srv/worood-hub/releases/<timestamp>-<sha>/` and activated by renaming a symlink over `/srv/worood-hub/current`. Three things follow from that:

**Rollback is a symlink swap, not a rebuild.** `rollback.sh` finishes in the time it takes systemd to restart the service, because the previous release is still on disk with its `node_modules` intact.

**The swap is atomic.** `ln -sfn` unlinks before it links, which leaves a window — usually milliseconds, but real — where nginx has no document root. Creating the link beside the old one and using `mv -Tf` replaces it in a single rename, so no request ever sees a missing root.

**A failed deploy rolls itself back.** `release.sh` polls the health endpoint on loopback after the restart. If the service is not healthy within `HEALTH_TIMEOUT_SECONDS`, it swaps the symlink back, restarts the previous release, prints the last forty log lines, and exits non-zero — leaving the failed release on disk to inspect.

Migrations run in the service unit's `ExecStartPre`, not in `release.sh`. A migration that fails means the unit never reaches `ExecStart`, so a broken schema change cannot serve a single request; `release.sh` sees an unhealthy service and rolls back. Checking against loopback rather than through nginx means a DNS or certificate problem is never mistaken for an application failure.

---

## Things that will bite you

**Mount the data volume before bootstrapping.** If PostgreSQL is installed first, the cluster initialises on the root volume and the later mount hides it. `ec2-bootstrap.sh` hard-stops on this rather than warning, because the symptom — an empty database and a full root disk — arrives much later than the cause.

**certbot rewrites the nginx site file.** After the certificate is issued, the installed copy contains TLS directives that are not in this repository's template. `ec2-bootstrap.sh` detects that and refuses to overwrite it. If you change `nginx/worood-hub.conf` here after TLS is in place, apply the change to the installed copy by hand and keep the two in step.

**`MemoryDenyWriteExecute` is deliberately absent from the service units.** V8 compiles JavaScript to machine code at runtime and needs pages that are both writable and executable. Adding that directive — which every systemd hardening guide recommends — makes Node refuse to start.

**`btree_gist` is not optional.** The exclusion constraint that makes double booking impossible needs equality on `room_id` inside a GiST index. Without the extension, migration `0002` fails and the service will not start. The bootstrap script creates it; a restore into a fresh database must too, which is why `restore.sh` creates the extensions before running `pg_restore`.

**Set `trust proxy` in the application.** nginx passes `X-Forwarded-For`, but if NestJS is not configured to trust it, every audit-log entry records `127.0.0.1` as the source IP and the security model's IP recording is worthless.

**`index.html` must not be cached.** The nginx config sets `no-store` on it specifically. Hashed assets under `/assets/` are cached for a year because a new release changes the filename; the HTML shell that points at them cannot be, or returning visitors keep loading the previous bundle's asset names after every deploy.

**The demo accounts.** `admin@worood.co`, `facilities@worood.co` and `omar.khaled@worood.co` all share the password `Worood@2026` in the seeded environment. Nothing in these scripts seeds them, and nothing removes them either — that is a deliberate gap, because deciding what happens to them is a decision, not a default.

---

## What these scripts do not do

- **No CI/CD.** Releases are run by hand over Session Manager. That is the right amount of process for one instance and one operator; a GitHub Actions workflow that assumes an OIDC role and runs `release.sh` over SSM is the natural next step once more than one person deploys.
- **No staging.** The design document recommends a `t4g.small` mirror for rehearsing migrations. `deploy.env` is parameterised enough to serve one — point `HUB_HOSTNAME`, `DB_NAME` and `BACKUP_BUCKET` elsewhere.
- **No zero-downtime deploys.** `systemctl restart` drops in-flight requests. At 10–20 concurrent users on an internal portal this is a second of inconvenience, not an outage. If it ever matters, the API is already stateless — sessions live in the database — so an ALB in front of two instances is the answer, not a more elaborate script.
- **No journald shipping to CloudWatch.** The agent reads files, not the journal. If you want application logs in CloudWatch, add an rsyslog rule writing `worood-hub-api` to a file and add that file to `cloudwatch/config.json`.
- **No secret rotation.** Secrets are generated once at bootstrap and live in `/etc/worood-hub/api.env`. AWS Systems Manager Parameter Store with SecureString parameters is the next step if rotation becomes a requirement.
