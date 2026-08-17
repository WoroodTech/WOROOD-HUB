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

const STATUS_TONE: Record<string, 'good' | 'warning' | 'critical' | 'neutral'> = {
  CONFIRMED: 'good', PENDING: 'warning', CANCELLED: 'critical', COMPLETED: 'neutral',
};

export function MyReservations() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [period, setPeriod] = useState<Period>('upcoming');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [cancelling, setCancelling] = useState<Reservation | null>(null);

  const canSeeAll = can(PERMISSIONS.RESERVATION_MANAGE_ANY);
  const params = new URLSearchParams({ period, scope: canSeeAll ? scope : 'mine' }).toString();

  const list = useQuery({
    queryKey: qk.reservations(params),
    queryFn: () => api<ReservationsResponse>(`/meeting-rooms/reservations?${params}`),
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

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">My reservations</h1>
          <p className="pagehead__sub">
            Cancelling frees the room immediately — the booking stays on the record
            with who cancelled it and why.
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

        {canSeeAll ? (
          <div className="switch" role="group" aria-label="Whose">
            {(['mine', 'all'] as const).map((s) => (
              <button
                key={s} type="button" aria-pressed={scope === s}
                className={`switch__btn${scope === s ? ' is-on' : ''}`}
                onClick={() => setScope(s)}
              >
                {s === 'mine' ? 'Mine' : 'Everyone’s'}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {list.isPending ? <LoadingState label="Loading your reservations" lines={4} /> : null}
      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}

      {list.data && !reservations.length ? (
        <Card title={period === 'upcoming' ? 'Nothing booked' : 'Nothing in the past'} tone="quiet">
          <EmptyState
            icon="calendar"
            title={period === 'upcoming' ? 'Your calendar is clear' : 'No past bookings'}
            hint={period === 'upcoming'
              ? <>When you need a room, <Link to="/meeting-rooms/book">book one</Link>.</>
              : 'Bookings move here once they have finished.'}
          />
        </Card>
      ) : null}

      {reservations.length ? (
        <ul className="bookings">
          {reservations.map((r) => (
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
                  {r.organiser && scope === 'all' ? (
                    <p className="booking__meta">Booked by {r.organiser.fullName}</p>
                  ) : null}
                  {r.status === 'CANCELLED' && r.cancellationReason ? (
                    <p className="booking__note">Cancelled: {r.cancellationReason}</p>
                  ) : null}
                </div>

                <div className="booking__side">
                  <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Badge>
                  <span className="mono booking__ref">{r.reference}</span>
                  {r.canManage && r.status !== 'CANCELLED' && period === 'upcoming' ? (
                    <button
                      type="button" className="btn btn--ghost btn--sm"
                      onClick={() => setCancelling(r)}
                    >
                      <Icon name="minus" size={14} /> <span className="btn__label">Cancel</span>
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
