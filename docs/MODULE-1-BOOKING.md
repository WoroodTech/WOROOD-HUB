# Module 1: from portlet depth to a working booking flow

August 2026.

## What was actually wrong

Nothing was broken. Booking had never been built.

The module registered three navigation entries — `/meeting-rooms/book`,
`/meeting-rooms/reservations`, `/meeting-rooms/admin` — and the sidebar renders
whatever the descriptor advertises. But the API had one controller with four
read-only `GET`s under `/meeting-rooms/portlets`, and the portal had no routes
matching `/meeting-rooms/*` at all. Every one of those three links fell through
to the `*` route and rendered **Not Found**.

The data layer was already correct, which is why the home portlets worked: `0002`
had created `mr_locations`, `mr_rooms` and `mr_reservations` with the GiST
exclusion constraint. You could see bookings. There was no way to make one.

**The lesson worth keeping: a descriptor entry with no route behind it is a link
to a dead end.** The module contract makes adding navigation a one-line change,
which is exactly why nothing catches this. Every path a descriptor advertises
now has both an endpoint and a screen.

## The schema, moved forward additively

`0004_meeting_rooms_booking.sql` adds what booking needs without renaming,
retyping or dropping anything that already holds data — `0002` is deployed, and
the portlet queries, the seed and the exclusion constraint all read those columns
today. Renaming `attendees` to `attendee_count` would have bought tidiness and
cost a working home screen; the API renames at the boundary instead, where it
is free.

What it adds:

- **`mr_equipment` + `mr_room_equipment`** — the fittings catalogue, normalised
  out of the `text[]` that was on `mr_rooms`. "Which rooms have a VC unit" is now
  an indexed join, and "Video Conference" is spelled once. The migration copies
  the array into the catalogue *before* dropping the column, in the same
  transaction. This path is tested against a database seeded pre-0004: two rooms
  carrying `{'projector','video conference'}` came out with slugified catalogue
  entries and their join rows intact.
- **Booking policy on `mr_rooms`** — `slot_minutes`, `min`/`max_duration_minutes`,
  `max_advance_days`, `buffer_minutes`, `requires_approval`. Every default
  reproduces the module's previous behaviour, so existing rooms keep working
  untouched. Policy on the row is what lets Facilities shorten a minimum booking
  or add a changeover buffer without a deploy.
- **`mr_room_blackouts`** — maintenance and holidays. A separate table rather
  than a fake reservation, because a blackout has no organiser to notify and must
  never appear in anyone's "my reservations".
- **`mr_reservation_attendees`** — internal user or external guest, never both
  and never neither; the CHECK is what stops a half-filled row existing.
- **Cancellation columns** — who cancelled, when, and why. The first thing
  anyone asks.
- **`mr_reservation_reference_seq`** — a sequence, not `COUNT(*) + 1`, because
  two people booking in the same moment would otherwise be handed the same
  reference, and a reference is what they read out on the phone.

## Where the guarantee lives

**The database owns double-booking, not the application.** `reservations.service`
does run a pre-flight check, and it exists only to produce a good error message
quickly — "Lotus is taken 11:00–11:45 by Omar Khaled (MR-2003)" rather than a
constraint violation. Check-then-insert is a race by construction: two requests
can both pass the check before either writes. The authority is the GiST
exclusion constraint, and `23P01` is caught and reported as a conflict. Delete
the pre-flight check and the system stays correct; only the wording gets worse.

The test proves this at the database, not through the API: two concurrent
inserts for overlapping windows in the same room, exactly one of which survives.

Half-open ranges (`[)`) are used in the constraint, in `slots.ts` and in every
comparison in between. A meeting ending at 10:00 does not clash with one starting
at 10:00 — and this is the single most common thing to get wrong, so it is
asserted at both levels.

## What the services enforce

Beyond the overlap guarantee, a booking is refused when it is outside the room's
opening hours (compared as wall-clock in the *location's* timezone, which is why
the column exists), longer or shorter than the room allows, beyond the booking
horizon, in the past, over capacity, running past midnight, or inside a blackout.
Each refusal names the number that caused it: `Jasmine seats 4. You have 40
attending.` beats "invalid request".

Permission is separate from arrangement. An employee manages their own bookings;
`reservation.manage-any` manages anyone's. `scope=all` without that permission
narrows silently back to your own rather than erroring — the screen still works,
it just shows what you are entitled to see. The API returns `canManage` per
reservation so the portal never re-derives the rule and gets it wrong.

