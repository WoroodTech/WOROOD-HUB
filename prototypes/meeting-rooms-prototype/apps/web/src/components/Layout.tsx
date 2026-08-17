import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type HubModule } from '../lib/api';
import { useAuth } from '../lib/auth';
import { initials } from '../lib/format';

/**
 * The portal shell. Its navigation is built entirely from GET /hub/modules —
 * adding a module to the backend makes it appear here with no frontend change.
 */
export default function Layout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();

  const { data: modules } = useQuery({
    queryKey: ['hub-modules'],
    queryFn: () => api<{ data: HubModule[] }>('/hub/modules').then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">W</div>
          <div>
            <div className="brand-name">WOROOD</div>
            <div className="brand-sub">Employee Hub</div>
          </div>
        </div>

        <nav className="stack" style={{ gap: 18 }}>
          <div>
            <div className="nav-group-title">Overview</div>
            <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              Dashboard
            </NavLink>
          </div>

          {modules?.map((module) => (
            <div key={module.key}>
              <div className="nav-group-title">{module.name}</div>
              {module.navigation.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div>WOROOD HUB v0.1.0</div>
          <div style={{ opacity: 0.7 }}>{modules?.length ?? 0} module(s) active</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="strong">Welcome back, {user?.fullName.split(' ')[0]}</div>
            <div className="muted">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 8 }}>
              <div className="avatar">{initials(user?.fullName ?? '')}</div>
              <div style={{ lineHeight: 1.3 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{user?.fullName}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {user?.roles.join(', ')}
                </div>
              </div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </header>

        <div className="page">{children}</div>
      </div>
    </div>
  );
}
