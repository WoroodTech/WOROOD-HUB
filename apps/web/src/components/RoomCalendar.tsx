/**
 * A room's timeline for one day: bookings, changeover buffers, and
 * blackouts positioned by their real time. Anything not drawn is available
 * -- the server sends only what blocks the room, never the free stretches,
 * so this view can never show a time as open that the booking flow would
 * refuse.
 *
 * One thing the server's "blocked" concept deliberately does not include:
 * the passage of time itself. A slot before *now* is unbookable not because
 * anything is blocking the room but because it is in the past -- that is
 * AvailabilityService's `notBefore` filter, and it has no equivalent block
 * type here. Without marking it, an empty stretch before the current time
 * reads as "free to book" when it is not. The past-shading and now-line
 * below are exactly that marker: purely visual, computed once from the same
 * "now" AvailabilityService uses, and never merged into the blocking model.
 *
 * Open to anyone in the company, same as opening a single reservation
 * directly. The day is read in the room's own timezone.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RoomCalendarResponse, MeetingRoom } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { LoadingState, ErrorState, EmptyState } from './States';
import { Icon } from './Icon';
import { formatTime } from '../lib/format';

const hhmmToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function minutesInZone(iso: string, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** "What calendar day, and what minute of it, is it right now in the room's
 *  own zone" -- one read of the clock, reused for both the past-shading and
 *  the now-line so the two can never drift apart from each other. */
function nowInZone(zone: string): { day: string; minutes: number } {
  const now = new Date();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
  const minutes = minutesInZone(now.toISOString(), zone);
  return { day, minutes };
}

