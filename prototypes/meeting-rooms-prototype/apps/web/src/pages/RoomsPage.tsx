import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Room, type RoomAvailability } from '../lib/api';
import { Card, DayTimeline, Empty, Modal, Spinner, StatusBadge } from '../components/ui';
import { formatDuration, formatTime, todayIso } from '../lib/format';

export default function RoomsPage() {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Room | null>(null);

  const { data: rooms, isLoading } = useQuery({
    queryKey: ['rooms', 'all'],
    queryFn: () => api<{ data: Room[] }>('/meeting-rooms/rooms?status=ALL').then((r) => r.data),
  });

  const filtered =
    rooms?.filter((room) =>
      `${room.name} ${room.code} ${room.location.name} ${room.floor ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];

  const grouped = filtered.reduce<Record<string, Room[]>>((accumulator, room) => {
    (accumulator[room.location.name] ??= []).push(room);
    return accumulator;
  }, {});

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Meeting rooms</h1>
          <p className="page-sub">
            Every room across Worood offices, with capacity, location and available equipment.
          </p>
        </div>
        <input
          style={{ maxWidth: 260 }}
          placeholder="Search rooms…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <Card>
          <Spinner />
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <Empty>No rooms match that search.</Empty>
        </Card>
      ) : (
        <div className="stack" style={{ gap: 22 }}>
          {Object.entries(grouped).map(([location, locationRooms]) => (
            <div key={location}>
              <div className="row-between" style={{ marginBottom: 10 }}>
                <h2>{location}</h2>
                <span className="muted">{locationRooms.length} room(s)</span>
              </div>
              <div className="room-grid">
                {locationRooms.map((room) => (
                  <div key={room.id} className="room-card">
                    <div className="row-between">
                      <div>
                        <h3>{room.name}</h3>
                        <div className="muted">
                          {room.code}
                          {room.nameAr ? ` · ${room.nameAr}` : ''}
                        </div>
                      </div>
                      <StatusBadge status={room.status} />
                    </div>

                    {room.description && <p className="muted">{room.description}</p>}

                    <div className="room-meta">
                      <span>
                        <strong>{room.capacity}</strong> seats
                      </span>
                      {room.floor && <span>{room.floor}</span>}
                      <span>
                        {room.openingTime}–{room.closingTime}
                      </span>
                    </div>

                    {room.equipment.length > 0 ? (
                      <div className="chip-row">
                        {room.equipment.map((item) => (
                          <span key={item.key} className="chip">
                            {item.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="muted">No equipment listed</div>
                    )}

                    <div className="row" style={{ gap: 8, marginTop: 'auto' }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelected(room)}>
                        Today's schedule
                      </button>
                      {room.bufferMinutes > 0 && (
                        <span className="muted">{room.bufferMinutes} min changeover</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && <ScheduleModal room={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function ScheduleModal({ room, onClose }: { room: Room; onClose: () => void }) {
  const [date, setDate] = useState(todayIso());

  const { data, isLoading } = useQuery({
    queryKey: ['room-schedule', room.id, date],
    queryFn: () =>
      api<{ data: RoomAvailability }>(`/meeting-rooms/rooms/${room.id}/schedule?date=${date}`).then(
        (r) => r.data,
      ),
  });

  return (
    <Modal title={`${room.name} — schedule`} onClose={onClose}>
      <div className="stack">
        <label className="field" style={{ maxWidth: 200 }}>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>

        {isLoading || !data ? (
          <Spinner />
        ) : (
          <>
            <DayTimeline from={data.bookableFrom} to={data.bookableTo} busy={data.busy} />

            <div>
              <h3 style={{ marginBottom: 6 }}>Booked</h3>
              {data.busy.length === 0 ? (
                <p className="muted">Nothing booked — the room is free all day.</p>
              ) : (
                <div className="stack" style={{ gap: 6 }}>
                  {data.busy.map((block, index) => (
                    <div key={index} className="row-between">
                      <span>{block.title}</span>
                      <span className="muted">
                        {formatTime(block.startsAt)} – {formatTime(block.endsAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 style={{ marginBottom: 6 }}>
                Free slots ({formatDuration(room.minDurationMinutes)} each)
              </h3>
              {data.freeSlots.length === 0 ? (
                <p className="muted">No remaining slots today.</p>
              ) : (
                <div className="slot-row">
                  {data.freeSlots.map((slot) => (
                    <span key={slot.startsAt} className="slot" style={{ cursor: 'default' }}>
                      {formatTime(slot.startsAt)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
