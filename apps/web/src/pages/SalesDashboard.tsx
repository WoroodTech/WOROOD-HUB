import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DashboardDataResponse } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { WidgetCard } from '../widgets/WidgetCard';
import { ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { DataAge } from '../components/Card';
import { formatAge, formatDateTime } from '../lib/format';
import { useDashboardSubscription, useRealtime } from '../lib/realtime';

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: '13m', label: '13 months' },
];

export function SalesDashboard() {
  const { key = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const range = params.get('range') ?? '30d';
  const { status: rtStatus } = useRealtime();

  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: qk.dashboardData(key, range),
    queryFn: () => api<DashboardDataResponse>(`/sales/dashboards/${key}/data?range=${encodeURIComponent(range)}`),
    placeholderData: (prev) => prev,
  });

  useDashboardSubscription(data?.dashboard.id);

  /** How old the *oldest* figure on screen is -- the honest number to quote. */
  const age = useMemo(() => {
    const ages = (data?.widgets ?? [])
      .map((w) => w.dataAgeSeconds)
      .filter((v): v is number => v !== null && v !== undefined);
    return ages.length ? Math.max(...ages) : null;
  }, [data]);

  const staleAfter = (data?.staleAfterMinutes ?? 0) * 60;
  const stale = age !== null && staleAfter > 0 && age > staleAfter;
  const generatedAt = data?.widgets.find((w) => w.generatedAt)?.generatedAt ?? null;

  if (isPending) {
    return <div className="page"><LoadingState label="Loading dashboard" lines={5} /></div>;
  }
  if (error || !data) {
    return (
      <div className="page">
        <p className="crumb"><Link to="/sales"><Icon name="left" size={14} /> All dashboards</Link></p>
        <ErrorState error={error ?? new Error('Dashboard unavailable')} onRetry={() => void refetch()} />
      </div>
    );
  }

  const { dashboard, widgets, shop } = data;

  return (
    <div className="page">
      <p className="crumb"><Link to="/sales"><Icon name="left" size={14} /> All dashboards</Link></p>

      <header className="pagehead pagehead--stack">
        <div>
          <h1 className="pagehead__title">{dashboard.name}</h1>
          <p className="pagehead__sub">
            {dashboard.description ?? `${shop.name} · ${shop.currency}`}
          </p>
          <p className="pagehead__meta">
            <DataAge seconds={age} generatedAt={generatedAt} stale={stale} />
            <span className="dot" aria-hidden="true">·</span>
            <span title={generatedAt ? formatDateTime(generatedAt) : undefined}>
              {generatedAt ? `generated ${formatDateTime(generatedAt)} Cairo` : 'generation time not reported'}
            </span>
            {isFetching ? <span className="pagehead__fetching">refreshing…</span> : null}
          </p>
        </div>

        <div className="ranges" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`ranges__btn${r.key === range ? ' is-active' : ''}`}
              aria-pressed={r.key === range}
              onClick={() => setParams({ range: r.key }, { replace: true })}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {stale ? (
        <p className="banner banner--stale" role="status">
          <Icon name="warning" size={18} />
          <span>
            <strong>The oldest figure on this page was read {formatAge(age)}.</strong> The sync has not delivered anything newer than
            the {data.staleAfterMinutes}-minute freshness budget for this dashboard, so treat what follows as a
            last-known picture rather than the current one.
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refetch()}>
            <Icon name="refresh" size={15} /> Refetch
          </button>
        </p>
      ) : null}

      {rtStatus === 'reconnecting' ? (
        <p className="banner banner--quiet" role="status">
          <Icon name="info" size={17} />
          <span>
            The live channel is down, so nothing on this page is updating by itself right now. The timestamps
            above still say exactly how old each figure is; use Refetch to pull fresh ones.
          </span>
        </p>
      ) : null}

      <div className="grid">
        {widgets.map((envelope, i) => {
          const placement = dashboard.widgets.find((w) => w.widgetKey === envelope.widgetKey);
          return (
            <WidgetCard
              key={`${envelope.widgetKey}-${i}`}
              envelope={envelope}
              width={placement?.width ?? 4}
              slot={i}
              currency={shop.currency}
              stale={stale}
            />
          );
        })}
      </div>
    </div>
  );
}
