import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
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
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('restoring');

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
    const onLost = () => { setPrincipal(null); setStatus('anonymous'); };
    window.addEventListener(AUTH_LOST, onLost);
    return () => window.removeEventListener(AUTH_LOST, onLost);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await apiClient.login(email, password);
    setPrincipal(res.principal);
    setStatus('authenticated');
  }, []);

  const signOut = useCallback(async () => {
    await apiClient.logout();
    setPrincipal(null);
    setStatus('anonymous');
  }, []);

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
