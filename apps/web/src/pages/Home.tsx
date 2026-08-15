import { useHubModules } from '../lib/hub';
import { useAuth } from '../lib/auth';
import { PORTLET_REGISTRY, UnknownPortlet } from '../portlets/registry';
import { LoadingState, ErrorState } from '../components/States';
import { formatDate } from '../lib/format';

function greeting(): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false,
  }).format(new Date()));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function Home() {
  const { principal } = useAuth();
  const { data, isPending, error, refetch } = useHubModules();
  const portlets = [...(data?.dashboard ?? [])].sort((a, b) => a.order - b.order);
  const firstName = principal?.fullName?.split(' ')[0] ?? '';

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">{greeting()}, {firstName}</h1>
          <p className="pagehead__sub">
            {principal?.jobTitle ? `${principal.jobTitle} · ` : ''}
            {principal?.department ? `${principal.department} · ` : ''}
            {formatDate(new Date().toISOString())} in Cairo
          </p>
        </div>
      </header>

      {isPending ? <LoadingState label="Loading your home screen" lines={4} /> : null}
      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      {data && !portlets.length ? (
        <p className="notice">
          Nothing has been placed on your home screen yet. Modules add portlets here as they are granted to you.
        </p>
      ) : null}

      <div className="grid">
        {portlets.map((portlet) => {
          const Component = PORTLET_REGISTRY[portlet.key] ?? UnknownPortlet;
          return (
            <div className="grid__cell" key={portlet.key} style={{ ['--span' as string]: String(portlet.width) }}>
              <Component
                moduleKey={portlet.moduleKey}
                portletKey={portlet.key}
                title={portlet.title}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
