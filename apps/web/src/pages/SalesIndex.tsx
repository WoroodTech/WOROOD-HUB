import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DashboardSummary } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Badge } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { useAuth } from '../lib/auth';
import { PERMISSIONS } from '../contract';

/** Why this employee can see this dashboard. Surfacing it turns "why do I have
 *  this?" into something the screen answers by itself. */
const GRANT_COPY: Record<DashboardSummary['grantedBy'], { label: string; tone: 'info' | 'accent' | 'neutral'; icon: string; title: string }> = {
  ROLE: { label: 'via your role', tone: 'info', icon: 'users', title: 'Granted to one of your roles, so everyone with that role sees it.' },
  USER: { label: 'granted to you', tone: 'accent', icon: 'check', title: 'Granted to you individually, on top of your roles.' },
  ADMIN: { label: 'administrator', tone: 'neutral', icon: 'lock', title: 'You can manage dashboards, so every dashboard is visible to you.' },
};

export function SalesIndex() {
  const { can } = useAuth();
  const { data, isPending, error, refetch } = useQuery({
    queryKey: qk.dashboards,
    queryFn: () => api<DashboardSummary[]>('/sales/dashboards'),
  });

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Sales</h1>
          <p className="pagehead__sub">Dashboards you have been granted. Each one is a layout of widgets, not a separate application.</p>
        </div>
        {can(PERMISSIONS.DASHBOARD_MANAGE) ? (
          <Link className="btn btn--primary" to="/sales/admin">
            <Icon name="layout-grid" size={16} /> Compose dashboards
          </Link>
        ) : null}
      </header>

      {isPending ? <LoadingState label="Loading dashboards" lines={3} /> : null}
      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      {data && !data.length ? (
        <EmptyState
          icon="layout-grid" title="No dashboards granted to you yet"
          hint="Dashboards are granted by role or individually. An administrator can add you from the composer."
        />
      ) : null}

      <ul className="cardgrid">
        {data?.map((d) => {
          const grant = GRANT_COPY[d.grantedBy];
          return (
            <li key={d.id}>
              <Link className="dashcard" to={`/sales/d/${d.key}`}>
                <div className="dashcard__head">
                  <h2 className="dashcard__title">{d.name}</h2>
                  {d.isSystem ? <Badge tone="neutral" title="Shipped with the module.">system</Badge> : null}
                </div>
                {d.description ? <p className="dashcard__desc">{d.description}</p> : null}
                <div className="dashcard__foot">
                  <Badge tone={grant.tone} icon={grant.icon} title={grant.title}>{grant.label}</Badge>
                  <span className="dashcard__count">{d.widgetCount} widgets</span>
                  <span className="dashcard__go"><Icon name="right" size={16} /></span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
