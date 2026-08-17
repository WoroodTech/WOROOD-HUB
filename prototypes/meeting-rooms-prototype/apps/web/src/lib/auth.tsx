import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, tokenStore, type SessionUser } from './api';
import { setDisplayTimezone } from './format';

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  can: (...permissions: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the session on a page refresh using the stored refresh token.
  useEffect(() => {
    (async () => {
      if (!tokenStore.refresh) {
        setLoading(false);
        return;
      }
      try {
        const principal = await api<{
          id: string;
          email: string;
          fullName: string;
          roles: string[];
          permissions: string[];
        }>('/auth/me');
        setUser({
          id: principal.id,
          email: principal.email,
          fullName: principal.fullName,
          employeeNo: '',
          jobTitle: null,
          avatarUrl: null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: 'en',
          mustChangePassword: false,
          roles: principal.roles,
          permissions: principal.permissions,
        });
      } catch {
        tokenStore.clear();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api<{ accessToken: string; refreshToken: string; user: SessionUser }>(
      '/auth/login',
      { method: 'POST', body: { email, password }, retry: false },
    );
    tokenStore.access = result.accessToken;
    tokenStore.refresh = result.refreshToken;
    setDisplayTimezone(result.user.timezone);
    setUser(result.user);
  }, []);

  const signOut = useCallback(async () => {
    const refreshToken = tokenStore.refresh;
    if (refreshToken) {
      await api('/auth/logout', { method: 'POST', body: { refreshToken } }).catch(() => undefined);
    }
    tokenStore.clear();
    setUser(null);
  }, []);

  const can = useCallback(
    (...permissions: string[]) => permissions.some((p) => user?.permissions.includes(p) ?? false),
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, can }),
    [user, loading, signIn, signOut, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
