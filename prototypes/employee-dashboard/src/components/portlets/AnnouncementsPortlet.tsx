import { relativeFromNow } from '../../lib/format';
import type { HubNotification } from '../../lib/types';

export function AnnouncementsPortlet({ notifications }: { notifications: HubNotification[] }) {
  return (
    <div className="wh-portlet">
      <div className="wh-portlet__header">
        <span className="wh-portlet__title">Announcements &amp; Activity</span>
      </div>
      <div className="wh-portlet__body" style={{ gap: 0 }}>
        {notifications.length === 0 && <div className="wh-portlet__empty">Nothing new.</div>}
        {notifications.map((n) => (
          <div className={`wh-notification${n.read ? ' is-read' : ''}`} key={n.id}>
            <span className="wh-notification__dot" />
            <div>
              <div className="wh-notification__text">{n.message}</div>
              <div className="wh-notification__time">{relativeFromNow(n.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
