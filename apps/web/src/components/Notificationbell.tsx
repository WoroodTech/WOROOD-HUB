/**
 * The notification bell.
 *
 * `core_notifications` has been filling up since the meeting-rooms module
 * shipped and nothing ever read it — no bell, no endpoint, no screen. This is
 * the other half, and it is why invitations appeared to do nothing.
 *
 * Browser notifications are raised from here too, while the portal is open. Not
 * Web Push: there is no service worker and no VAPID key, so nothing arrives
 * with the tab closed. That was the deliberate choice — the email covers the
 * person who is not looking at the portal, and this covers the person who is.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Icon } from './Icon';
import { formatAge } from '../lib/format';

interface NotificationItem {
  id: string;
  moduleKey: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/* Which notifications this browser has already raised a toast for.
 *
 * In localStorage rather than in state, because two open tabs both poll and
 * both would otherwise pop the same meeting invitation — and because a reload
 * should not replay this morning's notifications as though they were new.
 *
 * Bounded: the ids are uuids and a person who leaves the portal open for a
 * month would otherwise grow this without limit. */
const SEEN_KEY = 'worood.notifications.seen';
const readSeen = (): string[] => {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'); } catch { return []; }
};
const remember = (ids: string[]) => {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...readSeen(), ...ids].slice(-200)));
  } catch { /* private browsing, or a full quota. Not worth failing over. */ }
};

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [canPrompt, setCanPrompt] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const panel = useRef<HTMLDivElement>(null);
  const primed = useRef(false);

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: NotificationItem[]; unread: number }>('/notifications'),
    /* Thirty seconds. An invitation is not an alarm, and a tighter loop would
       cost a request every few seconds per open tab for the rest of the day to
       make a meeting notice arrive slightly sooner. */
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const items = data?.notifications ?? [];
  const unread = data?.unread ?? 0;

  const markRead = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const markAll = useMutation({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  /* Raise a browser notification for anything unread this browser has not
     already shown.
   
     The first poll after a page load is deliberately skipped. Without that,
     opening the portal in the morning fires one toast per unread notification
     at once -- which is how a useful signal becomes something people switch
     off in their browser settings, permanently and for every site. */
  useEffect(() => {
    if (!items.length) return;

    const fresh = items.filter((n) => !n.readAt);
    if (!primed.current) {
      primed.current = true;
      remember(fresh.map((n) => n.id));
      return;
    }

    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') { setCanPrompt(true); return; }
    if (Notification.permission !== 'granted') return;

    const seen = new Set(readSeen());
    const toShow = fresh.filter((n) => !seen.has(n.id));
    if (!toShow.length) return;

    for (const n of toShow) {
      try {
        const note = new Notification(n.title, {
          body: n.body ?? undefined,
          /* The tag collapses repeats of the same notification -- a second tab,
             or a re-render -- into one on the desktop. */
          tag: n.id,
          icon: '/favicon.svg',
        });
        note.onclick = () => {
          window.focus();
          if (n.link) navigate(n.link);
          note.close();
        };
      } catch { /* Some browsers refuse outside a user gesture. Not fatal. */ }
    }
    remember(toShow.map((n) => n.id));
  }, [items, navigate]);

  // Close on a click elsewhere, the way every other menu in the portal does.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const openItem = (n: NotificationItem) => {
    if (!n.readAt) markRead.mutate(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <div className="bell" ref={panel}>
      <button
        type="button"
        className="bell__btn"
        aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="bell" size={17} />
        {unread > 0 ? (
          <span className="bell__count">{unread > 9 ? '9+' : unread}</span>
        ) : null}
      </button>

      {open ? (
        <div className="bell__panel" role="dialog" aria-label="Notifications">
          <header className="bell__head">
            <strong>Notifications</strong>
            {unread > 0 ? (
              <button type="button" className="link" onClick={() => markAll.mutate()}>
                Mark all read
              </button>
            ) : null}
          </header>

          {/* Asked for at the moment it becomes useful -- when there is
              something to show -- rather than on first load. A permission
              prompt that appears before anyone knows what it is for is the one
              people dismiss, and a dismissal is permanent. */}
          {canPrompt ? (
            <button
              type="button"
              className="bell__prompt"
              onClick={() => {
                void Notification.requestPermission().then(() => setCanPrompt(false));
              }}
            >
              <Icon name="bell" size={14} />
              Show these on my desktop while the portal is open
            </button>
          ) : null}

          <ul className="bell__list">
            {items.length === 0 ? (
              <li className="bell__empty">Nothing yet.</li>
            ) : items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={`bell__item${n.readAt ? '' : ' bell__item--unread'}`}
                  onClick={() => openItem(n)}
                >
                  <span className="bell__title">{n.title}</span>
                  {n.body ? <span className="bell__body">{n.body}</span> : null}
                  <span className="bell__when">{formatAge(
                    Math.round((Date.now() - new Date(n.createdAt).getTime()) / 1000))}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}