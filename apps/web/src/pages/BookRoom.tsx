/**
 * Book a room.
 *
 * The screen asks the question people actually arrive with: "can I have a room
 * at 10:20 for twenty minutes?" -- a time and a length, not a browse through
 * whatever start times each room was configured to offer.
 *
 * That reversal is the whole change. Rooms used to publish a slot grid and a
 * minimum booking, so a twenty-minute conversation was refused by a room whose
 * owner had set thirty, and the employee's real question was answered only
 * indirectly, by scanning lists. Now they name the window and every room
 * answers yes or no to it.
 *
 * A "no" is never the end of the response. When the room they asked for is
 * taken, two things come back with the refusal: the other rooms free at that
 * exact time, and the same room's own next opening. Both are one click, so a
 * refusal is a choice rather than a trip back to the form.
 *
 * The offer is still not a promise. Someone can take the window between this
 * answer and the confirm, and the 409 is shown as itself rather than as a
 * generic failure.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AvailabilityResponse, DirectoryPerson, MeetingLocation, MeetingRoom,
  MeetingRoomEquipment, Reservation, RoomAvailability,
} from '../contract';
import { api, ApiError } from '../lib/api';
import { qk } from '../lib/keys';
import { useToast } from '../lib/toast';
import { Badge, Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { AttendeePicker } from '../components/AttendeePicker';
import { CAIRO, formatTime, formatWeekday } from '../lib/format';
import { RoomCalendar } from '../components/RoomCalendar';

/** Mirrors BOOKING_LIMITS on the API. The floor rules out a mis-typed booking
 *  of a minute or two; the ceiling stops a room being held for a whole day.
 *  STEP is what the picker moves by -- the API accepts any minute, so a time
 *  pasted or typed off the step is still a legitimate request. */
const LIMITS = { MIN: 10, MAX: 480, STEP: 5 } as const;

/** Lengths worth one tap. Anything else goes in the box beside them, which is
 *  why the list can stay short rather than trying to anticipate everyone. */
const QUICK_DURATIONS = [15, 20, 30, 45, 60, 90, 120];

/* "taken" for a real clash, "changeover" for a buffer. The room is empty in
   the second case, and calling both the same thing is what sends someone
   hunting for the meeting that is in their way when there isn't one. */
const BLOCK_LABEL: Record<string, string> = {
  BOOKING: 'taken',
  BUFFER: 'changeover',
  BLACKOUT: 'unavailable',
};

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

/** Now, in Cairo, rounded up to the next step -- the sensible default start. */
const nextStepTime = (): string => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CAIRO, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 9);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const rounded = Math.ceil((h * 60 + m) / LIMITS.STEP) * LIMITS.STEP;
  const capped = Math.min(rounded, 23 * 60 + 55);
  return `${String(Math.floor(capped / 60)).padStart(2, '0')}:${String(capped % 60).padStart(2, '0')}`;
};

/** "HH:mm" from an ISO instant, read in Cairo -- for putting a suggested time
 *  back into the form, where the input wants wall-clock rather than an
 *  instant. */
const timeOf = (iso: string): string => new Intl.DateTimeFormat('en-GB', {
  timeZone: CAIRO, hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso));

