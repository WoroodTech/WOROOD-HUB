# Rollout — Shopify sync reliability (Phases 1–8)

Seven migrations, a new worker process, and changes to reconciliation, order
writes, webhook processing, the backfill, scheduling and health reporting.

**Nothing here has been run against production.** Every command below is a
proposal awaiting approval.

The rollout is in four stages, and each is reversible on its own. The worker —
the largest behavioural change — is off by default and stays off until stage 3,
so stages 1 and 2 can be deployed and watched without changing how webhooks are
processed at all.

---

## Before anything

```bash
# 1. The two numbers that decide whether the index builds block ingest.
psql "$DATABASE_URL" -c "SELECT count(*) AS events FROM sd_webhook_events;"
psql "$DATABASE_URL" -c "SELECT pg_size_pretty(pg_total_relation_size('sd_webhook_events'));"

# 2. Statuses present, so the NOT VALID constraints can be promoted later.
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM sd_webhook_events GROUP BY status ORDER BY 2 DESC;"

# 3. Duplicate escalations that 0026 will delete. Expect few or none.
psql "$DATABASE_URL" -c "
  SELECT count(*) AS tickets_with_duplicates FROM (
    SELECT item_id FROM tk_events WHERE type='ESCALATED'
     GROUP BY item_id HAVING count(*) > 1) x;"

# 4. A backup taken immediately before, not this morning's.
sudo /usr/local/bin/worood-hub-backup
```

If step 1 returns more than roughly 200,000 rows, migrations 0023 and 0027 will
decline to build their indexes inline and say so in the log. That is expected;
see stage 1c.

---

## Stage 1 — schema and code, worker still off

The API keeps processing webhooks inline exactly as it does today.
`WEBHOOK_WORKER_ENABLED` is unset, and with it unset nothing about webhook
handling changes.

### 1a. Deploy

```bash
cd /opt/worood-hub            # or wherever the checkout lives
git pull
./deploy/release.sh
```

Migrations run in the API unit's `ExecStartPre`, not in `release.sh`.

### 1b. Watch the migration

```bash
journalctl -u worood-hub-api -n 200 --no-pager | grep -E "applying|migration|NOTICE"
```

Expect seven: `0021` … `0027`. Any `NOTICE` about skipping an inline index
build is the size guard, not an error.

### 1c. If the size guard fired

```bash
psql "$DATABASE_URL" -f deploy/postgres/0023-indexes-concurrently.sql

# 0027's index, which has no script of its own:
psql "$DATABASE_URL" -c "
  CREATE INDEX CONCURRENTLY IF NOT EXISTS sd_webhook_events_received_idx
    ON sd_webhook_events (received_at DESC);"
```

Both are safe to re-run. If either is interrupted it leaves an INVALID index;
the script refuses to continue in that case and names it.

### 1d. Validate

```bash
# Every expected object exists.
psql "$DATABASE_URL" -c "\d sd_webhook_events" | grep -E "next_attempt_at|lease_|last_attempt_at"
psql "$DATABASE_URL" -c "\di sd_webhook_events*"
psql "$DATABASE_URL" -c "SELECT count(*) FROM core_job_locks;"

# Health now reports measured figures instead of zeros.
curl -s -H "Authorization: Bearer $TOKEN" \
  https://hub.worood.co/api/v1/sales/admin/sync | python3 -m json.tool | head -40
```

`queue.processing`, `queue.dead` and `queue.completed24h` should be real
numbers. `queue.waiting` and `queue.oldestDueSeconds` describe the backlog;
with the worker off and inline processing running, waiting should be near zero.

### 1e. Promote the deferred constraints

Only after step 2 of the pre-flight showed no unexpected status values:

```bash
psql "$DATABASE_URL" -c "ALTER TABLE sd_webhook_events VALIDATE CONSTRAINT sd_webhook_events_status_check;"
psql "$DATABASE_URL" -c "ALTER TABLE sd_webhook_events VALIDATE CONSTRAINT sd_webhook_events_lease_check;"
```

`VALIDATE` takes `SHARE UPDATE EXCLUSIVE` and does not block reads or writes.

### What to watch for a day

- `orders` and `orders_backfill` in the health response stay `healthy: true`
- `queue.dead` does not climb
- `journalctl -u worood-hub-api | grep -i "reconcile:"` — look for
  "stopped at the 40-page ceiling", which means a backlog is draining by cursor
- order counts in the dashboard match Shopify for the same window

### Rollback

```bash
./deploy/rollback.sh
```

The migrations stay. That is deliberate and safe: every one is additive —
new columns, new tables, new indexes — and the previous release ignores all of
them. The one exception is `0026`, which deleted duplicate `ESCALATED` events;
those were the output of the bug being fixed and are not restored by a
rollback.

---

## Stage 2 — let it settle

