/**
 * My reservations.
 *
 * Upcoming by default, because the thing an employee opens this screen to do
 * is find or cancel a meeting that has not happened yet. Past bookings are one
 * click away and never mixed in — a cancelled meeting from March in the same
 * list as tomorrow's is noise.
 *
 * Whether the buttons appear is not decided here. The API returns `canManage`
 * per reservation, and this screen honours it. Re-deriving "am I the organiser
 * or do I hold manage-any" in the browser is how the two answers drift apart.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Reservation, ReservationsResponse } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { PERMISSIONS } from '../contract';
import { Badge, Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDate, formatTime, formatWeekday } from '../lib/format';

type Period = 'upcoming' | 'past';
type Scope = 'mine' | 'invited' | 'organised' | 'all';

const RESPONSE_TONE: Record<string, 'good' | 'critical' | 'neutral'> = {
  ACCEPTED: 'good', DECLINED: 'critical', INVITED: 'neutral',
};

const STATUS_TONE: Record<string, 'good' | 'warning' | 'critical' | 'neutral'> = {
  CONFIRMED: 'good', PENDING: 'warning', CANCELLED: 'critical', COMPLETED: 'neutral',
};

export function MyReservations() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [period, setPeriod] = useState<Period>('upcoming');
  const [scope, setScope] = useState<Scope>('mine');
  const [cancelling, setCancelling] = useState<Reservation | null>(null);

  const canSeeAll = can(PERMISSIONS.RESERVATION_MANAGE_ANY);
  const effectiveScope: Scope = scope === 'all' && !canSeeAll ? 'mine' : scope;
  const params = new URLSearchParams({ period, scope: effectiveScope }).toString();

  const list = useQuery({
    queryKey: qk.reservations(params),
    queryFn: () => api<ReservationsResponse>(`/meeting-rooms/reservations?${params}`),
  });

  const respond = useMutation({
    mutationFn: ({ id, response }: { id: string; response: 'ACCEPTED' | 'DECLINED' }) =>
      api<Reservation>(`/meeting-rooms/reservations/${id}/response`, {
        method: 'POST', body: { response },
      }),
    onSuccess: (r) => {
      toast.push(r.myResponse === 'ACCEPTED'
        ? `You are going to "${r.title}". The organiser has been told.`
        : `You declined "${r.title}". The organiser has been told.`, 'good');
      void queryClient.invalidateQueries({ queryKey: ['mr'] });
      void queryClient.invalidateQueries({ queryKey: ['portlet'] });
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not reply.', 'warning'),
  });

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api<Reservation>(`/meeting-rooms/reservations/${id}`, {
        method: 'DELETE', body: { reason },
      }),
    onSuccess: (r) => {
      setCancelling(null);
      toast.push(`${r.reference} cancelled. The room is free again.`, 'good');
      void queryClient.invalidateQueries({ queryKey: ['mr'] });
      void queryClient.invalidateQueries({ queryKey: ['portlet'] });
    },
  });

  const reservations = list.data?.reservations ?? [];

  /* Unanswered invitations come out of the main list and go to the top. They
     are the only thing on this screen that is waiting on the person reading
     it, and mixed in among twenty confirmed meetings they get missed. */
  const awaiting = period === 'upcoming'
    ? reservations.filter((r) => r.myRole === 'attendee' && r.myResponse === 'INVITED' && r.status !== 'CANCELLED')
    : [];
  const awaitingIds = new Set(awaiting.map((r) => r.id));
  const rest = reservations.filter((r) => !awaitingIds.has(r.id));

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">My meetings</h1>
          <p className="pagehead__sub">
            Meetings you booked and meetings you were invited to. Cancelling frees the
            room immediately — the booking stays on the record with who cancelled it and why.
          </p>
        </div>
        <div className="pagehead__tools">
          <Link className="btn btn--primary btn--sm" to="/meeting-rooms/book">
            <Icon name="plus" size={15} /> <span className="btn__label">Book a room</span>
          </Link>
        </div>
      </header>

      <div className="switchrow">
        <div className="switch" role="group" aria-label="Period">
          {(['upcoming', 'past'] as Period[]).map((p) => (
            <button
              key={p} type="button" aria-pressed={period === p}
              className={`switch__btn${period === p ? ' is-on' : ''}`}
              onClick={() => setPeriod(p)}
            >
              {p === 'upcoming' ? 'Upcoming' : 'Past'}
            </button>
          ))}
        </div>

        <div className="switch" role="group" aria-label="Whose">
          {([
            ['mine', 'All mine'],
            ['organised', 'I booked'],
            ['invited', 'I was invited'],
            ...(canSeeAll ? [['all', 'Everyone’s'] as const] : []),
          ] as Array<[Scope, string]>).map(([s, label]) => (
            <button
              key={s} type="button" aria-pressed={scope === s}
              className={`switch__btn${scope === s ? ' is-on' : ''}`}
              onClick={() => setScope(s)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {list.isPending ? <LoadingState label="Loading your reservations" lines={4} /> : null}
      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}

      {awaiting.length ? (
        <section className="awaiting">
          <h2 className="awaiting__title">
            <Icon name="bell" size={15} />
            {awaiting.length === 1 ? 'One invitation is waiting for you' : `${awaiting.length} invitations are waiting for you`}
          </h2>
          <ul className="bookings">
            {awaiting.map((r) => (
              <li key={r.id}>
                <article className="booking booking--invite">
                  <div className="booking__when">
                    <strong>{formatWeekday(r.startsAt)}</strong>
                    <span>{formatDate(r.startsAt)}</span>
                    <span className="booking__hours">{formatTime(r.startsAt)} – {formatTime(r.endsAt)}</span>
                  </div>
                  <div className="booking__body">
                    <h3 className="booking__title">{r.title}</h3>
                    <p className="booking__meta">
                      {r.room.name}{r.room.floor ? `, floor ${r.room.floor}` : ''} · invited by {r.organiser.fullName}
                    </p>
                    {r.description ? <p className="booking__note">{r.description}</p> : null}
                  </div>
                  <div className="booking__side">
                    <button
                      type="button" className="btn btn--primary btn--sm" disabled={respond.isPending}
                      onClick={() => respond.mutate({ id: r.id, response: 'ACCEPTED' })}
                    >
                      <Icon name="check" size={14} /> <span className="btn__label">Accept</span>
                    </button>
                    <button
                      type="button" className="btn btn--ghost btn--sm" disabled={respond.isPending}
                      onClick={() => respond.mutate({ id: r.id, response: 'DECLINED' })}
                    >
                      <span className="btn__label">Decline</span>
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {list.data && !reservations.length ? (
        <Card title={period === 'upcoming' ? 'Nothing booked' : 'Nothing in the past'} tone="quiet">
          <EmptyState
            icon="calendar"
            title={period === 'upcoming' ? 'Your calendar is clear' : 'No past meetings'}
            hint={period === 'upcoming'
              ? <>When you need a room, <Link to="/meeting-rooms/book">book one</Link>.</>
              : 'Meetings move here once they have finished.'}
          />
        </Card>
      ) : null}

      {rest.length ? (
        <ul className="bookings">
          {rest.map((r) => (
            <li key={r.id}>
              <article className={`booking${r.status === 'CANCELLED' ? ' booking--void' : ''}`}>
                <div className="booking__when">
                  <strong>{formatWeekday(r.startsAt)}</strong>
                  <span>{formatDate(r.startsAt)}</span>
                  <span className="booking__hours">{formatTime(r.startsAt)} – {formatTime(r.endsAt)}</span>
                </div>

                <div className="booking__body">
                  <h2 className="booking__title">{r.title}</h2>
                  <p className="booking__meta">
                    {r.room.name}{r.room.floor ? `, floor ${r.room.floor}` : ''} · {r.room.location}
                    {' · '}{r.attendeeCount} attending
                  </p>
                  {r.description ? <p className="booking__note">{r.description}</p> : null}
                  {r.myRole !== 'organiser' && r.organiser?.fullName ? (
                    <p className="booking__meta">Booked by {r.organiser.fullName}</p>
                  ) : null}

                  {/* Who else is coming, and what they said. The organiser needs
                      this to know whether the meeting is worth having; an
                      attendee needs it to know who else will be in the room. */}
                  {r.attendees.length ? (
                    <ul className="guestlist">
                      {r.attendees.map((a) => (
                        <li key={a.userId ?? a.email} className="guest">
                          <Badge tone={RESPONSE_TONE[a.response] ?? 'neutral'}>
                            {a.response === 'INVITED' ? 'no reply' : a.response.toLowerCase()}
                          </Badge>
                          <span className="guest__name">{a.name}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {r.status === 'CANCELLED' && r.cancellationReason ? (
                    <p className="booking__note">Cancelled: {r.cancellationReason}</p>
                  ) : null}
                </div>

                <div className="booking__side">
                  <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Badge>
                  {r.myRole === 'attendee' && r.myResponse && r.myResponse !== 'INVITED' ? (
                    <Badge tone={RESPONSE_TONE[r.myResponse]}>
                      you {r.myResponse.toLowerCase()}
                    </Badge>
                  ) : null}
                  <span className="mono booking__ref">{r.reference}</span>
                  {r.canManage && r.status !== 'CANCELLED' && period === 'upcoming' ? (
                    <button
                      type="button" className="btn btn--ghost btn--sm"
                      onClick={() => setCancelling(r)}
                    >
                      <Icon name="minus" size={14} /> <span className="btn__label">Cancel</span>
                    </button>
                  ) : null}
                  {/* An attendee cannot cancel somebody else's meeting -- they
                      change their own answer instead. */}
                  {r.myRole === 'attendee' && !r.canManage && r.status !== 'CANCELLED' && period === 'upcoming' ? (
                    <button
                      type="button" className="btn btn--ghost btn--sm" disabled={respond.isPending}
                      onClick={() => respond.mutate({
                        id: r.id, response: r.myResponse === 'DECLINED' ? 'ACCEPTED' : 'DECLINED',
                      })}
                    >
                      <span className="btn__label">
                        {r.myResponse === 'DECLINED' ? 'Actually, I’ll come' : 'Can’t make it'}
                      </span>
                    </button>
                  ) : null}
                </div>
              </article>
            </li>
          ))}
        </ul>
      ) : null}

      {cancelling ? (
        <CancelDialog
          reservation={cancelling}
          busy={cancel.isPending}
          error={cancel.error}
          onClose={() => { cancel.reset(); setCancelling(null); }}
          onConfirm={(reason) => cancel.mutate({ id: cancelling.id, reason })}
        />
      ) : null}
    </div>
  );
}

function CancelDialog({ reservation, busy, error, onClose, onConfirm }: {
  reservation: Reservation;
  busy: boolean; error: unknown;
  onClose: () => void;
  onConfirm: (reason?: string) => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="cancel-title">
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 id="cancel-title" className="modal__title">Cancel this booking?</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="minus" size={15} />
          </button>
        </header>

        <div className="modal__body">
          <dl className="factlist">
            <div><dt>Meeting</dt><dd>{reservation.title}</dd></div>
            <div><dt>Room</dt><dd>{reservation.room.name}</dd></div>
            <div><dt>When</dt><dd>{formatWeekday(reservation.startsAt)}, {formatTime(reservation.startsAt)} – {formatTime(reservation.endsAt)}</dd></div>
            <div><dt>Reference</dt><dd className="mono">{reservation.reference}</dd></div>
          </dl>

          <label className="field">
            <span className="field__label">Reason <span className="field__opt">optional, but the next person to ask will thank you</span></span>
            <input
              className="input" value={reason} maxLength={500} autoFocus
              placeholder="e.g. moved to a call"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          {error ? (
            <p className="notice notice--error">
              <Icon name="warning" size={15} />
              <span>{error instanceof Error ? error.message : 'Could not cancel this booking.'}</span>
            </p>
          ) : null}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Keep it</button>
          <button
            type="button" className="btn btn--danger" disabled={busy}
            onClick={() => onConfirm(reason.trim() || undefined)}
          >
            {busy ? 'Cancelling…' : 'Cancel booking'}
          </button>
        </footer>
      </div>
    </div>
  );
}
