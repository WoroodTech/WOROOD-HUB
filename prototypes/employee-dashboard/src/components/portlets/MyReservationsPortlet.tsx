import { Link } from 'react-router-dom';
import { formatTimeRange } from '../../lib/format';
import type { ReservationSummary } from '../../lib/types';

const STATUS_BADGE: Record<ReservationSummary['status'], string> = {
  CONFIRMED: 'wh-badge--success',
  PENDING: 'wh-badge--warning',
  CANCELLED: 'wh-badge--muted',
};

export function MyReservationsPortlet({
  reservations,
  timezone,
}: {
  reservations: ReservationSummary[];
  timezone: string;
}) {
  return (
    <div className="wh-portlet">
      <div className="wh-portlet__header">
        <span className="wh-portlet__title">Upcoming Reservations</span>
        <Link to="/meeting-rooms/reservations" className="wh-portlet__link">
          See all
        </Link>
      </div>
      <div className="wh-portlet__body">
        {reservations.length === 0 && (
          <div className="wh-portlet__empty">No upcoming reservations — book a room to get started.</div>
        )}
        <div className="wh-list">
          {reservations.map((r) => (
            <div className="wh-list-row" key={r.id}>
              <div className="wh-list-row__main">
                <div className="wh-list-row__title">{r.title}</div>
                <div className="wh-list-row__meta">
                  {r.roomName} · {formatTimeRange(r.startsAt, r.endsAt, timezone)}
                </div>
              </div>
              <span className={`wh-badge ${STATUS_BADGE[r.status]}`}>{r.status.toLowerCase()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
