/**
 * Book a room.
 *
 * The screen is arranged around the question people actually ask, which is
 * "where can eight of us sit for an hour on Tuesday" -- not "show me the rooms
 * and let me cross-reference their calendars". So the filters come first, the
 * answer is a list of rooms each showing the times it can offer, and picking a
 * time opens the confirmation rather than navigating away.
 *
 * A slot list is an offer, not a reservation. Someone else can take a time
 * between it rendering and you clicking it, and the API says so plainly when
 * that happens -- the error is shown against the room it belongs to and the
 * list refreshes, rather than a generic failure that leaves you guessing.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AvailabilityResponse, MeetingLocation, MeetingRoomEquipment, Reservation, RoomAvailability,
} from '../contract';
import { api, ApiError } from '../lib/api';
import { qk } from '../lib/keys';
import { useToast } from '../lib/toast';
import { Badge, Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { CAIRO, formatTime, formatWeekday } from '../lib/format';

/** Durations people actually book, rather than a free-text minutes box. */
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];

/* The date input works in calendar days, and the calendar day that matters is
   Cairo's -- at 01:00 in Cairo a browser set to London is still on yesterday,
   and would offer a day the API has already closed. `en-CA` is used only
   because it formats as YYYY-MM-DD, which is what <input type="date"> wants. */
const cairoDay = (offsetDays = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CAIRO, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
};

const today = () => cairoDay();