Cancelling is a state change, not a deletion. The row stays, so the room's
history survives, and the exclusion constraint releases the slot on its own
because it only applies to live bookings — there is no cleanup step to forget.

Retiring a room is refused while it still has meetings ahead of it, and the
message says how many. Silently orphaning eight meetings to make a button work
is not a kindness.

## The three screens

- **`/meeting-rooms/book`** — filters first (day, duration, headcount, location,
  required fittings), then one card per room showing the times it can actually
  offer. Rooms that matched but cannot take the booking stay visible with the
  reason, because hiding them invites "why isn't Lotus in the list?". A slot list
  is an offer, not a promise; the 409 from a lost race is shown as itself.
- **`/meeting-rooms/reservations`** — upcoming by default, past one click away
  and never mixed in. Cancel asks for a reason, optional, and says why it's worth
  giving.
- **`/meeting-rooms/admin`** — booking policy is treated as first-class rather
  than hidden behind "advanced", because it is the reason the screen exists.

## Tests

```bash
# pure, no database
npx tsx test/slots.test.ts        # 24 assertions

# the real thing: real PostgreSQL, real guards, no mocks
npm run migrate && npm run seed -- --reset
npm run build && node dist/main.js &
npx tsx test/booking.test.ts      # 36 assertions
```

Four real bugs were found and fixed by writing these rather than by reading the
code:

1. `time` columns rejected a bare string from node-postgres — needed `::time`.
   Broke room creation with a 500 and the seed outright.
2. `RoomsService.create` read the new row back *inside* its own transaction, on a
   different pooled connection, where it was not yet visible.
3. `--reset` truncated `mr_equipment`, which migration `0004` had populated —
   leaving every room with no fittings and the filter with nothing to offer. The
   catalogue is reference data, so the seed restores it.
4. The seeded blackout was anchored with `date_trunc('day', now())`, which on a
   UTC server landed four hours off the intended Cairo maintenance window.

## Inviting colleagues

Added after the first pass, and it fixed a real hole rather than adding a
feature. The attendees table and `attendeeUserIds` already existed — but nothing
invited anyone, and the three home portlets asked `organizer_id = me`. **You
could be invited to a meeting and never find out**, because the only screen that
would have told you filtered you out of it.

- **Booking** has an attendee picker over the employee directory: search by two
  letters, chosen people stay visible as chips. The organiser is never offered —
  they are attending by definition.
- **The headcount is derived.** Name five colleagues and six people are coming,
  them and you. Capacity is checked against that rather than against a number
  somebody forgot to update after adding a name. A separate field covers heads
  who are not on the system.
- **The three portlets now ask "am I *in* this meeting"**, not "did I book it".
  A meeting you declined is excluded — you said you were not coming. A new
  portlet, *Awaiting Your Reply*, carries Accept and Decline inline and is
  ordered above *Free Right Now*, because an unanswered invitation is the one
  thing on that part of the home screen that somebody is waiting on you for.
- **Declining does not remove you.** The organiser needs to see that you were
  asked and said no, which is not the same as never being asked.
- **Editing the guest list preserves the replies already given.** The attendee
  rows are diffed rather than rebuilt: a delete-and-reinsert would silently reset
  everyone to `INVITED` every time the organiser fixed a typo, and the accepts
  already collected would vanish. This is asserted directly.
- **Four notifications, four different sentences**: invited, the meeting moved,
  it was cancelled and why, and — back to the organiser — who accepted or
  declined. Telling the already-invited they have been "invited" when a meeting
  merely moved would be wrong, so it does not.
- **A notification failure never fails the booking.** The invitation is the
  attendee row; the notification is the announcement. Losing a meeting because a
  notification insert failed would be far worse than someone finding it on their
  home screen unprompted.

`test/invitations.test.ts` — 41 assertions. The central one is proven by calling
the *invitee's own portlet endpoints*, the same requests their browser makes on
sign-in, rather than by checking that a row landed in a join table.

## Still open

- **Approval** puts a booking in `PENDING` and holds the slot, but there is no
  queue for Facilities to approve from — `PATCH` the status or use SQL for now.
- **Blackouts** are enforced everywhere and seeded, but only creatable in SQL.
- **External guests.** The schema holds an e-mail and a name for someone outside
  the company; only internal colleagues can be picked so far.
- **No calendar invitation.** Nothing lands in Outlook or Google — there is no
  mail transport in this build, so the portal is the only place a meeting
  appears.
- **Arabic copy.** The layout mirrors; the strings are still English.
