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

/** Yesterday and the day before, in the shop's own clock -- the two dates the
 *  comparison opens on, because comparing today with anything is comparing a
 *  part-day with a whole one. */
const cairoDay = (offset = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
};

export function SalesDashboard() {
  const { key = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const range = params.get('range') ?? '30d';
  /* Held in the URL beside the range, so a comparison can be shared or
     bookmarked the way a range already can. */
  const primary = params.get('primary') ?? cairoDay(-1);
  const against = params.get('against') ?? cairoDay(-2);
  const comparing = range === 'compare';
  const { status: rtStatus } = useRealtime();

  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: qk.dashboardData(key, comparing ? `compare:${primary}:${against}` : range),
    queryFn: () => api<DashboardDataResponse>(
      `/sales/dashboards/${key}/data?range=${encodeURIComponent(range)}`
      + (comparing ? `&primary=${primary}&against=${against}` : '')),
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
  /* `connection` is sent on every response, so its absence means an older API
     rather than a healthy one -- treated as healthy, because a banner that
     appears after a partial deploy is worse than one that briefly does not. */
  const offline = data?.connection ? !data.connection.live && !!data.connection.degradedSince : false;
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
          <button
            type="button"
            className={`ranges__btn${comparing ? ' is-active' : ''}`}
            aria-pressed={comparing}
            onClick={() => setParams(
              comparing ? { range: '30d' } : { range: 'compare', primary, against },
              { replace: true })}
          >
            Compare days
          </button>
        </div>
      </header>

      {/* The two dates. Shown only in comparison mode, directly under the range
          buttons rather than in a dialog: the whole interaction is picking two
          days and seeing what changed, and a dialog would put a lid on it. */}
      {comparing ? (
        <div className="comparedays">
          <label className="comparedays__field">
            <span className="comparedays__label">Day</span>
            <input
              className="input mono" type="date" value={primary} max={cairoDay()}
              onChange={(e) => setParams(
                { range: 'compare', primary: e.target.value, against }, { replace: true })}
            />
          </label>
          <span className="comparedays__vs">compared with</span>
          <label className="comparedays__field">
            <span className="comparedays__label">Day</span>
            <input
              className="input mono" type="date" value={against} max={cairoDay()}
              onChange={(e) => setParams(
                { range: 'compare', primary, against: e.target.value }, { replace: true })}
            />
          </label>
          {primary === against ? (
            <span className="comparedays__warn">
              Both dates are the same day — pick two to compare.
            </span>
          ) : null}
        </div>
      ) : null}

      {/* The connection banner comes before the staleness one and replaces it.
          Both would otherwise appear together saying the same thing twice --
          figures are old *because* Shopify is unreachable -- and the second
          would send the reader to a Refetch button that cannot help. */}
      {offline ? (
        <p className="banner banner--offline" role="status">
          <Icon name="warning" size={18} />
          <span>
            <strong>
              Shopify has been unreachable since {formatDateTime(data!.connection!.degradedSince!)}.
            </strong>{' '}
            These are the last figures received, not the current ones. They will
            catch up on their own once the connection returns — nothing needs to
            be re-run.
            {data!.connection!.lastError ? (
              <span className="banner__detail">{data!.connection!.lastError}</span>
            ) : null}
          </span>
        </p>
      ) : null}

      {stale && !offline ? (
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