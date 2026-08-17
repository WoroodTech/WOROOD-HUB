import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Principal } from '../contract';
import * as apiClient from './api';
import { AUTH_LOST } from './api';

interface AuthState {
  principal: Principal | null;
  status: 'restoring' | 'anonymous' | 'authenticated';
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('restoring');

  /**
   * Every cached response belongs to the identity that fetched it.
   *
   * The query cache is keyed by endpoint, not by user, so without this a new
   * sign-in renders the *previous* employee's navigation, portlets and figures
   * from cache -- instantly, and for as long as their staleTime says -- until
   * someone happens to reload the page. Both people see it, and neither has any
   * reason to distrust it, which is the worst property a screen can have.
   *
   * `clear()` rather than `invalidateQueries()`: invalidating marks data stale
   * but keeps serving it while it refetches, which is exactly the window we are
   * trying to close. Discarding it means the next screen renders its loading
   * state and then the truth. The data was never the new user's to see, so
   * there is nothing to preserve.
   */
  const forgetEverything = useCallback(() => {
    queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    let alive = true;
    apiClient.restore().then((p) => {
      if (!alive) return;
      setPrincipal(p);
      setStatus(p ? 'authenticated' : 'anonymous');
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onLost = () => { forgetEverything(); setPrincipal(null); setStatus('anonymous'); };
    window.addEventListener(AUTH_LOST, onLost);
    return () => window.removeEventListener(AUTH_LOST, onLost);
  }, [forgetEverything]);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await apiClient.login(email, password);
    // Before the principal changes, so nothing can render from the old cache
    // even for one frame.
    forgetEverything();
    setPrincipal(res.principal);
    setStatus('authenticated');
  }, [forgetEverything]);

  const signOut = useCallback(async () => {
    await apiClient.logout();
    forgetEverything();
    setPrincipal(null);
    setStatus('anonymous');
  }, [forgetEverything]);

  const value = useMemo<AuthState>(() => ({
    principal, status, signIn, signOut,
    can: (permission: string) => !!principal?.permissions?.includes(permission),
  }), [principal, status, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
