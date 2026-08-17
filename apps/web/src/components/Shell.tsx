import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Icon, WoroodMark } from './Icon';
import { useAuth } from '../lib/auth';
import { useHubModules } from '../lib/hub';
import { useRealtime } from '../lib/realtime';
import { Skeleton } from './States';
import { formatDate } from '../lib/format';
import { LocaleToggle, ThemeToggle } from './Preferences';
import { useAppearanceVersion } from '../lib/theme';

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

/** The socket is a claim that figures are live; when it is down we say so
 *  quietly rather than letting a stale number pose as current. */
function RealtimeChip() {
  const { status } = useRealtime();
  if (status === 'idle') return null;
  const copy: Record<string, { label: string; tone: string; title: string }> = {
    connecting: { label: 'Connecting', tone: 'wait', title: 'Opening the live channel.' },
    live: { label: 'Live', tone: 'live', title: 'Connected. Figures refresh as the shop changes.' },
    reconnecting: { label: 'Reconnecting', tone: 'wait', title: 'The live channel dropped. Figures on screen are as old as their timestamp says -- they are not updating right now.' },
    unauthorized: { label: 'Not live', tone: 'off', title: 'The live channel refused this session. Figures still load through the ordinary API.' },
  };
  const c = copy[status];
  return (
    <span className={`rt rt--${c.tone}`} title={c.title}>
      <span className="rt__dot" aria-hidden="true" />
      {c.label}
    </span>
  );
}

export function Shell() {
  const { principal, signOut } = useAuth();
  const { data, isLoading, isError } = useHubModules();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const appearanceVersion = useAppearanceVersion();

  useEffect(() => { setNavOpen(false); }, [location.pathname]);

  return (
    <div className={`shell${navOpen ? ' shell--nav-open' : ''}`}>
      <a className="skip-link" href="#main">Skip to content</a>

      <aside className="sidebar" id="sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__mark"><WoroodMark /></span>
          <span className="sidebar__wordmark">
            <strong>WOROOD</strong>
            <small>Hub</small>
          </span>
        </div>

        <nav className="sidebar__nav" aria-label="Portal">
          <NavLink to="/" end className={({ isActive }) => `navitem${isActive ? ' navitem--active' : ''}`}>
            <Icon name="home" size={17} /> <span>Home</span>
          </NavLink>

          {isLoading ? <div className="sidebar__loading"><Skeleton lines={4} height={10} /></div> : null}
          {isError ? <p className="sidebar__error">Navigation unavailable.</p> : null}

          {data?.modules.map((module) => (
            module.navigation.length ? (
              <div className="navgroup" key={module.key}>
                <p className="navgroup__label">
                  {module.name}
                  {module.comingSoon ? <span className="navgroup__soon">soon</span> : null}
                </p>
                {module.navigation.map((item) => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/sales'}
                    className={({ isActive }) => `navitem${isActive ? ' navitem--active' : ''}`}
                  >
                    <Icon name={item.icon} size={17} /> <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            ) : null
          ))}
        </nav>

        <div className="sidebar__foot">
          <p className="sidebar__date">{formatDate(new Date().toISOString())} · Cairo</p>
        </div>
      </aside>

      <div className="shell__main">
        <header className="topbar">
          <button
            type="button"
            className="topbar__burger"
            aria-expanded={navOpen}
            aria-controls="sidebar"
            onClick={() => setNavOpen((v) => !v)}
          >
            <Icon name={navOpen ? 'minus' : 'layout-grid'} size={18} />
            <span className="visually-hidden">{navOpen ? 'Close navigation' : 'Open navigation'}</span>
          </button>

          <div className="topbar__spacer" />
          <RealtimeChip />

          <span className="topbar__prefs">
            <ThemeToggle />
            <LocaleToggle />
          </span>

          <div className="who">
            <span className="who__avatar" aria-hidden="true">{initials(principal?.fullName ?? '?')}</span>
            <span className="who__text">
              <span className="who__name">{principal?.fullName}</span>
              <span className="who__roles">
                {(principal?.roles ?? []).map((role) => (
                  <span className="rolechip" key={role}>{role.replace(/-/g, ' ')}</span>
                ))}
              </span>
            </span>
          </div>

          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void signOut()}>
            <Icon name="logout" size={15} /> <span className="btn__label">Sign out</span>
          </button>
        </header>

        {/* Charts paint literal hex values into SVG, so a theme switch has to
            remount them. Everything they show is in the query cache, so this
            costs a repaint, not a round trip. */}
        <main className="content" id="main" key={appearanceVersion}>
          <Outlet />
        </main>
      </div>

      <button
        type="button"
        className="shell__scrim"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => setNavOpen(false)}
      />
    </div>
  );
}
