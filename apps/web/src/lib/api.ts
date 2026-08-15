/**
 * The one place the portal talks to the API.
 *
 * The access token lives in memory only. The refresh token lives in
 * localStorage, because it is the only thing that survives a reload. A 401 is
 * retried exactly once behind a *single shared* refresh promise, so a screen
 * that fires eight requests at once cannot cause eight refreshes.
 */

import type { LoginResponse, Principal } from '../contract';

const BASE = '/api/v1';
const REFRESH_KEY = 'worood.refreshToken';

let accessToken: string | null = null;
let inFlightRefresh: Promise<string> | null = null;

export const getAccessToken = () => accessToken;
export const getRefreshToken = () => localStorage.getItem(REFRESH_KEY);

export function setSession(res: LoginResponse) {
  accessToken = res.accessToken;
  localStorage.setItem(REFRESH_KEY, res.refreshToken);
}

export function clearSession() {
  accessToken = null;
  inFlightRefresh = null;
  localStorage.removeItem(REFRESH_KEY);
}

/** Fired when the session cannot be recovered; the shell sends you to /login. */
export const AUTH_LOST = 'worood:auth-lost';
const announceAuthLost = () => window.dispatchEvent(new CustomEvent(AUTH_LOST));

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
  /** True when the caller is authenticated but not allowed -- a permission gate,
   *  not a failure; screens render this as an explanation, not an error. */
  get forbidden() { return this.status === 403; }
  get notFound() { return this.status === 404; }
}

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function messageOf(body: any, fallback: string): string {
  if (!body) return fallback;
  if (typeof body === 'string') return body;
  return body?.error?.message ?? body?.message ?? fallback;
}

/** All concurrent 401s await the same refresh. */
function refreshOnce(): Promise<string> {
  if (inFlightRefresh) return inFlightRefresh;
  const token = getRefreshToken();
  if (!token) {
    return Promise.reject(new ApiError(401, 'Session expired'));
  }
  inFlightRefresh = (async () => {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    });
    const body = await parse(res);
    if (!res.ok) throw new ApiError(res.status, messageOf(body, 'Could not refresh the session'), body);
    setSession(body as LoginResponse);
    return (body as LoginResponse).accessToken;
  })();
  // Clear the slot however it settles, so the next 401 starts a fresh attempt.
  inFlightRefresh.catch(() => undefined).finally(() => { inFlightRefresh = null; });
  return inFlightRefresh;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Internal: set on the retry so a second 401 gives up instead of looping. */
  retried?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, retried } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method, headers, signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && !retried) {
    try {
      await refreshOnce();
    } catch {
      clearSession();
      announceAuthLost();
      throw new ApiError(401, 'Your session has expired. Please sign in again.');
    }
    return api<T>(path, { ...options, retried: true });
  }

  const parsed = await parse(res);
  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
      announceAuthLost();
    }
    throw new ApiError(res.status, messageOf(parsed, `Request failed (${res.status})`), parsed);
  }
  return parsed as T;
}

/* ------------------------------------------------------------------- auth -- */

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await parse(res);
  if (!res.ok) throw new ApiError(res.status, messageOf(body, 'Sign-in failed'), body);
  setSession(body as LoginResponse);
  return body as LoginResponse;
}

export const me = () => api<Principal>('/auth/me');

/** Restore a session from the stored refresh token on a cold load. */
export async function restore(): Promise<Principal | null> {
  if (!getRefreshToken()) return null;
  try {
    await refreshOnce();
    return await me();
  } catch {
    clearSession();
    return null;
  }
}

export async function logout() {
  const refreshToken = getRefreshToken();
  clearSession();
  if (!refreshToken) return;
  try {
    await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch { /* signing out locally is what matters */ }
}
