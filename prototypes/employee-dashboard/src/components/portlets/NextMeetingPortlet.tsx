import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import { formatTimeRange } from '../../lib/format';
import type { ReservationSummary } from '../../lib/types';

export function NextMeetingPortlet({
  reservation,
  timezone,
}: {
  reservation: ReservationSummary | null;
  timezone: string;
}) {
  return (
    <div className="wh-portlet">
      <div className="wh-portlet__header">
        <span className="wh-portlet__title">My Next Meeting</span>
      </div>
      <div className="wh-portlet__body">
        {!reservation && <div className="wh-portlet__empty">Nothing on your calendar. Enjoy the quiet.</div>}
        {reservation && (
          <div className="wh-meeting">
            <div className="wh-meeting__title">{reservation.title}</div>
            <div className="wh-meeting__meta">
              <Icon name="clock" size={14} /> {formatTimeRange(reservation.startsAt, reservation.endsAt, timezone)}
            </div>
            <div className="wh-meeting__meta">
              <Icon name="map-pin" size={14} /> {reservation.roomName} — {reservation.locationName}
            </div>
          </div>
        )}
        <Link to="/meeting-rooms/reservations" className="wh-portlet__link">
          View all reservations →
        </Link>
      </div>
    </div>
  );
}