Give stage 1 at least a full business day, and one overnight so the 02:00 and
03:00 Cairo jobs run under the new distributed locks.

```bash
# The locks should show one row per job, with recent successes.
psql "$DATABASE_URL" -c "
  SELECT name, owner, last_run_at, last_ok_at, last_error FROM core_job_locks ORDER BY name;"
```

`sales:nightly-capture`, `sales:store-credit` and `sales:watchdog` should each
have a `last_ok_at` from last night and no `last_error`.

---

## Stage 3 — turn the worker on

This is the change worth being careful about. Inline processing stops and the
worker takes over; the two never run together, because the API skips the inline
path when the flag is set and the worker refuses to start when it is not.

### 3a. Configure

```bash
sudo tee -a /etc/worood-hub/api.env >/dev/null <<'EOF'
WEBHOOK_WORKER_ENABLED=true
WEBHOOK_WORKER_ID=hub-prod-1
EOF
```

`WEBHOOK_WORKER_ID` should be stable per host. The default includes the PID,
which changes on restart — and a restarted worker only recovers its own
orphaned events instantly if it recognises its former identity. Without it,
recovery waits for the lease sweep instead.

### 3b. Start both

```bash
sudo systemctl restart worood-hub-api        # picks up the flag, stops inline processing
sudo systemctl enable --now worood-hub-worker
sudo systemctl status worood-hub-worker --no-pager
journalctl -u worood-hub-worker -f
```

Expect `webhook worker hub-prod-1 started (lease 120s, poll 1000ms)`.

### 3c. Validate within the first few minutes

```bash
# Events should be moving, not accumulating.
watch -n 10 'psql "$DATABASE_URL" -tAc "
  SELECT status, count(*) FROM sd_webhook_events
   WHERE received_at > now() - interval '"'"'10 minutes'"'"'
   GROUP BY status ORDER BY 1;"'
```

Healthy: `PROCESSED` climbing, `PENDING` near zero, `PROCESSING` small and
changing, `DEAD` not moving.

Then place one real order (or re-trigger a webhook from the Shopify admin) and
confirm it appears in the dashboard within a minute.

### Rollback — fast, and no data is lost

```bash
sudo systemctl disable --now worood-hub-worker
sudo sed -i '/WEBHOOK_WORKER_ENABLED/d' /etc/worood-hub/api.env
sudo systemctl restart worood-hub-api
```

The API resumes inline processing immediately. Events left `PROCESSING` by the
stopped worker keep their lease; nothing sweeps them while the worker is down,
so clear them by hand:

```bash
psql "$DATABASE_URL" -c "
  UPDATE sd_webhook_events
     SET status='PENDING', lease_owner=NULL, lease_expires_at=NULL, next_attempt_at=now()
   WHERE status='PROCESSING';"
```

They are then picked up by the inline path on the next delivery, or by
reconciliation within fifteen minutes.

---

## Stage 4 — the backfill, only if needed

Do **not** run this unless the order history is genuinely incomplete. Check
first:

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM sd_orders;"
# compare against Shopify's own order count for the same shop
psql "$DATABASE_URL" -c "
  SELECT resource, status, last_ok_at, records FROM sd_sync_state
   WHERE resource='orders_backfill';"
```

If `last_ok_at` is set and `records` looks right, the history is already in and
nothing needs doing.

If it does need running:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://hub.worood.co/api/v1/sales/admin/sync/backfill

# Follow it. Progress is written after every batch.
watch -n 30 'psql "$DATABASE_URL" -tAc "
  SELECT status, records, progress->>'"'"'linesProcessed'"'"' AS lines
    FROM sd_sync_state WHERE resource='"'"'orders_backfill'"'"';"'
```

A second caller is refused with a 409 while one is running. If it is
interrupted, running it again resumes from the recorded position rather than
starting over.

---

## Ongoing monitoring

Worth a daily glance, and worth an alert if you have somewhere to put one:

| signal | query | healthy |
|---|---|---|
| events given up | `SELECT count(*) FROM sd_webhook_events WHERE status='DEAD'` | not climbing |
| backlog age | `queue.oldestDueSeconds` in the health response | under ~900s |
| stalled leases | `queue.expiredLeases` | 0 |
| reconciliation lag | `resources[orders].lagSeconds` | under 3600 |
| scheduled jobs | `SELECT name, last_ok_at, last_error FROM core_job_locks` | ran last night, no error |

Dead events can be inspected and replayed from the admin API:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://hub.worood.co/api/v1/sales/admin/sync/failed-events?limit=20"

curl -X POST -H "Authorization: Bearer $TOKEN" \
  "https://hub.worood.co/api/v1/sales/admin/sync/failed-events/<id>/replay"
```

Replay puts the event back in the queue for the ordinary worker. It is audited
under `sales.webhook.replay`.