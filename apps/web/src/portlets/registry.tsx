/**
 * Home-screen portlets. Everything here is personal: it is about the signed-in
 * employee, not about the company.
 *
 * The grid is rendered from `HubModulesResponse.dashboard`, and this registry
 * maps a portlet key to a component. A key with no entry renders a neutral
 * placeholder -- the grid never breaks. A portlet the employee is not allowed to
 * see never appears in `dashboard` at all, so there is nothing to hide here:
 * the permission gate happens server-side, and the absence *is* the gate.
 */

import type { ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  FreeNowPortlet, MyAlertsPortlet, MyDashboardsPortlet, MyInvitationsPortlet,
  NextMeetingPortlet, StorePulsePortlet, UpcomingReservationsPortlet,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { useHubModules } from '../lib/hub';
import { Badge, Card, DataAge, ProvisionalTag } from '../components/Card';
import { EmptyState, ErrorState, LoadingState, PlaceholderState } from '../components/States';
import { Icon } from '../components/Icon';
import { Delta } from '../components/Delta';
import {
  formatDate, formatDuration, formatInteger, formatMoney, formatMoneyShort,
  formatPercent, formatTime, formatWeekday,
} from '../lib/format';

/* ------------------------------------------------------------- plumbing -- */

const PORTLET_ROUTES: Record<string, (key: string) => string> = {
  'meeting-rooms': (key) => `/meeting-rooms/portlets/${key}`,
  'sales-dashboard': (key) => `/sales/portlets/${key}`,
};

export const portletPath = (moduleKey: string, key: string): string | null =>
  PORTLET_ROUTES[moduleKey] ? PORTLET_ROUTES[moduleKey](key) : null;

function usePortlet<T>(moduleKey: string, key: string) {
  const path = portletPath(moduleKey, key);
  return useQuery({
    queryKey: qk.portlet(moduleKey, key),
    queryFn: () => api<T>(path as string),
    enabled: !!path,
    staleTime: 60 * 1000,
  });
}

export interface PortletProps { moduleKey: string; portletKey: string; title: string }

/* ------------------------------------------------------ meeting rooms -- */

function NextMeeting({ moduleKey, portletKey, title }: PortletProps) {
  const { data, isPending, error, refetch } = usePortlet<NextMeetingPortlet>(moduleKey, portletKey);
  const meeting = data?.meeting;
  return (
    <Card
      title={title}
      subtitle={meeting && !meeting.isOrganiser
        ? `Booked by ${meeting.organiserName}`
        : 'Your next booking'}
    >
      {isPending ? <LoadingState lines={3} />
        : error ? <ErrorState error={error} onRetry={() => void refetch()} compact />
          : !meeting ? (
            <EmptyState
              icon="calendar" title="Nothing booked"
              hint={<>Your calendar is clear. <Link to="/meeting-rooms/book">Book a room</Link> when you need one.</>}
            />
          ) : (
            <div className="meeting">
              <p className="meeting__when">
                <span className="meeting__day">{formatWeekday(meeting.startsAt)}</span>
                <span className="meeting__time">{formatTime(meeting.startsAt)} – {formatTime(meeting.endsAt)}</span>
              </p>
              <p className="meeting__title">{meeting.title}</p>
              {!meeting.isOrganiser && meeting.myResponse === 'INVITED' ? (
                <p className="meeting__pending">
                  <Icon name="clock" size={13} /> You have not replied yet
                </p>
              ) : null}
              <dl className="factlist">
                <div><dt>Room</dt><dd>{meeting.room}{meeting.floor ? `, floor ${meeting.floor}` : ''}</dd></div>
                <div><dt>Attendees</dt><dd>{formatInteger(meeting.attendees)}</dd></div>
                <div><dt>Reference</dt><dd className="mono">{meeting.reference}</dd></div>
              </dl>
            </div>
          )}
    </Card>
  );
}

function FreeNow({ moduleKey, portletKey, title }: PortletProps) {
  const { data, isPending, error, refetch } = usePortlet<FreeNowPortlet>(moduleKey, portletKey);
  const rooms = data?.rooms ?? [];
  return (
    <Card title={title} subtitle="Rooms you could walk into">
      {isPending ? <LoadingState lines={4} />
        : error ? <ErrorState error={error} onRetry={() => void refetch()} compact />
          : !rooms.length ? <EmptyState icon="door" title="Every room is busy" hint="Try again in a few minutes." />
            : (
              <ul className="roomlist">
                {rooms.map((room) => (
                  <li key={room.name} className="roomlist__row">
                    <span className="roomlist__name">
                      {room.name}
                      <span className="roomlist__meta">
                        {room.floor ? `Floor ${room.floor}` : 'Floor --'} · {room.capacity} seats
                      </span>
                    </span>
                    <span className="roomlist__free">
                      {room.freeForMinutes === null
                        ? <Badge tone="good" icon="check">free all day</Badge>
                        : <Badge tone="neutral" icon="clock">{formatDuration(room.freeForMinutes)}</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
    </Card>
  );
}

function UpcomingReservations({ moduleKey, portletKey, title }: PortletProps) {
  const { data, isPending, error, refetch } = usePortlet<UpcomingReservationsPortlet>(moduleKey, portletKey);
  const items = data?.reservations ?? [];
  return (
    <Card title={title} subtitle="Yours and the ones you were invited to">
      {isPending ? <LoadingState lines={3} />
        : error ? <ErrorState error={error} onRetry={() => void refetch()} compact />
          : !items.length ? <EmptyState icon="calendar" title="No upcoming reservations" hint="Anything you book will show up here." />
            : (
              <ul className="reslist">
                {items.map((r) => (
                  <li key={r.reference} className="reslist__row">
                    <span className="reslist__date">
                      <strong>{formatWeekday(r.startsAt)}</strong>
                      <span>{formatTime(r.startsAt)} – {formatTime(r.endsAt)}</span>
                    </span>
                    <span className="reslist__body">
                      <strong>{r.title}</strong>
                      <span>
                        {r.room} · <span className="mono">{r.reference}</span>
                        {!r.isOrganiser ? <> · <em>by {r.organiserName}</em></> : null}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
    </Card>
  );
}

/**
 * Invitations waiting on the person looking at the screen.
 *
 * This is the only portlet that asks something of the viewer, so it is the only
 * one with buttons that change state, and it disappears once they have answered
 * everything -- a card that says "nothing to do" every morning trains people to
 * stop reading it.
 *
 * Declining does not remove them from the meeting. The organiser needs to see
 * that they were asked and said no, which is not the same as never being asked.
 */
function MyInvitations({ moduleKey, portletKey, title }: PortletProps) {
  const { data, isPending, error, refetch } = usePortlet<MyInvitationsPortlet>(moduleKey, portletKey);
  const queryClient = useQueryClient();
  const invitations = data?.invitations ?? [];

  const respond = useMutation({
    mutationFn: ({ id, response }: { id: string; response: 'ACCEPTED' | 'DECLINED' }) =>
      api(`/meeting-rooms/reservations/${id}/response`, { method: 'POST', body: { response } }),
    onSuccess: () => {
      // Answering changes what the other meeting-room portlets should show too.
      void queryClient.invalidateQueries({ queryKey: ['portlet'] });
      void queryClient.invalidateQueries({ queryKey: ['mr'] });
    },
  });

  return (
    <Card
      title={title}
      subtitle="Meetings someone has asked you to"
      actions={invitations.length ? <Badge tone="warning" icon="bell">{invitations.length}</Badge> : undefined}
    >
      {isPending ? <LoadingState lines={3} />
        : error ? <ErrorState error={error} onRetry={() => void refetch()} compact />
          : !invitations.length ? (
            <EmptyState icon="check" title="Nothing waiting on you"
                        hint="Invitations appear here until you accept or decline." />
          ) : (
            <ul className="invitelist">
              {invitations.map((i) => (
                <li key={i.id} className="invite">
                  <span className="invite__when">
                    <strong>{formatWeekday(i.startsAt)}</strong>
                    <span>{formatTime(i.startsAt)} – {formatTime(i.endsAt)}</span>
                  </span>
                  <span className="invite__body">
                    <strong>{i.title}</strong>
                    <span>{i.room}{i.floor ? `, floor ${i.floor}` : ''} · {i.organiserName}</span>
                  </span>
                  <span className="invite__actions">
                    <button
                      type="button" className="btn btn--primary btn--sm"
                      disabled={respond.isPending}
                      onClick={() => respond.mutate({ id: i.id, response: 'ACCEPTED' })}
                    >
                      <Icon name="check" size={14} /> <span className="btn__label">Accept</span>
                    </button>
                    <button
                      type="button" className="btn btn--ghost btn--sm"
                      disabled={respond.isPending}
                      onClick={() => respond.mutate({ id: i.id, response: 'DECLINED' })}
                    >
                      <span className="btn__label">Decline</span>
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
    </Card>
  );
}

/* ------------------------------------------------------------- sales -- */

function MyDashboards({ moduleKey, portletKey, title }: PortletProps) {
  const { data, isPending, error, refetch } = usePortlet<MyDashboardsPortlet>(moduleKey, portletKey);
  const items = data?.dashboards ?? [];
  const age = items.find((d) => d.dataAgeSeconds !== null)?.dataAgeSeconds ?? null;
  return (
    <Card
      title={title}
      subtitle="Dashboards granted to you"
      actions={items.length ? <DataAge seconds={age} /> : undefined}
      footer={items.length ? <Link className="link" to="/sales">Open Sales <Icon name="right" size={14} /></Link> : undefined}
    >
      {isPending ? <LoadingState lines={3} />
        : error ? <ErrorState error={error} onRetry={() => void refetch()} compact />
          : !items.length ? <EmptyState icon="layout-grid" title="No dashboards yet" hint="An administrator can grant you one from the composer." />
            : (
              <ul className="dashlist">
                {items.map((d) => (
                  <li key={d.key}>
                    <Link className="dashlist__row" to={`/sales/d/${d.key}`}>
                      <span className="dashlist__name">
                        {d.name}
                        {d.description ? <span className="dashlist__desc">{d.description}</span> : null}
                      </span>
                      {d.headline ? (
                        <span className="dashlist__headline">
                          <span className="dashlist__figure">EGP {d.headline.value}</span>
                          <span className="dashlist__caption">{d.headline.label}</span>
                        </span>
                      ) : null}
                      <Icon name="right" size={16} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
    </Card>
  );
}

function StorePulse({ moduleKey, portletKey, title }: PortletProps) {
  const { data, isPending, error, refetch } = usePortlet<StorePulsePortlet>(moduleKey, portletKey);

  const value = (m: StorePulsePortlet['metrics'][number]) => {
    if (m.format === 'money') return { shown: formatMoneyShort(m.value, data?.currency ?? 'EGP'), exact: formatMoney(m.value, data?.currency ?? 'EGP') };
    if (m.format === 'percent') return { shown: formatPercent(m.value), exact: formatPercent(m.value) };
    return { shown: formatInteger(m.value), exact: formatInteger(m.value) };
  };

  return (
    <Card
      title={title}
      subtitle={data ? `${data.shopName} · business day ${formatDate(`${data.businessDate}T12:00:00Z`)}` : 'Today so far'}
      actions={
        <span className="card__actionrow">
          {data?.provisional ? <ProvisionalTag what="day" /> : null}
          {data ? <DataAge seconds={data.dataAgeSeconds} /> : null}
        </span>
      }
    >
      {isPending ? <LoadingState lines={2} />
        : error ? <ErrorState error={error} onRetry={() => void refetch()} compact />
          : !data?.metrics?.length ? <EmptyState icon="activity" title="No figures for today yet" />
            : (
              <>
                <ul className="pulse">
                  {data.metrics.map((m, i) => {
                    const v = value(m);
                    return (
                      <li key={m.key} className="pulse__item">
                        <p className="pulse__label">{m.label}</p>
                        <p className="pulse__value" title={v.exact}>{v.shown}</p>
                        <Delta value={m.value} comparedTo={m.comparedTo} label={m.comparisonLabel}
                               invert={i < 0} />
                      </li>
                    );
                  })}
                </ul>
                <p className="pulse__note">
                  The day is counted in Africa/Cairo. Cash on delivery means <strong>collected</strong> trails
                  <strong> sales</strong> by whatever the couriers are still carrying.
                </p>
              </>
            )}
    </Card>
  );
}

function MyAlerts({ moduleKey, portletKey, title }: PortletProps) {
  const { data, isPending, error, refetch } = usePortlet<MyAlertsPortlet>(moduleKey, portletKey);
  const alerts = data?.alerts ?? [];
  const toneOf = (s: string) => (s === 'CRITICAL' ? 'critical' : s === 'WARNING' ? 'warning' : 'info');
  return (
    <Card
      title={title}
      subtitle="Raised for you"
      actions={data?.unread ? <Badge tone="critical" icon="bell">{data.unread} unread</Badge> : undefined}
    >
      {isPending ? <LoadingState lines={3} />
        : error ? <ErrorState error={error} onRetry={() => void refetch()} compact />
          : !alerts.length ? <EmptyState icon="check" title="Nothing needs you" hint="Alerts about your dashboards and orders would appear here." />
            : (
              <ul className="alertlist">
                {alerts.map((a) => (
                  <li key={a.id} className={`alertlist__row${a.readAt ? '' : ' is-unread'}`}>
                    <Badge tone={toneOf(a.severity)} icon={a.severity === 'INFO' ? 'info' : 'warning'}>
                      {a.severity.toLowerCase()}
                    </Badge>
                    <span className="alertlist__body">
                      <strong>{a.title}</strong>
                      {a.body ? <span>{a.body}</span> : null}
                      <span className="alertlist__when">{formatWeekday(a.createdAt)} · {formatTime(a.createdAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
    </Card>
  );
}

/* ------------------------------------------------------ the hub's own -- */

/**
 * Two portlets belong to the portal rather than to any module, so they have no
 * endpoint: they are read straight off the module descriptors the shell already
 * fetched. That is deliberate -- registering a new module makes it appear in
 * both without a line of code here.
 */

const ACTION_HINTS: Record<string, string> = {
  '/meeting-rooms/book': 'Find a free room and reserve it',
  '/meeting-rooms/reservations': 'View, change or cancel your bookings',
  '/sales': 'Open the dashboards granted to you',
  '/sales/orders': 'Look up an order by number or customer',
};

function QuickActions({ title }: PortletProps) {
  const { data, isPending } = useHubModules();

  /* Every live module's navigation, flattened, capped at six: a quick action
     the employee has to hunt through is not a quick action. */
  const actions = (data?.modules ?? [])
    .filter((m) => m.enabled && !m.comingSoon)
    .flatMap((m) => m.navigation.map((n) => ({ ...n, module: m.name })))
    .slice(0, 6);

  return (
    <Card title={title} subtitle="The things you do most">
      {isPending ? <LoadingState lines={3} />
        : !actions.length ? <EmptyState icon="sparkles" title="No actions yet" hint="Modules granted to you add their shortcuts here." />
          : (
            <div className="actions">
              {actions.map((a) => (
                <Link className="action" to={a.path} key={a.path}>
                  <span className="action__icon"><Icon name={a.icon} size={17} /></span>
                  <span className="action__label">{a.label}</span>
                  <span className="action__hint">{ACTION_HINTS[a.path] ?? a.module}</span>
                </Link>
              ))}
            </div>
          )}
    </Card>
  );
}

function ComingSoon({ title }: PortletProps) {
  const { data, isPending } = useHubModules();
  const upcoming = (data?.modules ?? []).filter((m) => m.comingSoon);

  return (
    <Card title={title} subtitle="Modules already registered, not yet built" tone="quiet">
      {isPending ? <LoadingState lines={2} />
        : !upcoming.length ? <EmptyState icon="check" title="Everything registered is live" />
          : (
            <ul className="soonstrip">
              {upcoming.map((m) => (
                <li className="soonchip" key={m.key}>
                  <Icon name={m.navigation[0]?.icon ?? 'sparkles'} size={14} />
                  {m.name}
                </li>
              ))}
            </ul>
          )}
    </Card>
  );
}

/** Seeds for the portlets the hub contributes itself, in first-visit order. */
export const LOCAL_PORTLETS: ReadonlyArray<{ key: string; title: string; width: number }> = [
  { key: 'quick-actions', title: 'Quick actions', width: 4 },
  { key: 'coming-soon', title: "What's coming", width: 12 },
];

/* ---------------------------------------------------------- registry -- */

export const PORTLET_REGISTRY: Record<string, ComponentType<PortletProps>> = {
  'next-meeting': NextMeeting,
  'my-invitations': MyInvitations,
  'free-now': FreeNow,
  'upcoming-reservations': UpcomingReservations,
  'my-dashboards': MyDashboards,
  'store-pulse': StorePulse,
  'my-alerts': MyAlerts,
  'quick-actions': QuickActions,
  'coming-soon': ComingSoon,
};

export function UnknownPortlet({ title, portletKey }: PortletProps) {
  return (
    <Card title={title} tone="quiet">
      <PlaceholderState
        label={`No component for "${portletKey}"`}
        hint="A module offered a portlet this portal build does not know how to draw. The rest of the grid is unaffected."
      />
    </Card>
  );
}