function shiftDay(iso: string, delta: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function RoomCalendar({ room, date }: { room: MeetingRoom; date: string }) {
  const [day, setDay] = useState(date);
  const zone = room.location.timezone;

  const calendar = useQuery({
    queryKey: qk.roomCalendar(room.id, day),
    queryFn: () => api<RoomCalendarResponse>(`/meeting-rooms/rooms/${room.id}/calendar?date=${day}`),
    staleTime: 30 * 1000,
  });

  // Ticks once a minute so the now-line and past-shading creep forward while
  // the calendar stays open, rather than freezing at whenever it was opened.
  const [now, setNow] = useState(() => nowInZone(zone));
  useEffect(() => {
    setNow(nowInZone(zone));
    const id = setInterval(() => setNow(nowInZone(zone)), 60_000);
    return () => clearInterval(id);
  }, [zone]);

  const openMin = hhmmToMinutes(room.opensAt);
  const closeMin = hhmmToMinutes(room.closesAt);
  const totalMin = Math.max(closeMin - openMin, 60);
  const hourMarks: number[] = [];
  for (let h = Math.ceil(openMin / 60); h <= Math.floor(closeMin / 60); h++) hourMarks.push(h * 60);

  const blocks = calendar.data?.blocks ?? [];

  // Where "now" falls relative to the viewed day: before it (whole day is
  // past), inside it (partial shading), or after it (nothing to shade).
  const dayRelation = day < now.day ? 'past' : day > now.day ? 'future' : 'today';
  const pastUntilMin = dayRelation === 'past' ? closeMin : dayRelation === 'today' ? now.minutes : openMin;
  const showPastShade = dayRelation !== 'future' && pastUntilMin > openMin;
  const pastTop = 0;
  const pastHeight = ((Math.min(pastUntilMin, closeMin) - openMin) / totalMin) * 100;
  const nowLineTop = dayRelation === 'today' && now.minutes >= openMin && now.minutes <= closeMin
    ? ((now.minutes - openMin) / totalMin) * 100
    : null;

  return (
    <div className="roomcal__wrap">
      <div className="roomcal__toolbar">
        <button type="button" className="iconbtn" aria-label="Previous day" onClick={() => setDay((d) => shiftDay(d, -1))}>
          <Icon name="left" size={15} />
        </button>
        <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        <button type="button" className="iconbtn" aria-label="Next day" onClick={() => setDay((d) => shiftDay(d, 1))}>
          <Icon name="right" size={15} />
        </button>
        <span className="roomcal__legend">
          <span className="roomcal__legenditem"><i className="roomcal__swatch roomcal__swatch--booked" /> Booked</span>
          <span className="roomcal__legenditem"><i className="roomcal__swatch roomcal__swatch--buffer" /> Buffer</span>
          <span className="roomcal__legenditem"><i className="roomcal__swatch roomcal__swatch--past" /> Past</span>
        </span>
      </div>

      {calendar.isPending ? <LoadingState label="Loading calendar" lines={3} /> : null}
      {calendar.error ? <ErrorState error={calendar.error} onRetry={() => void calendar.refetch()} /> : null}
      {calendar.data && !blocks.length && dayRelation === 'future' ? (
        <EmptyState icon="check" title="Nothing booked" hint={`${room.name} is free all day.`} />
      ) : null}

      {calendar.data ? (
        <div className="roomcal">
          <div className="roomcal__hours">
            {hourMarks.map((m) => (
              <span key={m} className="roomcal__hourlabel" style={{ top: `${((m - openMin) / totalMin) * 100}%` }}>
                {String(Math.floor(m / 60)).padStart(2, '0')}:00
              </span>
            ))}
          </div>

          <div className="roomcal__track">
            {hourMarks.map((m) => (
              <div key={m} className="roomcal__gridline" style={{ top: `${((m - openMin) / totalMin) * 100}%` }} />
            ))}

            {/* Past shading -- under everything else, purely informational.
                Not a block type: a booking or buffer drawn on top of it still
                reads as itself, this only marks "this stretch is behind us". */}
            {showPastShade ? (
              <div
                className="roomcal__pastshade"
                style={{ top: `${pastTop}%`, height: `${pastHeight}%` }}
                title="This time has already passed and can no longer be booked."
              />
            ) : null}

            {blocks.map((b, i) => {
              const start = Math.max(minutesInZone(b.startsAt, zone), openMin);
              const end = Math.min(minutesInZone(b.endsAt, zone), closeMin);
              if (end <= start) return null;
              const top = ((start - openMin) / totalMin) * 100;
              const height = Math.max(((end - start) / totalMin) * 100, 1.2);
              const style = { top: `${top}%`, height: `${height}%` };

              if (b.type === 'BUFFER') {
                return (
                  <div
                    key={`buffer-${i}`} className="roomcal__buffer" style={style}
                    title={`Room unavailable due to changeover buffer, ${formatTime(b.startsAt)}–${formatTime(b.endsAt)}.`}
                  />
                );
              }

              if (b.type === 'BLACKOUT') {
                return (
                  <div key={`blackout-${i}`} className="roomcal__blackout" style={style}
                    title={`${room.name} is unavailable${b.reason ? `: ${b.reason}` : '.'}`}>
                    <span className="roomcal__blocktitle">Unavailable</span>
                    {b.reason ? <span className="roomcal__blockmeta">{b.reason}</span> : null}
                  </div>
                );
              }

              return (
                <div
                  key={b.id}
                  className={`roomcal__block${b.status === 'PENDING' ? ' roomcal__block--pending' : ''}${b.isMine ? ' roomcal__block--mine' : ''}`}
                  style={style}
                  title={`${b.title} — ${formatTime(b.startsAt)} to ${formatTime(b.endsAt)} — ${b.organiserName}`}
                >
                  <span className="roomcal__blocktitle">{b.title}</span>
                  <span className="roomcal__blockmeta">{formatTime(b.startsAt)}–{formatTime(b.endsAt)} · {b.organiserName}</span>
                  {b.status === 'PENDING' ? <span className="roomcal__blockflag"><Icon name="clock" size={11} /> pending</span> : null}
                </div>
              );
            })}

            {/* Now-line -- only drawn when the viewed day is today. */}
            {nowLineTop !== null ? (
              <div className="roomcal__nowline" style={{ top: `${nowLineTop}%` }}>
                <span className="roomcal__nowdot" />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}