export function BookRoom() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [date, setDate] = useState(cairoDay);
  const [startTime, setStartTime] = useState(nextStepTime);
  const [durationMinutes, setDuration] = useState(60);
  const [minCapacity, setMinCapacity] = useState<number | ''>('');
  const [locationId, setLocationId] = useState('');
  const [equipment, setEquipment] = useState<string[]>([]);
  const [roomId, setRoomId] = useState('');
  const [chosen, setChosen] = useState<{ room: MeetingRoom; startsAt: string; endsAt: string } | null>(null);

  const roomsCatalogue = useQuery({
    queryKey: qk.rooms(''),
    queryFn: () => api<{ rooms: MeetingRoom[] }>('/meeting-rooms/rooms'),
    staleTime: 30 * 60 * 1000,
  });

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
    const p = new URLSearchParams({
      date, startTime, durationMinutes: String(durationMinutes),
    });
    if (minCapacity) p.set('minCapacity', String(minCapacity));
    if (locationId) p.set('locationId', locationId);
    if (equipment.length) p.set('equipment', equipment.join(','));
    if (roomId) p.set('roomId', roomId);
    return p.toString();
  }, [date, startTime, durationMinutes, minCapacity, locationId, equipment, roomId]);

  const durationValid = durationMinutes >= LIMITS.MIN && durationMinutes <= LIMITS.MAX;

  const availability = useQuery({
    queryKey: qk.availability(params),
    queryFn: () => api<AvailabilityResponse>(`/meeting-rooms/availability?${params}`),
    // The answer goes stale quickly by nature: somebody else is booking too.
    staleTime: 20 * 1000,
    enabled: durationValid,
  });

  const book = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Reservation>('/meeting-rooms/reservations', { method: 'POST', body }),
    onSuccess: (reservation) => {
      setChosen(null);
      const invited = reservation.attendees.length;
      const told = invited
        ? ` ${invited} ${invited === 1 ? 'colleague was' : 'colleagues were'} invited.`
        : '';
      toast.push(
        reservation.status === 'PENDING'
          ? `Requested — ${reservation.reference} is waiting for approval.${told}`
          : `Booked — ${reservation.reference}.${told}`,
        'good',
      );
      void queryClient.invalidateQueries({ queryKey: ['mr'] });
      void queryClient.invalidateQueries({ queryKey: ['portlet'] });
      navigate('/meeting-rooms/reservations');
    },
  });

  /** Take a suggested time back into the form. The whole answer re-runs against
   *  it, so the employee sees the same yes/no they would have got by typing it
   *  -- rather than the suggestion being trusted and then refused on confirm. */
  const useSuggestion = (iso: string) => {
    setStartTime(timeOf(iso));
    setDate(new Intl.DateTimeFormat('en-CA', { timeZone: CAIRO }).format(new Date(iso)));
  };

  const data = availability.data;
  const requested = data?.requested;
  const alternatives = data?.alternatives ?? [];
  const unavailable = data?.unavailable ?? [];

  /* The furthest any room in the catalogue allows, rather than a hard-coded 90.
     The horizon is per-room policy and editable from the admin screen, so
     assuming the default would silently put an edited room out of reach. */
  const horizon = cairoDay(
    Math.max(90, ...(roomsCatalogue.data?.rooms ?? []).map((r) => r.maxAdvanceDays)),
  );

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Book a room</h1>
          <p className="pagehead__sub">
            Times are Cairo local. Pick when and how long — any room that can take
            it will say so.
          </p>
        </div>
      </header>

      <Card title="When do you need it?" subtitle="A time, a length, and anything the room must have">
        <div className="bookfilters">
          <label className="field">
            <span className="field__label">Day</span>
            <input
              className="input" type="date" value={date} min={cairoDay()} max={horizon}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">Starting at</span>
            <input
              className="input mono" type="time" value={startTime}
              step={LIMITS.STEP * 60}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field__label">
              For <span className="field__opt">minutes</span>
            </span>
            <input
              className="input" type="number"
              min={LIMITS.MIN} max={LIMITS.MAX} step={LIMITS.STEP}
              value={durationMinutes}
              onChange={(e) => setDuration(Number(e.target.value) || 0)}
            />
            {!durationValid ? (
              <span className="field__error">
                Between {LIMITS.MIN} minutes and {LIMITS.MAX / 60} hours.
              </span>
            ) : null}
          </label>

          <label className="field">
            <span className="field__label">Room <span className="field__opt">optional</span></span>
            <select className="select" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">Any room</option>
              {roomsCatalogue.data?.rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
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

        <div className="quickdurations">
          <span className="equipfilter__label">Common lengths</span>
          <div className="chiplist">
            {QUICK_DURATIONS.map((m) => (
              <button
                key={m} type="button" aria-pressed={durationMinutes === m}
                className={`chipbtn${durationMinutes === m ? ' chipbtn--on' : ''}`}
                onClick={() => setDuration(m)}
              >
                {m < 60 ? `${m} min` : `${m / 60} h${m % 60 ? ` ${m % 60}` : ''}`}
              </button>
            ))}
          </div>
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

      {availability.isPending && durationValid ? <LoadingState label="Checking rooms" lines={4} /> : null}
      {availability.error ? (
        <ErrorState error={availability.error} onRetry={() => void availability.refetch()} />
      ) : null}

      {/* The named room's answer comes first and on its own, because it is the
          question that was asked. Everything below it is a suggestion. */}
      {data && requested ? (
        <RequestedAnswer
          entry={requested} date={date} window={{ startsAt: data.startsAt, endsAt: data.endsAt }}
          onBook={() => setChosen({ room: requested.room, startsAt: data.startsAt, endsAt: data.endsAt })}
          onUseSuggestion={useSuggestion}
        />
      ) : null}

      {data && alternatives.length ? (
        <Card
          title={requested ? 'Free at that time instead' : 'Free then'}
          subtitle={`${alternatives.length} room${alternatives.length === 1 ? '' : 's'} · ${formatWeekday(data.startsAt)}, ${formatTime(data.startsAt)}–${formatTime(data.endsAt)}`}
        >
          <ul className="roomoffers">
            {alternatives.map((entry) => (
              <FreeRoomRow
                key={entry.room.id} entry={entry} date={date}
                onBook={() => setChosen({ room: entry.room, startsAt: data.startsAt, endsAt: data.endsAt })}
              />
            ))}
          </ul>
        </Card>
      ) : null}

      {data && !requested && !alternatives.length ? (
        <Card title="Nothing free then" tone="quiet">
          <EmptyState
            icon="search"
            title="No room can take that window"
            hint="Try a different time, a shorter meeting, or fewer requirements."
          />
        </Card>
      ) : null}

      {/* Rooms that matched the filters and cannot take it, with the reason and
          their own next opening. Kept visible: hiding them invites "why isn't
          Lotus in the list?", and each one carries a usable alternative time. */}
      {data && unavailable.length ? (
        <Card
          title="Not available"
          subtitle={`${unavailable.length} room${unavailable.length === 1 ? '' : 's'} matched but can’t take this window`}
          tone="quiet"
        >
          <ul className="unavailable">
            {unavailable.map((entry) => (
              <li key={entry.room.id} className="unavailable__row">
                <span className="unavailable__name">
                  {entry.room.name}
                  <span className="unavailable__meta">
                    {entry.room.floor ? `Floor ${entry.room.floor} · ` : ''}{entry.room.capacity} seats
                  </span>
                </span>
                <span className={`unavailable__why${entry.blockedBy === 'BUFFER' ? ' unavailable__why--soft' : ''}`}>
                  {entry.reason ?? 'Taken.'}
                  {entry.nextFree ? (
                    <button
                      type="button" className="link"
                      onClick={() => useSuggestion(entry.nextFree!.startsAt)}
                    >
                      Free at {formatTime(entry.nextFree.startsAt)}
                      <Icon name="right" size={13} />
                    </button>
                  ) : null}
                </span>
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
          onConfirm={(body) => book.mutate({
            roomId: chosen.room.id, startsAt: chosen.startsAt, endsAt: chosen.endsAt, ...body,
          })}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------- the room that was asked -- */

/**
 * The named room's answer. Yes is a button; no is a reason plus, when the room
 * has one later the same day, its own next opening.
 */
function RequestedAnswer({ entry, date, window, onBook, onUseSuggestion }: {
  entry: RoomAvailability;
  date: string;
  window: { startsAt: string; endsAt: string };
  onBook: () => void;
  onUseSuggestion: (iso: string) => void;
}) {
  const { room } = entry;
  const [showCalendar, setShowCalendar] = useState(false);

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
          <Badge tone={entry.available ? 'good' : 'warning'} icon={entry.available ? 'check' : 'clock'}>
            {entry.available ? 'free' : BLOCK_LABEL[entry.blockedBy ?? 'BOOKING']}
          </Badge>
          <button
            type="button" className="iconbtn" aria-label="Room calendar" aria-pressed={showCalendar}
            onClick={() => setShowCalendar((v) => !v)}
          >
            <Icon name="calendar" size={15} />
          </button>
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

      <p className="slotday">
        {formatWeekday(window.startsAt)},{' '}
        <span className="mono">{formatTime(window.startsAt)}–{formatTime(window.endsAt)}</span>
      </p>

      {entry.available ? (
        <button type="button" className="btn btn--primary" onClick={onBook}>
          {room.requiresApproval ? 'Request this room' : 'Book this room'}
        </button>
      ) : (
        <div className="answer answer--no">
          {/* A changeover is a lesser kind of no -- the room is empty, it is
              being reset. Saying it in the same red as a clash sends people
              looking for a meeting that is not there. */}
          <p className={`notice notice--${entry.blockedBy === 'BUFFER' ? 'info' : 'warn'}`}>
            <Icon name={entry.blockedBy === 'BUFFER' ? 'clock' : 'warning'} size={15} />
            <span>{entry.reason ?? `${room.name} is taken then.`}</span>
          </p>
          {entry.nextFree ? (
            <button
              type="button" className="btn btn--ghost"
              onClick={() => onUseSuggestion(entry.nextFree!.startsAt)}
            >
              <Icon name="clock" size={14} />
              {room.name} is free at{' '}
              <span className="mono">{formatTime(entry.nextFree.startsAt)}</span>
            </button>
          ) : (
            <p className="muted">Nothing else free in this room today.</p>
          )}
        </div>
      )}

      {showCalendar ? <RoomCalendar room={room} date={date} /> : null}
    </Card>
  );
}

/* ----------------------------------------------------------- alternatives -- */

function FreeRoomRow({ entry, date, onBook }: {
  entry: RoomAvailability;
  date: string;
  onBook: () => void;
}) {
  const { room } = entry;
  const [showCalendar, setShowCalendar] = useState(false);

  return (
    <li className="roomoffer">
      <div className="roomoffer__head">
        <span className="roomoffer__name">
          {room.name}
          <span className="roomoffer__meta">
            {room.floor ? `Floor ${room.floor} · ` : ''}{room.capacity} seats · {room.location.name}
          </span>
        </span>
        <span className="card__actionrow">
          {room.requiresApproval ? <Badge tone="warning" icon="clock">approval</Badge> : null}
          <button
            type="button" className="iconbtn" aria-label={`${room.name} calendar`}
            aria-pressed={showCalendar} onClick={() => setShowCalendar((v) => !v)}
          >
            <Icon name="calendar" size={15} />
          </button>
          <button type="button" className="btn btn--primary btn--sm" onClick={onBook}>
            {room.requiresApproval ? 'Request' : 'Book'}
          </button>
        </span>
      </div>

      {room.equipment.length ? (
        <ul className="equiprow">
          {room.equipment.map((e) => (
            <li className="idtag" key={e.key}><Icon name="check" size={12} /> {e.name}</li>
          ))}
        </ul>
      ) : null}

      {showCalendar ? <RoomCalendar room={room} date={date} /> : null}
    </li>
  );
}

/* ------------------------------------------------------------- confirm -- */

function ConfirmBooking({ room, startsAt, endsAt, busy, error, onCancel, onConfirm }: {
  room: MeetingRoom;
  startsAt: string; endsAt: string;
  busy: boolean; error: unknown;
  onCancel: () => void;
  onConfirm: (body: {
    title: string; description?: string; attendeeCount: number; attendeeUserIds: string[];
  }) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [guests, setGuests] = useState<DirectoryPerson[]>([]);
  /** Extra heads beyond the named guests -- people from outside the system, or
   *  colleagues joining without needing the invitation. */
  const [extra, setExtra] = useState(0);

  // The organiser, everyone named, and anyone counted but not named.
  const attendeeCount = 1 + guests.length + extra;
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
            <div>
              <dt>When</dt>
              <dd>
                {formatWeekday(startsAt)},{' '}
                <span className="mono">{formatTime(startsAt)} – {formatTime(endsAt)}</span>
              </dd>
            </div>
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

          <AttendeePicker value={guests} onChange={setGuests} capacity={room.capacity} />

          <label className="field">
            <span className="field__label">
              Anyone else <span className="field__opt">not on the system, or joining without an invitation</span>
            </span>
            <input
              className="input" type="number" min={0} max={Math.max(0, room.capacity - 1 - guests.length)}
              value={extra}
              onChange={(e) => setExtra(Math.max(0, Number(e.target.value) || 0))}
            />
            <span className={tooMany ? 'field__error' : 'field__opt'}>
              {tooMany
                ? `${attendeeCount} attending but ${room.name} seats ${room.capacity}.`
                : `${attendeeCount} attending in total.`}
            </span>
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
              attendeeUserIds: guests.map((g) => g.id),
            })}
          >
            {busy ? 'Booking…' : room.requiresApproval ? 'Request room' : 'Book room'}
          </button>
        </footer>
      </div>
    </div>
  );
}