/**
 * Realtime is a *hint channel*, never a data channel. The socket says "these
 * widget keys moved"; the portal then refetches through the ordinary
 * authenticated API, so nothing can arrive that the permission layer would not
 * have granted anyway.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { DashboardDataResponse, MetricsChangedEvent } from '../contract';
import { getAccessToken } from './api';
import { useAuth } from './auth';

export type RealtimeStatus =
  | 'idle'          // no sales access -- the socket is never opened
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'unauthorized';

interface RealtimeState {
  status: RealtimeStatus;
  lastEventAt: string | null;
  lastReason: MetricsChangedEvent['reason'] | null;
  revoked: string | null;
  clearRevoked: () => void;
  subscribe: (dashboardId: string) => void;
  unsubscribe: (dashboardId: string) => void;
}

const RealtimeContext = createContext<RealtimeState | null>(null);

const SALES_PERMS = ['sales.dashboard.view', 'sales.order.view', 'sales.dashboard.manage'];

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { principal } = useAuth();
  const queryClient = useQueryClient();
  const socketRef = useRef<Socket | null>(null);
  const roomsRef = useRef<Set<string>>(new Set());
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [lastReason, setLastReason] = useState<MetricsChangedEvent['reason'] | null>(null);
  const [revoked, setRevoked] = useState<string | null>(null);

  const hasSales = !!principal?.permissions?.some((p) => SALES_PERMS.includes(p));
  /* The socket authenticates as one person. Keying the connection effect on the
     principal's id -- not merely on whether they hold sales permissions -- means
     signing out and back in as a different employee tears the old socket down.
     Without it, two accounts that both have sales access share one connection
     opened with the first one's token, and the first one's events invalidate the
     second one's cache. */
  const identity = principal?.id ?? null;

  /** '*' means invalidate-all; otherwise only the dashboards that hold one of
   *  the named widgets, plus the always-cheap portlet and order lists. */
  const invalidate = useCallback((widgetKeys: string[]) => {
    const all = widgetKeys.includes('*');
    queryClient.invalidateQueries({
      predicate: (query: Query) => {
        const key = query.queryKey as unknown[];
        const head = key[0];
        if (head === 'portlet') return key[1] === 'sales-dashboard';
        if (head !== 'sales') return false;
        if (all) return true;
        if (key[1] === 'dashboard-data') {
          const data = query.state.data as DashboardDataResponse | undefined;
          if (!data) return true; // nothing cached yet -- let it refetch
          return data.widgets.some((w) => widgetKeys.includes(w.widgetKey));
        }
        // Orders and dashboard lists carry figures too.
        return key[1] === 'orders' || key[1] === 'dashboards';
      },
    });
  }, [queryClient]);

  useEffect(() => {
    if (!hasSales) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setStatus('idle');
      return;
    }
    setStatus('connecting');
    const socket = io('/sales', {
      transports: ['websocket', 'polling'],
      auth: (cb) => cb({ token: getAccessToken() }),
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });
    socketRef.current = socket;
    // A new identity is a new session: nothing the previous one had open should
    // be re-joined on its behalf.
    roomsRef.current.clear();

    socket.on('ready', () => {
      setStatus('live');
      // Re-join whatever the open screen had subscribed to before the drop.
      roomsRef.current.forEach((id) => socket.emit('subscribe', { dashboardId: id }));
    });
    socket.on('unauthorized', () => setStatus('unauthorized'));
    socket.on('connect_error', () => setStatus('reconnecting'));
    socket.on('disconnect', () => setStatus('reconnecting'));
    socket.on('metrics:changed', (event: MetricsChangedEvent) => {
      setLastEventAt(event?.at ?? new Date().toISOString());
      setLastReason(event?.reason ?? null);
      invalidate(Array.isArray(event?.widgetKeys) ? event.widgetKeys : ['*']);
    });
    socket.on('dashboard:revoked', (event: { dashboardId: string }) => {
      setRevoked(event?.dashboardId ?? null);
      queryClient.invalidateQueries({ queryKey: ['sales'] });
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [hasSales, identity, invalidate, queryClient]);

  const subscribe = useCallback((dashboardId: string) => {
    roomsRef.current.add(dashboardId);
    socketRef.current?.emit('subscribe', { dashboardId });
  }, []);

  const unsubscribe = useCallback((dashboardId: string) => {
    roomsRef.current.delete(dashboardId);
    socketRef.current?.emit('unsubscribe', { dashboardId });
  }, []);

  const value = useMemo<RealtimeState>(() => ({
    status, lastEventAt, lastReason, revoked,
    clearRevoked: () => setRevoked(null),
    subscribe, unsubscribe,
  }), [status, lastEventAt, lastReason, revoked, subscribe, unsubscribe]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeState {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return ctx;
}

/** Join a dashboard room for as long as the screen is open. */
export function useDashboardSubscription(dashboardId: string | undefined) {
  const { subscribe, unsubscribe, status } = useRealtime();
  useEffect(() => {
    if (!dashboardId) return;
    subscribe(dashboardId);
    return () => unsubscribe(dashboardId);
  }, [dashboardId, subscribe, unsubscribe, status]);
}
