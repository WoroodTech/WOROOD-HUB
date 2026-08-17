import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import type { FreeRoomNow } from '../../lib/types';

export function FreeRoomsPortlet({ rooms }: { rooms: FreeRoomNow[] }) {
  return (
    <div className="wh-portlet">
      <div className="wh-portlet__header">
        <span className="wh-portlet__title">Free Right Now</span>
      </div>
      <div className="wh-portlet__body">
        {rooms.length === 0 && <div className="wh-portlet__empty">Every room is booked at the moment.</div>}
        {rooms.map((r) => (
          <div className="wh-list-row" key={r.roomId}>
            <div className="wh-list-row__main">
              <div className="wh-list-row__title">{r.roomName}</div>
              <div className="wh-list-row__meta">
                {r.locationName} · seats {r.capacity}
              </div>
            </div>
            <span className="wh-badge wh-badge--success">{r.freeForMinutes} min free</span>
          </div>
        ))}
        <Link to="/meeting-rooms/book" className="wh-portlet__link">
          <Icon name="calendar-plus" size={14} /> Book a room →
        </Link>
      </div>
    </div>
  );
}
