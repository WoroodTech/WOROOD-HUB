import { useQuery } from '@tanstack/react-query';
import type { SyncHealthResponse, SyncStateRow } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { ErrorState, LoadingState } from '../components/States';
import { Badge } from '../components/Card';
import { Icon } from '../components/Icon';
import { formatDateTime, formatDuration, formatInteger } from '../lib/format';

const RESOURCE_LABEL: Record<string, string> = {
  customers: 'Customers',
  orders: 'Orders',
  sales_snapshot: 'Sales snapshots',
  sessions_snapshot: 'Session snapshots',
  webhooks: 'Webhook subscriptions',
};

function StatusBadge({ row }: { row: SyncStateRow }) {
  if (row.status === 'ERROR' || !row.healthy) {
    return <Badge tone="critical" icon="warning" title={row.error ?? undefined}>{row.status === 'ERROR' ? 'error' : 'lagging'}</Badge>;
  }
  if (row.status === 'RUNNING') return <Badge tone="info" icon="refresh">running</Badge>;
  if (row.status === 'IDLE') return <Badge tone="neutral" icon="clock">idle</Badge>;
  return <Badge tone="good" icon="check">healthy</Badge>;
}

export function Sync() {
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: qk.sync,
    queryFn: () => api<SyncHealthResponse>('/sales/admin/sync'),
    refetchInterval: 60_000,
  });

  if (isPending) return <div className="page"><LoadingState label="Loading sync health" lines={5} /></div>;
  if (error || !data) {
    return <div className="page"><ErrorState error={error ?? new Error('Sync health unavailable')} onRetry={() => void refetch()} /></div>;
  }

  const { shop, resources, queue, webhooks, costGovernor, token } = data;
  const unhealthy = resources.filter((r) => !r.healthy || r.status === 'ERROR');

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Data &amp; Sync</h1>
          <p className="pagehead__sub">
            {shop.name} · <span className="mono">{shop.domain}</span> · {shop.plan ?? 'plan unknown'} ·
            Admin API <span className="mono">{shop.apiVersion}</span>
          </p>
        </div>
        <button type="button" className="btn btn--ghost" onClick={() => void refetch()}>
          <Icon name="refresh" size={16} /> {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {unhealthy.length ? (
        <p className="banner banner--stale" role="status">
          <Icon name="warning" size={18} />
          <span>
            <strong>{unhealthy.length} resource{unhealthy.length === 1 ? '' : 's'} behind:</strong>{' '}
            {unhealthy.map((r) => RESOURCE_LABEL[r.resource] ?? r.resource).join(', ')}. Dashboards will keep
            serving their last good figures with the age shown on each one.
          </span>
        </p>
      ) : (
        <p className="banner banner--ok" role="status">
          <Icon name="check" size={17} />
          <span>Every mirrored resource is inside its freshness budget.</span>
        </p>
      )}

      <section className="panel">
        <header className="panel__head">
          <h2 className="panel__title">Mirrored resources</h2>
          <p className="panel__hint">
            The watermark is how far the mirror has read; lag is how far behind the shop it therefore is.
          </p>
        </header>
        <div className="tablescroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Resource</th>
                <th scope="col">State</th>
                <th scope="col">Watermark</th>
                <th scope="col" className="is-end">Lag</th>
                <th scope="col" className="is-end">Records</th>
                <th scope="col">Last run</th>
                <th scope="col">Last success</th>
              </tr>
            </thead>
            <tbody>
              {resources.map((r) => (
                <tr key={r.resource}>
                  <td><strong>{RESOURCE_LABEL[r.resource] ?? r.resource}</strong></td>
                  <td><StatusBadge row={r} /></td>
                  <td>{r.watermark ? formatDateTime(r.watermark) : <span className="muted">never read</span>}</td>
                  <td className="is-end">{r.lagSeconds === null ? '--' : formatDuration(r.lagSeconds / 60)}</td>
                  <td className="is-end">{formatInteger(r.records)}</td>
                  <td>{r.lastRunAt ? formatDateTime(r.lastRunAt) : <span className="muted">never</span>}</td>
                  <td>
                    {r.lastOkAt ? formatDateTime(r.lastOkAt) : <span className="muted">never</span>}
                    {r.error ? <span className="cell-sub cell-sub--error">{r.error}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid">
        <div className="grid__cell" style={{ ['--span' as string]: '4' }}>
          <section className="panel panel--tight">
            <header className="panel__head">
              <h2 className="panel__title">Queue</h2>
              <p className="panel__hint">Background jobs pulling and folding shop data.</p>
            </header>
            <ul className="statlist">
              <li><span>Waiting</span><strong>{formatInteger(queue.waiting)}</strong></li>
              <li><span>Active</span><strong>{formatInteger(queue.active)}</strong></li>
              <li className={queue.failed ? 'is-bad' : undefined}><span>Failed</span><strong>{formatInteger(queue.failed)}</strong></li>
              <li><span>Completed</span><strong>{formatInteger(queue.completed)}</strong></li>
            </ul>
          </section>
        </div>

        <div className="grid__cell" style={{ ['--span' as string]: '4' }}>
          <section className="panel panel--tight">
            <header className="panel__head">
              <h2 className="panel__title">Cost governor</h2>
              <p className="panel__hint">Shopify's leaky bucket, as seen from this side.</p>
            </header>
            <ul className="statlist">
              <li>
                <span>Restore rate</span>
                <strong>{formatInteger(costGovernor.restoreRate)}/s</strong>
              </li>
              <li>
                <span>Available now</span>
                <strong>{costGovernor.available === null ? 'not yet observed' : formatInteger(costGovernor.available)}</strong>
              </li>
              <li>
                <span>Bucket capacity</span>
                <strong>{costGovernor.maximum === null ? 'unpublished' : formatInteger(costGovernor.maximum)}</strong>
              </li>
              <li className={costGovernor.throttledCalls24h ? 'is-bad' : undefined}>
                <span>Throttled, 24 h</span><strong>{formatInteger(costGovernor.throttledCalls24h)}</strong>
              </li>
            </ul>
            <p className="panel__note">
              {costGovernor.maximum === null ? (
                <>Bucket capacity is <strong>not published</strong> by the API: it is only learned from a live
                  response header, and this shop has not returned one yet. That is why the figure reads
                  “unpublished” rather than sitting blank — nothing is broken.</>
              ) : (
                <>Capacity was learned from a live response header rather than configured here.</>
              )}
              {' '}The {formatInteger(costGovernor.restoreRate)}/s restore rate is the Advanced-plan figure.
            </p>
          </section>
        </div>

        <div className="grid__cell" style={{ ['--span' as string]: '4' }}>
          <section className="panel panel--tight">
            <header className="panel__head">
              <h2 className="panel__title">Access token</h2>
              <p className="panel__hint">Which credential the mirror is running on.</p>
            </header>
            <ul className="statlist">
              <li><span>Source</span><strong>{token.source}</strong></li>
              <li><span>Expires</span><strong>{token.expiresAt ? formatDateTime(token.expiresAt) : 'no expiry reported'}</strong></li>
              <li><span>Last refreshed</span><strong>{token.refreshedAt ? formatDateTime(token.refreshedAt) : 'never'}</strong></li>
            </ul>
          </section>
        </div>

        <div className="grid__cell" style={{ ['--span' as string]: '12' }}>
          <section className="panel panel--tight">
            <header className="panel__head">
              <h2 className="panel__title">Webhooks</h2>
              <p className="panel__hint">
                Last verified {webhooks.lastCheckedAt ? formatDateTime(webhooks.lastCheckedAt) : 'never — the subscription list below is what the module expects to hold'}.
              </p>
            </header>

            <ul className="statlist statlist--row">
              <li><span>Received, 24 h</span><strong>{formatInteger(webhooks.received24h)}</strong></li>
              <li><span>Duplicates, 24 h</span><strong>{formatInteger(webhooks.duplicates24h)}</strong></li>
              <li className={webhooks.stale24h ? 'is-bad' : undefined}>
                <span>Stale, 24 h</span><strong>{formatInteger(webhooks.stale24h)}</strong>
              </li>
            </ul>

            <div className="topics">
              <div>
                <p className="topics__label">Subscribed <Badge tone="good">{webhooks.subscribed.length}</Badge></p>
                <ul className="chiplist">
                  {webhooks.subscribed.map((t) => <li key={t} className="chip mono">{t}</li>)}
                </ul>
              </div>
              <div>
                <p className="topics__label">
                  Missing {webhooks.missing.length
                    ? <Badge tone="critical">{webhooks.missing.length}</Badge>
                    : <Badge tone="good" icon="check">none</Badge>}
                </p>
                {webhooks.missing.length ? (
                  <ul className="chiplist">
                    {webhooks.missing.map((t) => <li key={t} className="chip chip--bad mono">{t}</li>)}
                  </ul>
                ) : <p className="muted">Every topic the module needs is subscribed.</p>}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
