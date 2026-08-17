import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type ApiError,
  type Room,
  type RoomAvailability,
} from '../lib/api';
import { Card, DayTimeline, Empty, ErrorNote, Modal, Spinner } from '../components/ui';
import { formatDuration, formatLongDate, formatTime, nowTimeIso, todayIso } from '../lib/format';

interface Location {
  id: string;
  name: string;
}
interface EquipmentItem {
  id: string;
  key: string;
  name: string;
}

const DURATIONS = [30, 45, 60, 90, 120, 180, 240];

/**
 * Open the search on the next slot an employee could realistically take:
 * the next half hour today, or tomorrow morning once the offices have closed.
 */
function nextSensibleSlot(): { date: string; time: string } {
  const [hours, minutes] = nowTimeIso().split(':').map(Number);
  const rounded = minutes + (30 - (minutes % 30));
  const hour = hours + Math.floor(rounded / 60);
  const minute = rounded % 60;

  if (hour >= 18) return { date: todayIso(1), time: '09:00' };
  if (hour < 8) return { date: todayIso(), time: '08:00' };

  const pad = (value: number) => String(value).padStart(2, '0');
  return { date: todayIso(), time: `${pad(hour)}:${pad(minute)}` };
}

export default function BookPage() {
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const [defaults] = useState(nextSensibleSlot);

  const [date, setDate] = useState(defaults.date);
  const [startTime, setStartTime] = useState(defaults.time);
  const [duration, setDuration] = useState(Number(params.get('duration')) || 60);
  const [minCapacity, setMinCapacity] = useState('');
  const [locationId, setLocationId] = useState('');
  const [equipment, setEquipment] = useState<string[]>([]);
  const [booking, setBooking] = useState<{ room: Room; startsAt: string } | null>(null);

  const { data: locations } = useQuery({
    queryKey: ['locations'],
    queryFn: () => api<{ data: Location[] }>('/meeting-rooms/locations').then((r) => r.data),
    staleTime: 10 * 60_000,
  });

  const { data: equipmentCatalogue } = useQuery({
    queryKey: ['equipment'],
    queryFn: () => api<{ data: EquipmentItem[] }>('/meeting-rooms/equipment').then((r) => r.data),
    staleTime: 10 * 60_000,
  });

  const queryString = useMemo(() => {
    const search = new URLSearchParams({
      date,
      durationMinutes: String(duration),
      startTime,
    });
    if (minCapacity) search.set('minCapacity', minCapacity);
    if (locationId) search.set('locationId', locationId);
    if (equipment.length) search.set('equipment', equipment.join(','));
    return search.toString();
  }, [date, duration, startTime, minCapacity, locationId, equipment]);

  const {
    data: results,
    isFetching,
    error,
  } = useQuery({
    queryKey: ['availability', queryString],
    queryFn: () =>
      api<{ data: RoomAvailability[] }>(`/meeting-rooms/availability?${queryString}`).then((r) => r.data),
  });

  const available = results?.filter((r) => r.availableForRequestedWindow) ?? [];
  const alternatives = results?.filter((r) => !r.availableForRequestedWindow && r.freeSlots.length > 0) ?? [];

  function toggleEquipment(key: string) {
    setEquipment((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  }

  function openBooking(room: Room, isoStart: string) {
    setBooking({ room, startsAt: isoStart });
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Book a room</h1>
          <p className="page-sub">
            Search by date, time, capacity and equipment. Only genuinely free rooms are offered.
          </p>
        </div>
      </div>

      <Card>
        <div className="filters">
          <label className="field">
            Date
            <input type="date" value={date} min={todayIso()} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            Start time
            <input type="time" step={900} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </label>
          <label className="field">
            Duration
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {formatDuration(minutes)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Minimum seats
            <input
              type="number"
              min={1}
              placeholder="Any"
              value={minCapacity}
              onChange={(e) => setMinCapacity(e.target.value)}
            />
          </label>
          <label className="field">
            Office
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All sites</option>
              {locations?.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ marginBottom: 6 }}>Required equipment</div>
          <div className="chip-row">
            {equipmentCatalogue?.map((item) => (
              <button
                key={item.key}
                className={`slot${equipment.includes(item.key) ? ' selected' : ''}`}
                onClick={() => toggleEquipment(item.key)}
                type="button"
              >
                {item.name}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <div style={{ height: 18 }} />

      {error && <ErrorNote error={error} />}

      {isFetching ? (
        <Card>
          <Spinner label="Checking availability…" />
        </Card>
      ) : (
        <>
          <Card
            title={`Free at ${startTime} on ${formatLongDate(`${date}T12:00:00`)}`}
            action={<span className="badge badge-ok">{available.length} room(s)</span>}
          >
            {available.length === 0 ? (
              <Empty>
                No room matches that exact window. Try one of the alternative times below.
              </Empty>
            ) : (
              <div className="room-grid">
                {available.map((entry) => (
                  <AvailableRoomCard
                    key={entry.room.id}
                    entry={entry}
                    date={date}
                    startTime={startTime}
                    onBook={openBooking}
                  />
                ))}
              </div>
            )}
          </Card>

          {alternatives.length > 0 && (
            <>
              <div style={{ height: 18 }} />
              <Card title="Other rooms — pick a different time" tight>
                <div className="stack" style={{ gap: 16, paddingTop: 6 }}>
                  {alternatives.map((entry) => (
                    <div key={entry.room.id} className="stack" style={{ gap: 8 }}>
                      <div className="row-between">
                        <div>
                          <span className="strong">{entry.room.name}</span>
                          <span className="muted"> · {entry.room.capacity} seats · {entry.room.location.name}</span>
                        </div>
                        <span className="muted">{entry.freeSlots.length} free slot(s)</span>
                      </div>
                      <DayTimeline from={entry.bookableFrom} to={entry.bookableTo} busy={entry.busy} />
                      <div className="slot-row">
                        {entry.freeSlots.slice(0, 14).map((slot) => (
                          <button
                            key={slot.startsAt}
                            className="slot"
                            onClick={() => openBooking(entry.room, slot.startsAt)}
                          >
                            {formatTime(slot.startsAt)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}
        </>
      )}

      {booking && (
        <BookingModal
          room={booking.room}
          startsAt={booking.startsAt}
          durationMinutes={duration}
          onClose={() => setBooking(null)}
          onBooked={() => {
            setBooking(null);
            queryClient.invalidateQueries({ queryKey: ['availability'] });
            queryClient.invalidateQueries({ queryKey: ['reservations'] });
            queryClient.invalidateQueries({ queryKey: ['next-meeting'] });
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------------ */

function AvailableRoomCard({
  entry,
  date,
  startTime,
  onBook,
}: {
  entry: RoomAvailability;
  date: string;
  startTime: string;
  onBook: (room: Room, isoStart: string) => void;
}) {
  const requestedIso =
    entry.freeSlots.find((slot) => formatTime(slot.startsAt) === startTime)?.startsAt ??
    new Date(`${date}T${startTime}:00`).toISOString();

  return (
    <div className="room-card">
      <div className="row-between">
        <div>
          <h3>{entry.room.name}</h3>
          <div className="muted">{entry.room.code}</div>
        </div>
        <span className="badge badge-ok">Available</span>
      </div>

      <div className="room-meta">
        <span>{entry.room.capacity} seats</span>
        <span>{entry.room.location.name}</span>
        {entry.room.floor && <span>{entry.room.floor}</span>}
      </div>

      {entry.room.equipment.length > 0 && (
        <div className="chip-row">
          {entry.room.equipment.map((item) => (
            <span key={item.key} className="chip">
              {item.name}
            </span>
          ))}
        </div>
      )}

      <DayTimeline from={entry.bookableFrom} to={entry.bookableTo} busy={entry.busy} />

      <button className="btn btn-primary btn-sm" onClick={() => onBook(entry.room, requestedIso)}>
        Reserve {startTime}
      </button>
    </div>
  );
}

function BookingModal({
  room,
  startsAt,
  durationMinutes,
  onClose,
  onBooked,
}: {
  room: Room;
  startsAt: string;
  durationMinutes: number;
  onClose: () => void;
  onBooked: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [attendeeCount, setAttendeeCount] = useState(2);

  const endsAt = new Date(new Date(startsAt).getTime() + durationMinutes * 60_000).toISOString();

  const mutation = useMutation({
    mutationFn: () =>
      api('/meeting-rooms/reservations', {
        method: 'POST',
        body: { roomId: room.id, title, description: description || undefined, startsAt, endsAt, attendeeCount },
      }),
    onSuccess: onBooked,
  });

  const conflict = (mutation.error as ApiError | null)?.payload?.conflict;

  return (
    <Modal
      title={`Reserve ${room.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={title.trim().length < 3 || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? 'Reserving…' : 'Confirm reservation'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="alert alert-info">
          <strong>{formatLongDate(startsAt)}</strong>
          <br />
          {formatTime(startsAt)} – {formatTime(endsAt)} · {formatDuration(durationMinutes)} ·{' '}
          {room.location.name}
          {room.floor ? `, ${room.floor}` : ''}
        </div>

        {mutation.isError && (
          <div className="alert alert-bad">
            {(mutation.error as Error).message}
            {conflict && (
              <div style={{ marginTop: 6, fontSize: 12.5 }}>
                Conflicting booking: <strong>{conflict.title}</strong> ({conflict.reference})
              </div>
            )}
          </div>
        )}

        <label className="field">
          Meeting title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Q3 Budget Review"
            autoFocus
          />
        </label>

        <label className="field">
          Agenda / notes (optional)
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>

        <label className="field">
          Number of attendees (room seats {room.capacity})
          <input
            type="number"
            min={1}
            max={room.capacity}
            value={attendeeCount}
            onChange={(e) => setAttendeeCount(Number(e.target.value))}
          />
        </label>
      </div>
    </Modal>
  );
}
