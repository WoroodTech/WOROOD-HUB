/**
 * Thin API client.
 *
 * Holds the access token in memory and the refresh token in localStorage,
 * transparently refreshing once on a 401. A single in-flight refresh is
 * shared by all callers so a burst of parallel requests cannot start a
 * refresh storm.
 */

const BASE = import.meta.env.VITE_API_URL ?? '/api/v1';
const REFRESH_KEY = 'worood.refreshToken';

let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;

export interface ApiError extends Error {
  status: number;
  payload?: any;
}

export const tokenStore = {
  get access() {
    return accessToken;
  },
  set access(value: string | null) {
    accessToken = value;
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  set refresh(value: string | null) {
    if (value) localStorage.setItem(REFRESH_KEY, value);
    else localStorage.removeItem(REFRESH_KEY);
  },
  clear() {
    accessToken = null;
    localStorage.removeItem(REFRESH_KEY);
  },
};

async function rawRequest(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function renewAccessToken(): Promise<string | null> {
  const refreshToken = tokenStore.refresh;
  if (!refreshToken) return null;

  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        tokenStore.clear();
        return null;
      }
      const data = await response.json();
      accessToken = data.accessToken;
      tokenStore.refresh = data.refreshToken;
      return data.accessToken as string;
    } finally {
      // Allow the next 401 to trigger a fresh attempt.
      setTimeout(() => (refreshInFlight = null), 0);
    }
  })();

  return refreshInFlight;
}

export async function api<T = any>(
  path: string,
  options: { method?: string; body?: unknown; retry?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, retry = true } = options;
  const init: RequestInit = { method, body: body ? JSON.stringify(body) : undefined };

  let response = await rawRequest(path, init);

  if (response.status === 401 && retry && tokenStore.refresh) {
    const renewed = await renewAccessToken();
    if (renewed) response = await rawRequest(path, init);
  }

  const text = await response.text();
  const payload = text ? safeParse(text) : null;

  if (!response.ok) {
    const error = new Error(
      payload?.message ?? `Request failed with status ${response.status}`,
    ) as ApiError;
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload as T;
}

function safeParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/* ------------------------------------------------------------------ types */

export interface SessionUser {
  id: string;
  employeeNo: string;
  email: string;
  fullName: string;
  jobTitle: string | null;
  avatarUrl: string | null;
  timezone: string;
  locale: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
}

export interface HubModule {
  key: string;
  name: string;
  nameAr?: string;
  description: string;
  version: string;
  icon: string;
  navigation: { label: string; labelAr?: string; path: string; icon: string }[];
  portlets: { key: string; title: string; titleAr?: string; width: number; order: number }[];
}

export interface RoomEquipmentItem {
  key: string;
  name: string;
  icon: string | null;
  quantity: number;
}

export interface Room {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  capacity: number;
  floor: string | null;
  description: string | null;
  status: 'ACTIVE' | 'MAINTENANCE' | 'INACTIVE';
  openingTime: string;
  closingTime: string;
  slotMinutes: number;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  maxAdvanceDays: number;
  bufferMinutes: number;
  requiresApproval: boolean;
  location: { id: string; name: string; building: string | null; timezone: string };
  equipment: RoomEquipmentItem[];
}

export interface BusyBlock {
  startsAt: string;
  endsAt: string;
  kind: 'RESERVATION' | 'BLACKOUT';
  title?: string;
}

export interface RoomAvailability {
  room: Room;
  availableForRequestedWindow?: boolean;
  bookableFrom: string;
  bookableTo: string;
  busy: BusyBlock[];
  freeSlots: { startsAt: string; endsAt: string }[];
}

export interface Reservation {
  id: string;
  reference: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';
  attendeeCount: number;
  cancellationReason: string | null;
  isPast: boolean;
  isOrganizer: boolean;
  canModify: boolean;
  canCancel: boolean;
  room: { id: string; code: string; name: string; capacity: number; floor: string | null };
  organizer: { id: string; fullName: string; email: string };
  createdAt: string;
  attendees?: { id: string; fullName: string | null; email: string | null; response: string }[];
}
