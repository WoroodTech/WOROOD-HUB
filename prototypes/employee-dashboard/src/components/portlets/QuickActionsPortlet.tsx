import { Link } from 'react-router-dom';
import { Icon } from '../Icon';

interface QuickAction {
  label: string;
  desc: string;
  icon: string;
  path?: string;
  comingSoon?: boolean;
}

const ACTIONS: QuickAction[] = [
  { label: 'Book a Room', desc: 'Find and reserve a meeting room', icon: 'calendar-plus', path: '/meeting-rooms/book' },
  { label: 'My Reservations', desc: 'View, modify or cancel bookings', icon: 'list', path: '/meeting-rooms/reservations' },
  { label: 'Request Leave', desc: 'Coming soon', icon: 'sun', comingSoon: true },
  { label: 'Submit a Ticket', desc: 'Coming soon', icon: 'life-buoy', comingSoon: true },
];

export function QuickActionsPortlet() {
  return (
    <div className="wh-portlet">
      <div className="wh-portlet__header">
        <span className="wh-portlet__title">Quick Actions</span>
      </div>
      <div className="wh-portlet__body">
        <div className="wh-quick-actions">
          {ACTIONS.map((action) =>
            action.comingSoon ? (
              <span className="wh-quick-action is-disabled" key={action.label} title="Coming soon">
                <span className="wh-quick-action__icon">
                  <Icon name={action.icon} />
                </span>
                <span className="wh-quick-action__label">{action.label}</span>
                <span className="wh-quick-action__desc">{action.desc}</span>
              </span>
            ) : (
              <Link className="wh-quick-action" to={action.path!} key={action.label}>
                <span className="wh-quick-action__icon">
                  <Icon name={action.icon} />
                </span>
                <span className="wh-quick-action__label">{action.label}</span>
                <span className="wh-quick-action__desc">{action.desc}</span>
              </Link>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