export function BookRoom() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [date, setDate] = useState(today);
  const [durationMinutes, setDuration] = useState(60);
  const [minCapacity, setMinCapacity] = useState<number | ''>('');
  const [locationId, setLocationId] = useState('');
  const [equipment, setEquipment] = useState<string[]>([]);
  const [chosen, setChosen] = useState<{ room: RoomAvailability['room']; startsAt: string; endsAt: string } | null>(null);

  const locations = useQuery({
    queryKey: qk.roomLocations,
    queryFn: () => api<{ locations: MeetingLocation[] }>('/meeting-rooms/locations'),
    staleTime: 30 * 60 * 1000,
  });

  const catalogue = useQuery({
    queryKey: qk.roomEquipment,
    queryFn: () => api<{ equipment: MeetingRoomEquipment[] }>('/meeting-rooms/equipment'),
    staleTime: 30 * 60 * 1000,
  });

  const params = useMemo(() => {
    const p = new URLSearchParams({ date, durationMinutes: String(durationMinutes) });
    if (minCapacity) p.set('minCapacity', String(minCapacity));
    if (locationId) p.set('locationId', locationId);
    if (equipment.length) p.set('equipment', equipment.join(','));
    return p.toString();
  }, [date, durationMinutes, minCapacity, locationId, equipment]);

  const availability = useQuery({
    queryKey: qk.availability(params),
    queryFn: () => api<AvailabilityResponse>(`/meeting-rooms/availability?${params}`),
    // Slots go stale quickly by nature: somebody else is booking too.
    staleTime: 20 * 1000,
  });

  const book = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Reservation>('/meeting-rooms/reservations', { method: 'POST', body }),
    onSuccess: (reservation) => {
      setChosen(null);
      toast.push(
        reservation.status === 'PENDING'
          ? `Requested — ${reservation.reference} is waiting for approval.`
          : `Booked — ${reservation.reference}.`,
        'good',
      );
      void queryClient.invalidateQueries({ queryKey: ['mr'] });
      void queryClient.invalidateQueries({ queryKey: ['portlet'] });
      navigate('/meeting-rooms/reservations');
    },
  });

  const rooms = availability.data?.rooms ?? [];
  const withSlots = rooms.filter((r) => r.slots.length);
  const withoutSlots = rooms.filter((r) => !r.slots.length);

  // The furthest any room allows; individual rooms may allow less and say so.
  const horizon = cairoDay(90);

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Book a room</h1>
          <p className="pagehead__sub">
            Times are Cairo local. A room only appears here if it can take the whole
            booking without touching an existing one.
          </p>
        </div>
      </header>

      <Card title="What do you need?" subtitle="Narrow it down, then pick a time">
        <div className="bookfilters">
          <label className="field">
            <span className="field__label">Day</span>
            <input
              className="input" type="date" value={date} min={today()} max={horizon}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">For how long</span>
            <select className="select" value={durationMinutes}
                    onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((m) => (
                <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h${m % 60 ? ` ${m % 60} min` : ''}`}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">People <span className="field__opt">optional</span></span>
            <input
              className="input" type="number" min={1} max={1000} placeholder="Any"
              value={minCapacity}
              onChange={(e) => setMinCapacity(e.target.value ? Number(e.target.value) : '')}
            />
          </label>

          <label className="field">
            <span className="field__label">Where</span>
            <select className="select" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Anywhere</option>
              {locations.data?.locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}{l.building ? ` — ${l.building}` : ''}</option>
              ))}
            </select>
          </label>
        </div>

        {catalogue.data?.equipment.length ? (
          <div className="equipfilter">
            <span className="equipfilter__label">Must have</span>
            <div className="chiplist">
              {catalogue.data.equipment.map((e) => {
                const on = equipment.includes(e.key);
                return (
                  <button
                    key={e.key} type="button" aria-pressed={on}
                    className={`chipbtn${on ? ' chipbtn--on' : ''}`}
                    onClick={() => setEquipment((prev) =>
                      prev.includes(e.key) ? prev.filter((k) => k !== e.key) : [...prev, e.key])}
                  >
                    {on ? <Icon name="check" size={13} /> : null}
                    {e.name}
                  </button>
                );
              })}
            </div>
            {equipment.length ? (
              <button type="button" className="link" onClick={() => setEquipment([])}>Clear</button>
            ) : null}
          </div>
        ) : null}
      </Card>

      {availability.isPending ? <LoadingState label="Finding rooms" lines={5} /> : null}
      {availability.error ? <ErrorState error={availability.error} onRetry={() => void availability.refetch()} /> : null}

      {availability.data && !rooms.length ? (
        <Card title="Nothing matches" tone="quiet">
          <EmptyState
            icon="search" title="No room fits those requirements"
            hint="Try fewer fittings, a smaller headcount, or another location."
          />
        </Card>
      ) : null}

      {withSlots.map((entry) => (
        <RoomOffer
          key={entry.room.id} entry={entry} date={date}
          onPick={(startsAt, endsAt) => setChosen({ room: entry.room, startsAt, endsAt })}
        />
      ))}

      {withoutSlots.length ? (
        <Card title="Not available" subtitle={`${withoutSlots.length} room${withoutSlots.length === 1 ? '' : 's'} matched, but can’t take this booking`} tone="quiet">
          <ul className="unavailable">
            {withoutSlots.map(({ room, note }) => (
              <li key={room.id} className="unavailable__row">
                <span className="unavailable__name">
                  {room.name}
                  <span className="unavailable__meta">
                    {room.floor ? `Floor ${room.floor} · ` : ''}{room.capacity} seats
                  </span>
                </span>
                <span className="unavailable__why">{note ?? 'Fully booked.'}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {chosen ? (
        <ConfirmBooking
          room={chosen.room} startsAt={chosen.startsAt} endsAt={chosen.endsAt}
          busy={book.isPending} error={book.error}
          onCancel={() => { book.reset(); setChosen(null); }}
          onConfirm={(body) => book.mutate({ roomId: chosen.room.id, startsAt: chosen.startsAt, endsAt: chosen.endsAt, ...body })}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------- one room's day -- */

function RoomOffer({ entry, date, onPick }: {
  entry: RoomAvailability;
  date: string;
  onPick: (startsAt: string, endsAt: string) => void;
}) {
  const { room, slots } = entry;
  const [expanded, setExpanded] = useState(false);
  /* Twelve is about a screen's worth. Beyond that the grid stops being
     scannable and starts being a wall, so the rest is behind one click. */
  const shown = expanded ? slots : slots.slice(0, 12);

  return (
    <Card
      title={room.name}
      subtitle={
        <>
          {room.floor ? `Floor ${room.floor} · ` : ''}{room.capacity} seats · {room.location.name}
          {room.bufferMinutes ? ` · ${room.bufferMinutes} min changeover` : ''}
        </>
      }
      actions={
        <span className="card__actionrow">
          {room.requiresApproval ? <Badge tone="warning" icon="clock">needs approval</Badge> : null}
          <Badge tone="good" icon="check">{slots.length} time{slots.length === 1 ? '' : 's'}</Badge>
        </span>
      }
      footer={room.description ? <span className="muted">{room.description}</span> : undefined}
    >
      {room.equipment.length ? (
        <ul className="equiprow">
          {room.equipment.map((e) => (
            <li className="idtag" key={e.key}><Icon name="check" size={12} /> {e.name}</li>
          ))}
        </ul>
      ) : null}

      <p className="slotday">{formatWeekday(`${date}T12:00:00`)}</p>

      <div className="slots">
        {shown.map((s) => (
          <button
            key={s.startsAt} type="button" className="slot"
            onClick={() => onPick(s.startsAt, s.endsAt)}
          >
            <span className="slot__start">{formatTime(s.startsAt)}</span>
            <span className="slot__end">to {formatTime(s.endsAt)}</span>
          </button>
        ))}
      </div>

      {slots.length > 12 ? (
        <button type="button" className="link" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show all ${slots.length} times`}
          <Icon name={expanded ? 'up' : 'down'} size={14} />
        </button>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------- confirm -- */

function ConfirmBooking({ room, startsAt, endsAt, busy, error, onCancel, onConfirm }: {
  room: RoomAvailability['room'];
  startsAt: string; endsAt: string;
  busy: boolean; error: unknown;
  onCancel: () => void;
  onConfirm: (body: { title: string; description?: string; attendeeCount: number }) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [attendeeCount, setAttendeeCount] = useState(2);

  const tooMany = attendeeCount > room.capacity;
  const conflict = error instanceof ApiError && error.status === 409;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onCancel} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 id="confirm-title" className="modal__title">Confirm booking</h2>
          <button type="button" className="iconbtn" onClick={onCancel} aria-label="Close">
            <Icon name="minus" size={15} />
          </button>
        </header>

        <div className="modal__body">
          <dl className="factlist">
            <div><dt>Room</dt><dd>{room.name}{room.floor ? `, floor ${room.floor}` : ''}</dd></div>
            <div><dt>When</dt><dd>{formatWeekday(startsAt)}, {formatTime(startsAt)} – {formatTime(endsAt)}</dd></div>
            <div><dt>Seats</dt><dd>{room.capacity}</dd></div>
          </dl>

          <label className="field">
            <span className="field__label">What is it for</span>
            <input
              className="input" value={title} autoFocus maxLength={190}
              placeholder="e.g. Autumn range review"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">How many attending</span>
            <input
              className="input" type="number" min={1} max={room.capacity} value={attendeeCount}
              onChange={(e) => setAttendeeCount(Number(e.target.value) || 1)}
            />
            {tooMany ? (
              <span className="field__error">{room.name} seats {room.capacity}.</span>
            ) : null}
          </label>

          <label className="field">
            <span className="field__label">Notes <span className="field__opt">optional</span></span>
            <textarea
              className="input" rows={2} maxLength={2000} value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          {room.requiresApproval ? (
            <p className="notice">
              <Icon name="info" size={15} />
              <span>This room is held for approval. The slot is reserved for you in the meantime.</span>
            </p>
          ) : null}

          {error ? (
            <p className={`notice notice--${conflict ? 'warn' : 'error'}`}>
              <Icon name="warning" size={15} />
              <span>{error instanceof Error ? error.message : 'Could not complete the booking.'}</span>
            </p>
          ) : null}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          <button
            type="button" className="btn btn--primary"
            disabled={busy || title.trim().length < 3 || tooMany}
            onClick={() => onConfirm({
              title: title.trim(),
              description: description.trim() || undefined,
              attendeeCount,
            })}
          >
            {busy ? 'Booking…' : room.requiresApproval ? 'Request room' : 'Book room'}
          </button>
        </footer>
      </div>
    </div>
  );
}
