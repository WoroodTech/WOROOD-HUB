import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type HubModule, type Reservation, type Room } from '../lib/api';
import { Card, Empty, Spinner, StatusBadge } from '../components/ui';
import { formatDate, formatDuration, formatRange, relativeToNow } from '../lib/format';

/**
 * The dashboard renders one portlet per entry declared by each module in the
 * hub registry, so a new module's portlets appear here automatically once the
 * frontend knows how to draw them.
 */
export default function DashboardPage() {
  const { data: modules } = useQuery({
    queryKey: ['hub-modules'],
    queryFn: () => api<{ data: HubModule[] }>('/hub/modules').then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  const portlets =
    modules?.flatMap((module) => module.portlets.map((p) => ({ ...p, moduleKey: module.key }))) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="page-sub">Your day at a glance across every WOROOD HUB module.</p>
        </div>
        <Link className="btn btn-primary" to="/meeting-rooms/book">
          Book a room
        </Link>
      </div>

      <div className="grid">
        {portlets.map((portlet) => (
          <div key={`${portlet.moduleKey}.${portlet.key}`} className={`col-${portlet.width}`}>
            <Portlet portletKey={portlet.key} title={portlet.title} />
          </div>
        ))}
        {portlets.length === 0 && (
          <div className="col-12">
            <Card>
              <Empty>No modules are enabled for your account yet.</Empty>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

function Portlet({ portletKey, title }: { portletKey: string; title: string }) {
  switch (portletKey) {
    case 'next-meeting':
      return <NextMeetingPortlet title={title} />;
    case 'quick-book':
      return <QuickBookPortlet title={title} />;
    case 'free-now':
      return <FreeNowPortlet title={title} />;
    case 'my-upcoming':
      return <UpcomingPortlet title={title} />;
    default:
      return (
        <Card title={title}>
          <Empty>This portlet has no renderer yet.</Empty>
        </Card>
      );
  }
}

/* ------------------------------------------------------------------------ */

function NextMeetingPortlet({ title }: { title: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['next-meeting'],
    queryFn: () => api<{ data: Reservation | null }>('/meeting-rooms/reservations/next').then((r) => r.data),
  });

  return (
    <Card title={title} className="full-height">
      {isLoading ? (
        <Spinner />
      ) : !data ? (
        <Empty>Nothing booked. Enjoy the quiet.</Empty>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="strong" style={{ fontSize: 15 }}>{data.title}</div>
          <div className="stat" style={{ color: 'var(--brand-700)' }}>{formatRange(data.startsAt, data.endsAt)}</div>
          <div className="muted">
            {formatDate(data.startsAt)} · {relativeToNow(data.startsAt)}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 2 }}>
            <span className="chip">{data.room.name}</span>
            <span className="muted">{formatDuration(data.durationMinutes)}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

function QuickBookPortlet({ title }: { title: string }) {
  return (
    <Card title={title}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="muted">Need a room in the next hour? Jump straight to a filtered search.</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Link className="btn btn-ghost btn-sm" to="/meeting-rooms/book?duration=30">
            30 minutes
          </Link>
          <Link className="btn btn-ghost btn-sm" to="/meeting-rooms/book?duration=60">
            1 hour
          </Link>
          <Link className="btn btn-ghost btn-sm" to="/meeting-rooms/book?duration=120">
            2 hours
          </Link>
        </div>
        <Link className="btn btn-primary btn-sm" to="/meeting-rooms/book" style={{ alignSelf: 'flex-start' }}>
          Find a room
        </Link>
      </div>
    </Card>
  );
}

function FreeNowPortlet({ title }: { title: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['free-now'],
    queryFn: () =>
      api<{ data: (Pick<Room, 'id' | 'code' | 'name' | 'capacity' | 'floor'> & { location: string })[] }>(
        '/meeting-rooms/free-now?minutes=60',
      ).then((r) => r.data),
    refetchInterval: 60_000,
  });

  return (
    <Card title={title} action={<span className="badge badge-ok">{data?.length ?? 0} free</span>}>
      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <Empty>Every room is busy for the next hour.</Empty>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {data.slice(0, 5).map((room) => (
            <div key={room.id} className="row-between">
              <div>
                <div className="strong" style={{ fontSize: 13.5 }}>{room.name}</div>
                <div className="muted">
                  {room.location}
                  {room.floor ? ` · ${room.floor}` : ''}
                </div>
              </div>
              <span className="badge badge-mute">{room.capacity} seats</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function UpcomingPortlet({ title }: { title: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['reservations', 'upcoming', 'portlet'],
    queryFn: () =>
      api<{ data: Reservation[] }>('/meeting-rooms/reservations?scope=mine&period=upcoming&limit=6').then(
        (r) => r.data,
      ),
  });

  return (
    <Card
      title={title}
      tight
      action={
        <Link className="btn btn-ghost btn-sm" to="/meeting-rooms/reservations">
          View all
        </Link>
      }
    >
      {isLoading ? (
        <Spinner />
      ) : !data?.length ? (
        <Empty>You have no upcoming reservations.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Meeting</th>
              <th>Room</th>
              <th>When</th>
              <th>Duration</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((reservation) => (
              <tr key={reservation.id}>
                <td>
                  <div className="strong">{reservation.title}</div>
                  <div className="muted">{reservation.reference}</div>
                </td>
                <td>{reservation.room.name}</td>
                <td>
                  {formatDate(reservation.startsAt)}
                  <div className="muted">{formatRange(reservation.startsAt, reservation.endsAt)}</div>
                </td>
                <td>{formatDuration(reservation.durationMinutes)}</td>
                <td>
                  <StatusBadge status={reservation.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
