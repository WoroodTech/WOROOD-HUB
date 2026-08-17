import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError, type Reservation, type RoomAvailability } from '../lib/api';
import { Card, Empty, Modal, Spinner, StatusBadge } from '../components/ui';
import { useAuth } from '../lib/auth';
import { formatDate, formatDuration, formatLongDate, formatRange, formatTime, todayIso } from '../lib/format';

type Period = 'upcoming' | 'past';

export default function ReservationsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<Period>('upcoming');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [cancelling, setCancelling] = useState<Reservation | null>(null);
  const [modifying, setModifying] = useState<Reservation | null>(null);

  const canSeeAll = can('meeting-rooms.reservation.read_all', 'meeting-rooms.reservation.manage_all');

  const { data, isLoading, error } = useQuery({
    queryKey: ['reservations', scope, period],
    queryFn: () =>
      api<{ data: Reservation[]; meta: { total: number } }>(
        `/meeting-rooms/reservations?scope=${scope}&period=${period}&limit=100`,
      ),
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['reservations'] });
    queryClient.invalidateQueries({ queryKey: ['availability'] });
    queryClient.invalidateQueries({ queryKey: ['next-meeting'] });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reservations</h1>
          <p className="page-sub">Your upcoming and previous room bookings.</p>
        </div>
        {canSeeAll && (
          <select style={{ maxWidth: 220 }} value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')}>
            <option value="mine">My reservations</option>
            <option value="all">All employees</option>
          </select>
        )}
      </div>

      <Card tight>
        <div className="tabs" style={{ margin: '-12px -16px 0' , padding: '0 16px' }}>
          <button className={`tab${period === 'upcoming' ? ' active' : ''}`} onClick={() => setPeriod('upcoming')}>
            Upcoming
          </button>
          <button className={`tab${period === 'past' ? ' active' : ''}`} onClick={() => setPeriod('past')}>
            Previous
          </button>
        </div>

        {isLoading ? (
          <Spinner />
        ) : error ? (
          <Empty>{(error as Error).message}</Empty>
        ) : !data?.data.length ? (
          <Empty>
            {period === 'upcoming'
              ? 'No upcoming reservations. Head to “Book a Room” to reserve one.'
              : 'No previous reservations yet.'}
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Meeting</th>
                <th>Room</th>
                <th>Date</th>
                <th>Time</th>
                {scope === 'all' && <th>Organizer</th>}
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((reservation) => (
                <tr key={reservation.id}>
                  <td>
                    <div className="strong">{reservation.title}</div>
                    <div className="muted">{reservation.reference}</div>
                  </td>
                  <td>
                    {reservation.room.name}
                    <div className="muted">{reservation.room.code}</div>
                  </td>
                  <td>{formatDate(reservation.startsAt)}</td>
                  <td>
                    {formatRange(reservation.startsAt, reservation.endsAt)}
                    <div className="muted">{formatDuration(reservation.durationMinutes)}</div>
                  </td>
                  {scope === 'all' && <td>{reservation.organizer.fullName}</td>}
                  <td>
                    <StatusBadge status={reservation.status} />
                    {reservation.cancellationReason && (
                      <div className="muted">{reservation.cancellationReason}</div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {reservation.canModify ? (
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setModifying(reservation)}>
                          Modify
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => setCancelling(reservation)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {cancelling && (
        <CancelModal
          reservation={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => {
            setCancelling(null);
            refresh();
          }}
        />
      )}

      {modifying && (
        <ModifyModal
          reservation={modifying}
          onClose={() => setModifying(null)}
          onDone={() => {
            setModifying(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------------ */

function CancelModal({
  reservation,
  onClose,
  onDone,
}: {
  reservation: Reservation;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      api(`/meeting-rooms/reservations/${reservation.id}/cancel`, {
        method: 'POST',
        body: { reason: reason || undefined },
      }),
    onSuccess: onDone,
  });

  return (
    <Modal
      title="Cancel reservation"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Keep it
          </button>
          <button className="btn btn-danger" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'Cancelling…' : 'Cancel reservation'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>
          <strong>{reservation.title}</strong> in {reservation.room.name} on{' '}
          {formatLongDate(reservation.startsAt)} at {formatTime(reservation.startsAt)}.
        </p>
        <p className="muted">The slot becomes available to other employees immediately.</p>
        {mutation.isError && <div className="alert alert-bad">{(mutation.error as Error).message}</div>}
        <label className="field">
          Reason (optional)
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Meeting postponed" />
        </label>
      </div>
    </Modal>
  );
}

function ModifyModal({
  reservation,
  onClose,
  onDone,
}: {
  reservation: Reservation;
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(reservation.title);
  const [date, setDate] = useState(reservation.startsAt.slice(0, 10));
  const [duration, setDuration] = useState(reservation.durationMinutes);
  const [slot, setSlot] = useState<string | null>(reservation.startsAt);

  const { data: schedule, isFetching } = useQuery({
    queryKey: ['room-schedule', reservation.room.id, date, duration],
    queryFn: () =>
      api<{ data: RoomAvailability }>(
        `/meeting-rooms/rooms/${reservation.room.id}/schedule?date=${date}`,
      ).then((r) => r.data),
  });

  const mutation = useMutation({
    mutationFn: () =>
      api(`/meeting-rooms/reservations/${reservation.id}`, {
        method: 'PATCH',
        body: {
          title,
          startsAt: slot,
          endsAt: new Date(new Date(slot!).getTime() + duration * 60_000).toISOString(),
        },
      }),
    onSuccess: onDone,
  });

  const conflict = (mutation.error as ApiError | null)?.payload?.conflict;

  // The room's own booking still occupies the timeline, so offer it back as a
  // valid choice alongside the free slots.
  const options = [
    ...(date === reservation.startsAt.slice(0, 10) ? [reservation.startsAt] : []),
    ...(schedule?.freeSlots.map((s) => s.startsAt) ?? []),
  ].filter((value, index, all) => all.indexOf(value) === index);

  return (
    <Modal
      title="Modify reservation"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Discard
          </button>
          <button
            className="btn btn-primary"
            disabled={!slot || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="alert alert-info">
          {reservation.room.name} · currently {formatLongDate(reservation.startsAt)} at{' '}
          {formatTime(reservation.startsAt)}
        </div>

        {mutation.isError && (
          <div className="alert alert-bad">
            {(mutation.error as Error).message}
            {conflict && (
              <div style={{ marginTop: 6, fontSize: 12.5 }}>
                Clashes with <strong>{conflict.title}</strong> ({conflict.reference})
              </div>
            )}
          </div>
        )}

        <label className="field">
          Meeting title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <div className="row" style={{ gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            Date
            <input type="date" min={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Duration
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {[30, 45, 60, 90, 120, 180].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {formatDuration(minutes)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <div className="muted" style={{ marginBottom: 6 }}>New start time</div>
          {isFetching ? (
            <Spinner />
          ) : options.length === 0 ? (
            <p className="muted">No free slots on that date for this room.</p>
          ) : (
            <div className="slot-row">
              {options.map((iso) => (
                <button
                  key={iso}
                  className={`slot${slot === iso ? ' selected' : ''}`}
                  onClick={() => setSlot(iso)}
                >
                  {formatTime(iso)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
