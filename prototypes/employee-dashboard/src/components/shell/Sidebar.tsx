import { NavLink } from 'react-router-dom';
import { Icon } from '../Icon';
import type { HubModule } from '../../lib/types';

interface SidebarProps {
  modules: HubModule[];
}

// Generic shell: renders whatever GET /hub/modules returns. There is no
// hard-coded menu here (Technical Design §3.3) — a future Leave Requests or
// Help Desk module appears the moment its descriptor is registered on the
// backend, with zero changes to this component.
export function Sidebar({ modules }: SidebarProps) {
  return (
    <aside className="wh-sidebar">
      <div className="wh-sidebar__brand">
        <div className="wh-sidebar__brand-mark">WH</div>
        <div>
          <div className="wh-sidebar__brand-name">WOROOD HUB</div>
          <div className="wh-sidebar__brand-sub">Employee Portal</div>
        </div>
      </div>

      <nav className="wh-sidebar__section">
        <NavLink to="/" end className={({ isActive }) => `wh-navitem${isActive ? ' is-active' : ''}`}>
          <span className="wh-navitem__icon">
            <Icon name="home" />
          </span>
          Dashboard
        </NavLink>
      </nav>

      {modules.map((mod) => (
        <div className="wh-sidebar__section" key={mod.key}>
          <div className="wh-sidebar__section-label">{mod.name}</div>
          {mod.navigation.map((item) =>
            item.comingSoon ? (
              <span className="wh-navitem is-disabled" key={item.path} title="Coming soon">
                <span className="wh-navitem__icon">
                  <Icon name={item.icon} />
                </span>
                {item.label}
                <span className="wh-navitem__badge">Soon</span>
              </span>
            ) : (
              <NavLink
                to={item.path}
                key={item.path}
                className={({ isActive }) => `wh-navitem${isActive ? ' is-active' : ''}`}
              >
                <span className="wh-navitem__icon">
                  <Icon name={item.icon} />
                </span>
                {item.label}
              </NavLink>
            ),
          )}
        </div>
      ))}
    </aside>
  );
}
