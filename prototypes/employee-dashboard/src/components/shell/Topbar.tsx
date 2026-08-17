import { useState } from 'react';
import { Icon } from '../Icon';
import { initialsColor, relativeFromNow } from '../../lib/format';
import type { HubNotification, Principal } from '../../lib/types';

interface TopbarProps {
  principal: Principal;
  notifications: HubNotification[];
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function Topbar({ principal, notifications }: TopbarProps) {
  const [open, setOpen] = useState(false);
  const unread = notifications.filter((n) => !n.read).length;
  const firstName = principal.fullName.split(' ')[0];

  return (
    <header className="wh-topbar">
      <div>
        <div className="wh-topbar__greeting">
          {greeting()}, {firstName}
        </div>
        <div className="wh-topbar__date">
          {new Intl.DateTimeFormat('en-GB', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            timeZone: principal.timezone,
          }).format(new Date())}{' '}
          · {principal.locationName}
        </div>
      </div>

      <div className="wh-topbar__actions">
        <button className="wh-iconbutton" aria-label="Search" type="button">
          <Icon name="search" />
        </button>

        <div style={{ position: 'relative' }}>
          <button
            className="wh-iconbutton"
            aria-label="Notifications"
            type="button"
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name="bell" />
            {unread > 0 && <span className="wh-iconbutton__dot" />}
          </button>

          {open && (
            <div
              className="wh-portlet"
              style={{ position: 'absolute', insetInlineEnd: 0, top: 44, width: 320, zIndex: 20 }}
            >
              <div className="wh-portlet__header">
                <span className="wh-portlet__title">Notifications</span>
              </div>
              <div className="wh-portlet__body">
                {notifications.length === 0 && <div className="wh-portlet__empty">You're all caught up.</div>}
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
          )}
        </div>

        <div className="wh-topbar__profile">
          <div className="wh-avatar" style={{ background: initialsColor(principal.avatarInitials) }}>
            {principal.avatarInitials}
          </div>
          <div>
            <div className="wh-topbar__profile-name">{principal.fullName}</div>
            <div className="wh-topbar__profile-role">{principal.jobTitle}</div>
          </div>
          <Icon name="chevron" size={14} />
        </div>
      </div>
    </header>
  );
}
