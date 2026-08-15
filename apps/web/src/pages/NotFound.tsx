import { Link, useLocation } from 'react-router-dom';
import { useHubModules } from '../lib/hub';
import { Icon } from '../components/Icon';

/**
 * The shell's navigation comes from the API, so it can legitimately point at a
 * module whose screens are not part of this portal build. That is a different
 * thing from a wrong address, and the page says which one it is.
 */
export function NotFound() {
  const location = useLocation();
  const { data } = useHubModules();

  const module = data?.modules.find((m) => m.navigation.some((n) => location.pathname.startsWith(n.path)));
  const navItem = module?.navigation.find((n) => location.pathname.startsWith(n.path));

  return (
    <div className="page">
      <div className="notfound">
        <span className="notfound__icon"><Icon name={navItem?.icon ?? 'search'} size={26} /></span>
        {navItem ? (
          <>
            <h1 className="notfound__title">{navItem.label}</h1>
            <p className="notfound__body">
              The <strong>{module?.name}</strong> module publishes this screen in the hub navigation, and the
              portal renders whatever the hub returns rather than a hard-coded menu. Its own interface is not
              part of this build, so there is nothing to show here yet.
            </p>
          </>
        ) : (
          <>
            <h1 className="notfound__title">No screen at this address</h1>
            <p className="notfound__body">
              <span className="mono">{location.pathname}</span> does not match anything this portal serves.
            </p>
          </>
        )}
        <Link className="btn btn--primary" to="/">Back to home</Link>
      </div>
    </div>
  );
}
