/**
 * A room's week: seven days as columns, the hours running down.
 *
 * The day view answered "is this room free at two" for one day at a time, which
 * meant stepping through days to find out when it was free at all. This shows
 * the week at once, so a free afternoon is something you see rather than
 * something you go looking for.
 *
 * Two clocks, deliberately. Times are shown in the room's own timezone first,
 * because that is the time people say out loud to each other -- "the review is
 * at two" means two where the room is. Underneath, in smaller type, the same
 * moment where the viewer is sitting. Showing only the room's time leaves a
 * colleague in New York doing arithmetic; showing only theirs quietly moves the
 * meeting in their head, and worse, slides the columns: a Friday morning in
 * Cairo is Thursday night in New York, so two people looking at "this week"
 * would be looking at different weeks. The columns are the room's days, and the
 * second clock is an annotation on them.
 *
 * The offset between the two is not a constant to be memorised, either: Egypt
 * and the United States start and end summer time on different dates, so the
 * gap changes several times a year and is wrong for weeks at a time if anyone
 * works it out once.
 *
 * Dragging across empty time proposes a booking. It does not create one: the
 * selection goes back into the booking form as an ordinary start time and
 * duration, where it is checked and can be changed like anything typed by hand.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { MeetingRoom, RoomCalendarBlock, RoomCalendarResponse } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { LoadingState, ErrorState } from './States';
import { Icon } from './Icon';

/** Minutes per row. Fifteen matches the booking form's own step. */
const SLOT_MINUTES = 15;
const PX_PER_MINUTE = 0.9;
const DAYS = 7;

/* The week starts on Saturday, as the working week does here. Sunday is 0 in
   JavaScript, so Saturday is 6. */
const WEEK_STARTS_ON = 6;

const hhmmToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The wall-clock minute of an instant, in a given zone. */
function minutesInZone(iso: string, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

const dayInZone = (iso: string, zone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(iso));

function shiftDay(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** The Saturday on or before the given date. */
function weekStart(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const back = (d.getUTCDay() - WEEK_STARTS_ON + 7) % 7;
  return shiftDay(isoDate, -back);
}

/**
 * What a given wall-clock minute of a room day reads as for the viewer.
 *
 * Built from a real instant rather than by adding an offset, so a day on which
 * the clocks change in either place is still right -- the gap between Cairo and
 * New York is not fixed, and the dates it changes on do not line up.
 */
function instantAt(isoDate: string, minutes: number, zone: string): Date {
  /* The instant that is `minutes` past midnight in the given zone. Two passes:
     guess from UTC, then correct by the error the guess reveals. Done this way
     rather than with a fixed offset because the offset is not fixed -- Egypt
     and the United States change their clocks on different dates, so a
     difference worked out once is wrong for weeks of the year. */
  const guess = new Date(`${isoDate}T00:00:00Z`).getTime() + minutes * 60_000;
  const drift = minutesInZone(new Date(guess).toISOString(), zone) - minutes;
  return new Date(guess - drift * 60_000);
}

function viewerLabel(isoDate: string, minutes: number, roomZone: string, viewerZone: string) {
  const instant = instantAt(isoDate, minutes, roomZone);

  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: viewerZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(instant);
  const sameDay = dayInZone(instant.toISOString(), viewerZone) === isoDate;
  return { time, sameDay };
}

const pad = (n: number) => String(n).padStart(2, '0');
const minutesToHHMM = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

export interface SlotSelection {
  /** The room's calendar day, YYYY-MM-DD. */
  date: string;
  /** HH:mm in the room's zone — what the column showed. */
  startTime: string;
  durationMinutes: number;
  /** The same range as instants, so the caller can book it without
   *  reconstructing the time and risking a different answer. */
  startsAt: string;
  endsAt: string;
}

export function RoomWeekCalendar({
  room, date, onPickSlot,
}: {
  room: MeetingRoom;
  date: string;
  /** Called when a free range is chosen. The caller decides what to do with it;
   *  this component never books anything itself. */
  onPickSlot?: (slot: SlotSelection) => void;
}) {
  const roomZone = room.location.timezone;
  const viewerZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || roomZone, [roomZone]);
  const showBothClocks = viewerZone !== roomZone;

  const [start, setStart] = useState(() => weekStart(date));
  // Following the form's date keeps the two in step when it is changed by hand.
  useEffect(() => { setStart(weekStart(date)); }, [date]);

  const calendar = useQuery({
    queryKey: qk.roomCalendarRange(room.id, start, DAYS),
    queryFn: () => api<RoomCalendarResponse>(
      `/meeting-rooms/rooms/${room.id}/calendar?date=${start}&days=${DAYS}`),
    /* Stepping to a week that has not been fetched before used to empty the
       grid and show a spinner, so the first move in each direction looked like
       the page reloading while the second -- already cached -- was instant.
       Keeping the previous week on screen while the next one loads makes every
       step feel the same: the grid stays, the header dims, the days swap when
       they arrive. */
    placeholderData: keepPreviousData,
  });
  const stepping = calendar.isFetching && !calendar.isLoading;

  const opensAt = hhmmToMinutes(calendar.data?.room.opensAt ?? room.opensAt ?? '08:00');
  const closesAt = hhmmToMinutes(calendar.data?.room.closesAt ?? room.closesAt ?? '20:00');
  const span = Math.max(closesAt - opensAt, 60);
  const trackHeight = span * PX_PER_MINUTE;

  /* --------------------------------------------------------- selection -- */
  const [drag, setDrag] = useState<{ date: string; from: number; to: number } | null>(null);
  const dragging = useRef(false);

  const minuteAt = (el: HTMLElement, clientY: number): number => {
    const box = el.getBoundingClientRect();
    const raw = opensAt + (clientY - box.top) / PX_PER_MINUTE;
    const snapped = Math.round(raw / SLOT_MINUTES) * SLOT_MINUTES;
    return Math.min(Math.max(snapped, opensAt), closesAt);
  };

  useEffect(() => {
    if (!drag) return;
    const stop = () => {
      dragging.current = false;
      setDrag((current) => {
        if (!current) return null;
        const from = Math.min(current.from, current.to);
        const to = Math.max(current.from, current.to);
        // A click rather than a drag: treat it as the default hour.
        const end = to - from < SLOT_MINUTES ? Math.min(from + 60, closesAt) : to;
        if (end > from) {
          /* The instants are worked out here, from the same day and minutes the
             column drew, so what gets booked is what was pointed at. Rebuilding
             them later from a date and a time string would go through the
             viewer's clock and could land an hour out on the days the clocks
             change. */
          onPickSlot?.({
            date: current.date,
            startTime: minutesToHHMM(from),
            durationMinutes: end - from,
            startsAt: instantAt(current.date, from, roomZone).toISOString(),
            endsAt: instantAt(current.date, end, roomZone).toISOString(),
          });
        }
        return null;
      });
    };
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, [drag, closesAt, onPickSlot, roomZone]);

  if (calendar.isLoading) return <LoadingState label="Loading the week" />;
  if (calendar.isError || !calendar.data) {
    return <ErrorState error={calendar.error} onRetry={() => void calendar.refetch()} />;
  }

  const days = calendar.data.days;

  /** Is any part of this range already spoken for? */
  const isFree = (dayBlocks: RoomCalendarBlock[], dayDate: string, from: number, to: number) =>
    !dayBlocks.some((b) => {
      const bs = minutesInZone(b.startsAt, roomZone);
      const be = dayInZone(b.endsAt, roomZone) !== dayDate ? closesAt : minutesInZone(b.endsAt, roomZone);
      return bs < to && be > from;
    });

  const hourMarks: number[] = [];
  for (let m = Math.ceil(opensAt / 60) * 60; m <= closesAt; m += 60) hourMarks.push(m);

  const today = dayInZone(new Date().toISOString(), roomZone);
  const nowMinutes = minutesInZone(new Date().toISOString(), roomZone);

  /* How far ahead this room may be booked. Past that the grid still shows what
     is there -- a booking somebody with more rights made is worth seeing -- but
     it cannot be selected. */
  const horizon = shiftDay(today, room.maxAdvanceDays ?? 90);

  /** Minutes of a day that cannot be booked, whatever the calendar shows.
   *  Returns null when the whole day is open. */
  const closedBefore = (dayDate: string): number | null => {
    if (dayDate < today) return closesAt;          // yesterday: all of it
    if (dayDate === today) return nowMinutes;      // today: up to now
    return null;
  };
  const beyondHorizon = (dayDate: string) => dayDate > horizon;

  return (
    <section className="weekcal" aria-label={`${room.name} — week of ${start}`}>
      <header className="weekcal__head">
        <button type="button" className="btn btn--sm weekcal__step" aria-label="Previous week"
                onClick={() => setStart((s) => shiftDay(s, -DAYS))}>
          <Icon name="left" /> <span>Prev</span>
        </button>
        <div className="weekcal__title">
          <strong>{formatRange(start, shiftDay(start, DAYS - 1))}</strong>
          <span className="weekcal__zone">
            {showBothClocks
              ? `Times in ${shortZone(roomZone)} — your time underneath (${shortZone(viewerZone)})`
              : `Times in ${shortZone(roomZone)}`}
          </span>
        </div>
        <button type="button" className="btn btn--sm weekcal__step" aria-label="Next week"
                onClick={() => setStart((s) => shiftDay(s, DAYS))}>
          <span>Next</span> <Icon name="right" />
        </button>
      </header>

      <div className={`weekcal__grid${stepping ? ' is-stepping' : ''}`} style={{ ['--track-height' as string]: `${trackHeight}px` }}>
        {/* The hour gutter: the room's clock, and the viewer's beside it. */}
        <div className="weekcal__gutter" aria-hidden="true">
          <div className="weekcal__dayhead weekcal__dayhead--spacer" />
          <div className="weekcal__track weekcal__track--gutter">
            {hourMarks.map((m) => {
              const mine = showBothClocks ? viewerLabel(start, m, roomZone, viewerZone) : null;
              return (
                <div key={m} className="weekcal__hour"
                     style={{ top: `${(m - opensAt) * PX_PER_MINUTE}px` }}>
                  <span className="weekcal__hourmain">{minutesToHHMM(m)}</span>
                  {mine ? (
                    <span className="weekcal__houralt">
                      {mine.time}{mine.sameDay ? '' : mine.time < '12:00' ? ' +1' : ' −1'}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {days.map((day) => {
          const isToday = day.date === today;
          return (
            <div key={day.date} className={`weekcal__col${isToday ? ' weekcal__col--today' : ''}`}>
              <div className="weekcal__dayhead">
                <span className="weekcal__dayname">{dayName(day.date)}</span>
                <span className="weekcal__daynum">{day.date.slice(8)}</span>
              </div>

              <div
                className="weekcal__track"
                role="grid"
                aria-label={`${dayName(day.date)} ${day.date}`}
                onPointerDown={(e) => {
                  if (!onPickSlot || e.button !== 0) return;
                  const at = minuteAt(e.currentTarget, e.clientY);
                  // Starting on top of a booking is a read, not a new booking.
                  if (!isFree(day.blocks, day.date, at, at + SLOT_MINUTES)) return;
                  /* Nor can time that has already gone, or time past the
                     room's booking horizon, be dragged out -- offering a
                     selection that the server would then refuse is a worse
                     answer than not offering it. */
                  const shut = closedBefore(day.date);
                  if (beyondHorizon(day.date) || (shut !== null && at < shut)) return;
                  dragging.current = true;
                  setDrag({ date: day.date, from: at, to: at + SLOT_MINUTES });
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!dragging.current || drag?.date !== day.date) return;
                  const at = minuteAt(e.currentTarget, e.clientY);
                  setDrag((d) => (d ? { ...d, to: at } : d));
                }}
              >
                {hourMarks.map((m) => (
                  <div key={m} className="weekcal__rule"
                       style={{ top: `${(m - opensAt) * PX_PER_MINUTE}px` }} />
                ))}

                {/* Time that has gone, hatched like a changeover rather than
                    left looking open. Drawn under the bookings, so yesterday's
                    meetings are still perfectly readable -- what happened is
                    worth seeing; it just cannot be booked. */}
                {(() => {
                  const shut = closedBefore(day.date);
                  if (shut === null || shut <= opensAt) return null;
                  const to = Math.min(shut, closesAt);
                  return (
                    <div className="weekcal__closed"
                         style={{ top: 0, height: `${(to - opensAt) * PX_PER_MINUTE}px` }}
                         title="Already passed" />
                  );
                })()}
                {beyondHorizon(day.date) ? (
                  <div className="weekcal__closed weekcal__closed--horizon"
                       style={{ top: 0, height: '100%' }}
                       title={`This room can be booked up to ${room.maxAdvanceDays} days ahead`} />
                ) : null}

                {day.blocks.map((b, i) => {
                  const from = Math.max(minutesInZone(b.startsAt, roomZone), opensAt);
                  const endSameDay = dayInZone(b.endsAt, roomZone) === day.date;
                  const to = Math.min(endSameDay ? minutesInZone(b.endsAt, roomZone) : closesAt, closesAt);
                  if (to <= from) return null;

                  const style = {
                    top: `${(from - opensAt) * PX_PER_MINUTE}px`,
                    height: `${(to - from) * PX_PER_MINUTE}px`,
                  };
                  if (b.type !== 'BOOKING') {
                    return (
                      <div key={`${b.type}-${i}`}
                           className={`weekcal__block weekcal__block--${b.type.toLowerCase()}`}
                           style={style}
                           title={b.type === 'BLACKOUT' ? (b.reason ?? 'Unavailable') : 'Changeover'} />
                    );
                  }
                  const mine = showBothClocks
                    ? viewerLabel(day.date, from, roomZone, viewerZone) : null;
                  return (
                    <div
                      key={b.id}
                      className={`weekcal__block weekcal__block--booking${b.isMine ? ' is-mine' : ''}`}
                      style={style}
                      title={`${b.title} — ${b.organiserName} (${minutesToHHMM(from)}–${minutesToHHMM(to)})`}
                    >
                      <span className="weekcal__blocktime">
                        {minutesToHHMM(from)}
                        {mine ? <em className="weekcal__blockalt">{mine.time}</em> : null}
                      </span>
                      <span className="weekcal__blocktitle">{b.title}</span>
                      <span className="weekcal__blockwho">{b.organiserName}</span>
                    </div>
                  );
                })}

                {drag && drag.date === day.date ? (
                  <div
                    className="weekcal__selection"
                    style={{
                      top: `${(Math.min(drag.from, drag.to) - opensAt) * PX_PER_MINUTE}px`,
                      height: `${Math.max(Math.abs(drag.to - drag.from), SLOT_MINUTES) * PX_PER_MINUTE}px`,
                    }}
                  >
                    {minutesToHHMM(Math.min(drag.from, drag.to))}–
                    {minutesToHHMM(Math.max(drag.to, drag.from + SLOT_MINUTES))}
                  </div>
                ) : null}

                {isToday && nowMinutes >= opensAt && nowMinutes <= closesAt ? (
                  /* A line alone was easy to mistake for an hour rule. It now
                     carries a dot at the edge and the time itself, and sits
                     above everything so a booking in progress cannot hide it. */
                  <div className="weekcal__now"
                       style={{ top: `${(nowMinutes - opensAt) * PX_PER_MINUTE}px` }}
                       aria-label={`Now, ${minutesToHHMM(nowMinutes)}`}>
                    <span className="weekcal__nowdot" />
                    <span className="weekcal__nowtime">{minutesToHHMM(nowMinutes)}</span>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {onPickSlot ? (
        <p className="weekcal__hint">
          Drag across free time to start a booking. Nothing is reserved until you confirm it.
        </p>
      ) : null}
    </section>
  );
}

const dayName = (isoDate: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(`${isoDate}T12:00:00Z`));

function formatRange(from: string, to: string): string {
  const f = new Date(`${from}T12:00:00Z`), t = new Date(`${to}T12:00:00Z`);
  const month = (d: Date) => new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(d);
  const sameMonth = month(f) === month(t);
  return sameMonth
    ? `${f.getUTCDate()}–${t.getUTCDate()} ${month(t)}`
    : `${f.getUTCDate()} ${month(f)} – ${t.getUTCDate()} ${month(t)}`;
}

/** "Africa/Cairo" reads as "Cairo" in a header; the full name belongs in a title. */
const shortZone = (zone: string) => zone.split('/').pop()?.replace(/_/g, ' ') ?? zone;