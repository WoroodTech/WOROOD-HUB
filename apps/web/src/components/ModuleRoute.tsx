import { Navigate, Outlet } from 'react-router-dom';
import { useModuleEnabled } from '../lib/hub';

/**
 * A gate for the routes of a module that may not be part of this deployment.
 *
 * Renders its children when the module is registered, and sends the visitor to
 * the portal home when it is not. Not a permission check -- the API decides
 * who may do what, and these pages are permission-gated already. This is about
 * a module that is not here at all, where the honest answer to the URL is that
 * there is nothing at it.
 *
 * Nothing is rendered until the module list has arrived, because "we do not
 * know yet" must not read as "it is gone": a redirect on a pending query would
 * bounce people off pages they are entitled to, on every cold load.
 */
export function ModuleRoute({ module }: { module: string }) {
  const { known, enabled } = useModuleEnabled(module);
  if (!known) return null;
  return enabled ? <Outlet /> : <Navigate to="/" replace />;
}