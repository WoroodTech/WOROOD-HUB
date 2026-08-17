# WOROOD HUB — Employee Dashboard (Home Screen)

This is the screen every employee lands on immediately after signing in.
It follows the frontend architecture in `WOROOD-HUB-Technical-Design.md`
(section 7): a generic shell driven by `GET /hub/modules`, a twelve-column
portlet grid, and no hard-coded navigation — new modules (Leave Requests,
Help Desk, Document Library, …) appear the moment their descriptor is
registered on the backend.

## What's here

- **The shell** (`src/components/shell`) — sidebar, topbar, and the layout
  that wraps every page. Sidebar navigation and the "coming soon" chips on
  the dashboard are generated entirely from the module list; nothing is
  hard-coded per module.
- **The dashboard** (`src/pages/Dashboard.tsx`) — the home screen itself:
  a profile summary, next meeting, free-rooms-right-now, upcoming
  reservations, quick actions, and an announcements feed, composed from
  portlet components in `src/components/portlets`.
- **Placeholder routes** for Book a Room / My Reservations / Manage Rooms
  so every link from the dashboard leads somewhere. The real screens for
  those are the rest of Module 1 (see the Technical Design doc, section 5,
  for the endpoints they'll call) and are out of scope here.
- **A mock API layer** (`src/lib/api/mockHub.ts`) that returns data shaped
  exactly like the documented endpoints (`GET /auth/me`, `GET /hub/modules`,
  `GET /meeting-rooms/reservations/next`, etc.). This is the only file that
  needs to change once the real NestJS API exists — swap the function bodies
  for `fetch()` calls against `/api/v1/...`; every component already expects
  those shapes.

## Running it

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # production bundle in dist/
npm run preview   # serve the production build locally
```

There is no backend dependency — everything renders from the mock data
layer, so this runs standalone for design review before the API is wired up.

## Wiring to the real API

1. Replace the bodies in `src/lib/api/mockHub.ts` with `fetch` calls to the
   endpoints listed in the Technical Design doc, section 5. Keep the
   function signatures and return types (`src/lib/types.ts`) unchanged.
2. Add the API client's token handling (access token in memory, refresh
   token flow) as described in section 7 of the design doc.
3. Everything else — shell, dashboard, portlets, routing — needs no changes.

## Notes

- Styling is a single stylesheet (`src/styles/app.css`) of design tokens and
  components, no UI framework, per the design doc's stated approach. It uses
  CSS logical properties throughout so the whole shell mirrors correctly
  under `dir="rtl"` once the Arabic locale is wired up — no separate RTL
  sheet needed.
- The font stack includes Noto Sans Arabic already, ahead of full Arabic
  support (design doc, section 7).
