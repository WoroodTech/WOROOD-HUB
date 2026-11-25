# WOROOD HUB API and Module Guide

This is the source-oriented map of the portal: where a screen lives, which
backend route it calls, which controller method handles that route, and where
the behavior continues in the module's services. It is intended as a practical
endpoint index, not as a substitute for request/response DTOs or the source
code.

The route list was checked against the controllers currently mounted by
`apps/api/src/app.module.ts`. When a route changes, update the matching module
section here.

## Find an endpoint

1. Open the browser route in the [Web route map](#web-route-map), then open the
   linked page/component under that module's **Web pages and components**.
2. In that frontend file, find `api(` or `apiRaw(` and note the HTTP method
   and path. The path passed from the browser normally omits `/api/v1`; the
   shared client adds it.
3. Search this guide for that path. The matching route row's **API handler
   (source)** link opens the exact API controller file at the route decorator
   and names its method, for example
   [`WarehouseController.post()`](../apps/api/src/modules/warehouse/index.ts#L768).
   That decorated method is the endpoint handler.
4. Follow the handler's call into the service listed in that module's
   **Backend files** inventory.

The route tables are the bridge: **frontend call path → route row → linked
`Controller.method()` in `apps/api`**. For example,
[`WarehousePost.tsx`](../apps/web/src/pages/WarehousePost.tsx#L137) calls
`POST /warehouse/post`; the matching route row links to
[`WarehouseController.post()`](../apps/api/src/modules/warehouse/index.ts#L768).

All route-table paths include the global prefix. A path parameter such as
`:id` is a placeholder; query parameters are shown after `?`.

## Request and response flow

```text
Browser page/component
  -> apps/web/src/lib/api.ts (JSON, Bearer access token, one refresh retry)
  -> /api/v1/*
  -> Nest controller -> service(s) -> PostgreSQL / Google Sheets / Shopify / Zoho
  <- JSON response (shared payload types in packages/contract/index.ts)
```

- `apps/api/src/main.ts` sets `/api/v1`, enables validation and installs the
  common JSON error filter.
- `apps/web/src/lib/api.ts` is the normal HTTP client. Callers pass paths
  without `/api/v1`; the helper adds it, sends the access token and JSON body,
  retries one `401` after refreshing the session, and throws `ApiError` for
  other failures.
- `apiRaw()` is used for non-JSON responses such as CSV downloads. Browser
  uploads use an API-issued ticket and then send file bytes directly to the
  object store; see the upload notes below.
- `apps/web/src/main.tsx` installs React Router, React Query, authentication,
  appearance, notifications and the sales realtime provider. Query keys live
  in `apps/web/src/lib/keys.ts`; those keys identify cached data and are not
  backend routes or spreadsheet data.
- The API applies `JwtAuthGuard` and `PermissionsGuard` globally. A route is
  authenticated unless marked `@Public()`. `@Permissions(a, b)` uses **any**
  semantics: one listed permission is enough. Some services add object-level
  checks after the route guard.
- Errors use `{ error: { status, message, details?, path, at } }`, assembled by
  `apps/api/src/common/errors.ts`.
- Payload interfaces are declared in `packages/contract/index.ts` and copied
  into each app by `scripts/sync-contract.sh`.
- In development Vite proxies `/api` and `/socket.io` to `http://127.0.0.1:3000`
  (`apps/web/vite.config.ts`).

### Find the call inside a page

Most pages do not name a standalone function after the endpoint. They pass an
anonymous callback to React Query:

- `useQuery({ queryFn })` is a read the page runs when it loads or its inputs
  change. The callback's `api('/path')` is the GET request that supplies the
  displayed data.
- `useMutation({ mutationFn })` is a write. Follow the button/action to
  `.mutate()` or `.mutateAsync()`; that invokes the `mutationFn`, whose
  `api('/path', { method: ... })` is the request.
- `queryKey` is only a browser cache key; it is not an API endpoint.

For example, in
[`WarehousePost.tsx`](../apps/web/src/pages/WarehousePost.tsx#L61), each
`queryFn` calls a different read endpoint. Confirming the Post dialog calls
`post.mutate()` at line 428, which runs the `mutationFn` at line 136 and sends
`POST /warehouse/post`. The route table links that URL to the API handler.

### Server-to-browser and external flows

- **Sales realtime:** the API emits Socket.IO change hints in the `/sales`
  namespace. The browser invalidates React Query data and refetches via the
  authenticated REST API; the socket is not a second data API.
- **Shopify webhooks:** Shopify calls the public HMAC-verified webhook route.
  The API records and queues the event; the worker applies it to the local
  Shopify mirror. This is external-system-to-API traffic, not a browser call.
- **Sheets and Zoho:** module services queue writes; background workers drain
  those queues. A successful API response may mean a write is safely queued,
  not that the external spreadsheet/accounting system has already changed.
- **File uploads:** the browser asks the API for a short-lived upload ticket,
  uploads directly to object storage, then calls the API's confirm route.

## Trace a UI action to the backend

The route list answers **which endpoints exist**. These traces answer the
other question: **which page action calls which endpoint, handler and service?**
The common pattern is:

```text
App.tsx browser route
  -> page component and button/query callback
  -> api(path, { method, body })
  -> controller decorator + handler
  -> service method
  -> database / queue / external system
  <- response -> page updates React Query/UI
```

### Example: Receive stock

This is the full path from the **Post** button on the Receiving page to the
warehouse sheet.

1. **Browser route:** `/warehouse/receiving` renders `WarehousePost` with
   `fixedType="RECEIVING"` in [`App.tsx`](../apps/web/src/App.tsx#L140).
2. **Form setup:** [`WarehousePost.tsx`](../apps/web/src/pages/WarehousePost.tsx#L32)
   loads the movement type (`GET /api/v1/warehouse/types`), next receiving
   serial (`GET /api/v1/warehouse/next-serial?type=RECEIVING`), warehouses,
   item catalogue and balances. These reads populate the form and preview;
   they do not post stock. The first two are handled by
   [`WarehouseController.types()`](../apps/api/src/modules/warehouse/index.ts#L720)
   and [`WarehouseController.nextSerial()`](../apps/api/src/modules/warehouse/index.ts#L725);
   the serial handler calls
   [`WarehouseTransactionsService.nextSerial()`](../apps/api/src/modules/warehouse/transactions.service.ts#L100).
3. **Button action:** the form's Post button opens a confirmation dialog; the
   dialog's confirm callback invokes `post.mutate()`. The mutation function
   sends `POST /api/v1/warehouse/post` with the selected item lines and
   `type: "RECEIVING"` ([form mutation](../apps/web/src/pages/WarehousePost.tsx#L136),
   [Post button](../apps/web/src/pages/WarehousePost.tsx#L406),
   [confirmation callback](../apps/web/src/pages/WarehousePost.tsx#L428)).
4. **Route handler:** `@Post('post')` maps to
   [`WarehouseController.post()`](../apps/api/src/modules/warehouse/index.ts#L768).
   It passes the authenticated principal and `warehouse.tx.manage` capability
   to [`WarehouseTransactionsService.post()`](../apps/api/src/modules/warehouse/transactions.service.ts#L112).
5. **Server rules:** [`WarehouseTransactionsService.post()`](../apps/api/src/modules/warehouse/transactions.service.ts#L112)
   validates the movement and item lines. For `RECEIVING`, the server
   overrides the submitted destination to **WH-01** and issues the receiving
   patch/serial itself; the values displayed by the form are previews, not
   trusted posting instructions.
6. **Queue and sheet:** each ledger row is stored by
   [`WarehouseQueueService.enqueue()`](../apps/api/src/modules/warehouse/sheets/warehouse-queue.service.ts#L56).
   The request returns after the durable queue insert. The
   [`WarehouseWorker`](../apps/api/src/modules/warehouse/sheets/warehouse-worker.ts#L43)
   drains queued rows periodically;
   [`WarehouseQueueService.drain()`](../apps/api/src/modules/warehouse/sheets/warehouse-queue.service.ts#L89) calls
   [`WarehouseSheetClient.append()`](../apps/api/src/modules/warehouse/sheets/warehouse-sheet.client.ts#L172)
   to write the `LEDGER_ROW` to the `Scarves Inventory` tab. Thus “posted” means
   accepted into the queue; the separate queue-health endpoint reports
   whether it reached Google Sheets.
7. **UI after a successful response:** the mutation shows the result, clears
   the form for the next movement and invalidates warehouse queries so the
   serial, balances and status refresh.

### Example: Where an item code comes from

This follows the **Create the item** button and explains why the preview code
and the final sheet code are related but not generated in the same place.

1. **Browser route:** `/warehouse/new-item` renders `WarehouseNewItem`
   ([`App.tsx`](../apps/web/src/App.tsx#L159)).
2. **Picker values:** the component calls
   `GET /api/v1/warehouse/items/options`
   ([`WarehouseItems.tsx`](../apps/web/src/pages/WarehouseItems.tsx#L268)).
   [`WarehouseController.itemOptions()`](../apps/api/src/modules/warehouse/index.ts#L665)
   calls [`WarehouseItemsService.options()`](../apps/api/src/modules/warehouse/items.service.ts#L55),
   which combines
   [`WarehouseReaderService.codingTables()`](../apps/api/src/modules/warehouse/sheets/warehouse-reader.service.ts#L144)
   with the existing catalogue. `codingTables()` reads the **Keys** tab: A:B
   for color, D:E for kind, G:H for material (data starts on row 2). The
   catalogue side of the response comes from **Creating New Item**.
3. **Live preview:** changing the three selections triggers
   `POST /api/v1/warehouse/items/preview`
   ([preview query](../apps/web/src/pages/WarehouseItems.tsx#L277)).
   [`WarehouseController.previewItem()`](../apps/api/src/modules/warehouse/index.ts#L670)
   calls [`WarehouseItemsService.preview()`](../apps/api/src/modules/warehouse/items.service.ts#L79),
   which concatenates the mapped color, kind and material codes and returns
   the predicted name and code. If a mapping is missing, it reports which key
   must be added.
4. **Create button:** `create.mutate()` sends the selected parts (and optional
   custom name) to `POST /api/v1/warehouse/items`
   ([mutation](../apps/web/src/pages/WarehouseItems.tsx#L284),
   [Create button](../apps/web/src/pages/WarehouseItems.tsx#L410)).
   [`WarehouseController.createItem()`](../apps/api/src/modules/warehouse/index.ts#L674)
   calls [`WarehouseItemsService.create()`](../apps/api/src/modules/warehouse/items.service.ts#L109).
5. **What is actually written:** `create()` validates the mappings and
   duplicates, then queues an `ITEM` row containing the color, kind and
   material for the worker to append to **Creating New Item**. The spreadsheet
   formulas fill the item code (`=E&F&G`), default description and QR; when a
   custom name is supplied, the API writes that into the description cell
   instead. The API's returned code is the preview/expected code; the sheet
   remains the place that computes the catalogue formulas. See
   [`tabs.ts`](../apps/api/src/modules/warehouse/sheets/tabs.ts#L82) and
   [`warehouse-reader.service.ts`](../apps/api/src/modules/warehouse/sheets/warehouse-reader.service.ts#L144).

### Other representative action chains

| User action | Frontend call | API handler | Service / next step |
|---|---|---|---|
| Book a room | [`BookRoom.tsx`](../apps/web/src/pages/BookRoom.tsx#L146) mutation → `POST /api/v1/meeting-rooms/reservations` | [`MeetingRoomsController.book()`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L214) | [`ReservationsService.create()`](../apps/api/src/modules/meeting-rooms/reservations.service.ts#L451) validates and writes the reservation; database constraints prevent overlap. |
| Browse sales orders | [`Orders.tsx`](../apps/web/src/pages/Orders.tsx#L77) query → `GET /api/v1/sales/orders` | [`DashboardsController.orders()`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L190) | Reads the local Shopify order mirror and applies the caller's customer/payment permissions. Shopify webhook and sync flows keep the mirror current. |
| Decide a finance request | [`Finance.tsx`](../apps/web/src/pages/Finance.tsx#L887) decision mutation → `POST /api/v1/finance/requests/:id/decide` | [`FinanceController.decide()`](../apps/api/src/modules/finance/finance.module.ts#L190) | [`RequestsService.decide()`](../apps/api/src/modules/finance/requests.service.ts#L324) checks workflow state/authority and performs the decision effects. |
| Assign a ticket | [`TicketBacklog.tsx`](../apps/web/src/pages/TicketBacklog.tsx) assignment action → `POST /api/v1/tasks/:id/assign` | [`TasksController.assign()`](../apps/api/src/modules/tasks/tasks.module.ts#L171) | [`TasksService.assign()`](../apps/api/src/modules/tasks/tasks.service.ts#L355) checks department authority, changes assignment/state and writes a task event. |
| Create an employee | [`People.tsx`](../apps/web/src/pages/People.tsx#L647) create mutation → `POST /api/v1/admin/users` | [`AdministrationController.createUser()`](../apps/api/src/modules/administration/administration.module.ts#L180) | [`UsersService.create()`](../apps/api/src/modules/administration/users.service.ts#L192) creates the account; if the form also grants department-manager status, the page makes a second manager endpoint call. |
| Publish company news | [`NewsManage.tsx`](../apps/web/src/pages/NewsManage.tsx#L266) Publish action → `POST /api/v1/news/:id/publish` | [`AnnouncementsController.publish()`](../apps/api/src/modules/announcements/announcements.module.ts#L96) | [`AnnouncementsService.publish()`](../apps/api/src/modules/announcements/announcements.service.ts#L265) publishes the notice and creates notifications. |
| Shopify order changes | Shopify webhook → `POST /api/v1/sales/webhooks/shopify` (not a browser action) | [`WebhooksController.receive()`](../apps/api/src/modules/sales-dashboard/webhooks/webhooks.ts#L83) | HMAC verification, durable event insert/queue, then `WebhookWorker` updates the local mirror. The portal later reads the mirror through sales GET routes. |

## Platform and shared endpoints

Controller source: [`core.module.ts`](../apps/api/src/core/core.module.ts) and
[`notifications.controller.ts`](../apps/api/src/core/notifications.controller.ts).

### Shared frontend call sites

- [`lib/api.ts`](../apps/web/src/lib/api.ts) sends login, refresh, logout and
  current-user requests to `AuthController` in `core.module.ts`.
- [`lib/hub.ts`](../apps/web/src/lib/hub.ts) reads `/hub/modules`, handled by
  `HubController.modules()` in `core.module.ts`.
- [`AttendeePicker.tsx`](../apps/web/src/components/AttendeePicker.tsx) reads
  `/users`, handled by `UsersController.search()` in `core.module.ts`.
- [`Notificationbell.tsx`](../apps/web/src/components/Notificationbell.tsx)
  reads and updates `/notifications`, handled by `NotificationsController` in
  `notifications.controller.ts`.

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | Authenticate with email/password; return tokens and principal. Public. | [`AuthController.login`](../apps/api/src/core/core.module.ts#L194) |
| POST | `/api/v1/auth/refresh` | Rotate/refresh the session tokens. Public; requires refresh token. | [`AuthController.refresh`](../apps/api/src/core/core.module.ts#L200) |
| POST | `/api/v1/auth/logout` | Revoke the supplied refresh token. Public. | [`AuthController.logout`](../apps/api/src/core/core.module.ts#L206) |
| GET | `/api/v1/auth/me` | Return the authenticated principal and effective permissions. | [`AuthController.me`](../apps/api/src/core/core.module.ts#L211) |
| GET | `/api/v1/hub/modules` | Return enabled modules, permission-filtered navigation and home portlets. | [`HubController.modules`](../apps/api/src/core/core.module.ts#L218) |
| GET | `/api/v1/hub/notifications?limit=` | Return the current user's notification rows (module-level view). | [`HubController.notifications`](../apps/api/src/core/core.module.ts#L227) |
| GET | `/api/v1/users?q=&limit=` | Search active employees for pickers such as meeting attendees. | [`UsersController.search`](../apps/api/src/core/core.module.ts#L243) |
| GET | `/api/v1/health` | Public liveness check including a database round-trip. | [`HealthController.health`](../apps/api/src/core/core.module.ts#L264) |
| GET | `/api/v1/notifications?limit=` | List the signed-in user's notifications and unread count. | [`NotificationsController.list`](../apps/api/src/core/notifications.controller.ts#L135) |
| POST | `/api/v1/notifications/:id/read` | Mark one of the signed-in user's notifications read. | [`NotificationsController.read`](../apps/api/src/core/notifications.controller.ts#L144) |
| POST | `/api/v1/notifications/read-all` | Mark all of the signed-in user's notifications read. | [`NotificationsController.readAll`](../apps/api/src/core/notifications.controller.ts#L150) |

Core authentication/authorization implementation:
[`common/auth.ts`](../apps/api/src/common/auth.ts). The portal session lifecycle
is in [`web auth.tsx`](../apps/web/src/lib/auth.tsx) and
[`web api.ts`](../apps/web/src/lib/api.ts).

## Web route map

These are browser routes declared in [`App.tsx`](../apps/web/src/App.tsx), not
API routes.

| Browser path | Page/component |
|---|---|
| `/login`, `/signup` | `Login`, `Signup` |
| `/` | `Home` |
| `/meeting-rooms/book`, `/meeting-rooms/reservations`, `/meeting-rooms/invitations/:id`, `/meeting-rooms/admin` | `BookRoom`, `MyReservations`, `Invitation`, `ManageRooms` |
| `/finance`, `/finance/new`, `/finance/approvals`, `/finance/all`, `/finance/pay`, `/finance/cash-flow`, `/finance/requests/:id` | Finance screens in `Finance.tsx`; `FinanceCashFlow.tsx` |
| `/news`, `/news/manage`, `/news/:id` | `News`, `NewsManage`, `NewsItem` |
| `/tasks`, `/tasks/queue`, `/tasks/all`, `/tasks/board`, `/tasks/backlog`, `/tasks/department`, `/tasks/:id` | Task screens in `Tasks.tsx`, `TicketBoardPage`, `TicketBacklog`, `TicketDashboard`, `TaskDetailPage` |
| `/admin/people`, `/admin/departments`, `/admin/roles`, `/admin/signups` | `People`, `Departments`, `Roles`, `Signups` |
| `/warehouse`, `/warehouse/post`, `/warehouse/receiving`, `/warehouse/transfer`, `/warehouse/return`, `/warehouse/orders`, `/warehouse/templates`, `/warehouse/item`, `/warehouse/find`, `/warehouse/new-item`, `/warehouse/approvals`, `/warehouse/rolls`, `/warehouse/qc`, `/warehouse/issues`, `/warehouse/patches`, `/warehouse/reports`, `/warehouse/planning`, `/warehouse/labels`, `/warehouse/documents` | Warehouse pages in `Warehouse*.tsx` |
| `/sales`, `/sales/d/:key`, `/sales/orders`, `/sales/admin`, `/sales/admin/sync` | `SalesIndex`, `SalesDashboard`, `Orders`, `Composer`, `Sync` |

Task routes are wrapped in `ModuleRoute` because Tasks can be disabled at
deployment time. Other browser routes are not a substitute for API
authorization; the API guards decide access.

## Meeting Rooms

API prefix: `/api/v1/meeting-rooms`.

### Backend files

- [`meeting-rooms.module.ts`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts) — module descriptor, portlet and reservation controllers, route registration.
- [`rooms.service.ts`](../apps/api/src/modules/meeting-rooms/rooms.service.ts) — room catalogue and administration.
- [`availability.service.ts`](../apps/api/src/modules/meeting-rooms/availability.service.ts) — room availability search.
- [`reservations.service.ts`](../apps/api/src/modules/meeting-rooms/reservations.service.ts) — booking, calendar, invitations, responses, updates and cancellation.
- [`slots.ts`](../apps/api/src/modules/meeting-rooms/slots.ts) — booking time-slot arithmetic.
- [`dto.ts`](../apps/api/src/modules/meeting-rooms/dto.ts) — request/query DTO validation.
- [`permissions.ts`](../apps/api/src/modules/meeting-rooms/permissions.ts) — module permission keys.
- [`meeting-mail.ts`](../apps/api/src/modules/meeting-rooms/meeting-mail.ts) — invitation and reservation email composition/delivery.

### Web pages and components

- `BookRoom.tsx` — search availability and create a reservation.
- `MyReservations.tsx` — list, amend, cancel and respond to invitations.
- `Invitation.tsx` — invitation detail and response.
- `ManageRooms.tsx` — room/location/equipment administration.
- `RoomCalendar.tsx`, `RoomWeekCalendar.tsx` — reservation calendars.
- `portlets/registry.tsx` — renders the meeting-room home-screen portlets.

### Web-to-API call map

- [`BookRoom.tsx`](../apps/web/src/pages/BookRoom.tsx) calls
  `GET /rooms`, `/locations`, `/equipment`, `/availability`, then
  `POST /reservations`.
- [`MyReservations.tsx`](../apps/web/src/pages/MyReservations.tsx) calls
  `GET /reservations` and uses `PATCH /reservations/:id`,
  `POST /reservations/:id/response` and `DELETE /reservations/:id`.
- [`Invitation.tsx`](../apps/web/src/pages/Invitation.tsx) calls
  `GET /reservations/:id` and posts the response.
- [`ManageRooms.tsx`](../apps/web/src/pages/ManageRooms.tsx) calls the
  room/location/equipment reads and `POST|PATCH|DELETE /admin/rooms[/:id]`.
- [`RoomCalendar.tsx`](../apps/web/src/components/RoomCalendar.tsx) and
  [`RoomWeekCalendar.tsx`](../apps/web/src/components/RoomWeekCalendar.tsx)
  call `GET /rooms/:id/calendar`.
- Meeting-room calls from those pages are handled by
  `MeetingRoomsController` in [`meeting-rooms.module.ts`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts);
  the room portlet endpoints use `MeetingRoomsPortletsController` in that
  same file. Each endpoint row below links to its exact method.
- The home-screen portlets are dispatched by
  [`portlets/registry.tsx`](../apps/web/src/portlets/registry.tsx); their
  meeting-room HTTP read is `GET /meeting-rooms/portlets/:key`.

### Routes

Handlers are in [`meeting-rooms.module.ts`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts).

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/meeting-rooms/portlets/next-meeting` | Current user's next meeting, including meetings they accepted. | [`MeetingRoomsPortletsController.nextMeeting`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L66) |
| GET | `/api/v1/meeting-rooms/portlets/my-invitations` | Invitations still awaiting the current user's reply. | [`MeetingRoomsPortletsController.myInvitations`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L97) |
| GET | `/api/v1/meeting-rooms/portlets/free-now` | Rooms free for the next 30 minutes. | [`MeetingRoomsPortletsController.freeNow`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L118) |
| GET | `/api/v1/meeting-rooms/portlets/upcoming-reservations` | Current user's next reservations. | [`MeetingRoomsPortletsController.upcoming`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L147) |
| GET | `/api/v1/meeting-rooms/rooms` | List/filter rooms. | [`MeetingRoomsController.listRooms`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L183) |
| GET | `/api/v1/meeting-rooms/rooms/:id/calendar?date=&days=` | Calendar for a room and date range. | [`MeetingRoomsController.roomCalendar`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L186) |
| GET | `/api/v1/meeting-rooms/rooms/:id` | Room detail. | [`MeetingRoomsController.getRoom`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L191) |
| GET | `/api/v1/meeting-rooms/locations` | Location catalogue. | [`MeetingRoomsController.listLocations`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L194) |
| GET | `/api/v1/meeting-rooms/equipment` | Equipment catalogue. | [`MeetingRoomsController.listEquipment`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L197) |
| GET | `/api/v1/meeting-rooms/availability` | Search for rooms available for requested time/capacity/equipment. | [`MeetingRoomsController.availabilitySearch`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L200) |
| GET | `/api/v1/meeting-rooms/reservations` | List reservations visible to the current user. | [`MeetingRoomsController.listReservations`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L203) |
| GET | `/api/v1/meeting-rooms/reservations/:id` | Reservation detail, subject to visibility rules. | [`MeetingRoomsController.getReservation`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L208) |
| POST | `/api/v1/meeting-rooms/reservations` | Create a reservation and any attendee invitations. | [`MeetingRoomsController.book`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L213) |
| PATCH | `/api/v1/meeting-rooms/reservations/:id` | Amend a reservation. | [`MeetingRoomsController.amend`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L218) |
| POST | `/api/v1/meeting-rooms/reservations/:id/response` | Accept/decline the current user's invitation. | [`MeetingRoomsController.respond`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L227) |
| DELETE | `/api/v1/meeting-rooms/reservations/:id` | Cancel a reservation; history remains. | [`MeetingRoomsController.cancel`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L232) |
| POST | `/api/v1/meeting-rooms/admin/rooms` | Create a room (`meeting-room.manage`). | [`MeetingRoomsController.createRoom`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L239) |
| PATCH | `/api/v1/meeting-rooms/admin/rooms/:id` | Update a room (`meeting-room.manage`). | [`MeetingRoomsController.updateRoom`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L243) |
| DELETE | `/api/v1/meeting-rooms/admin/rooms/:id` | Retire a room (`meeting-room.manage`). | [`MeetingRoomsController.retireRoom`](../apps/api/src/modules/meeting-rooms/meeting-rooms.module.ts#L249) |

Further design notes: [`MODULE-1-BOOKING.md`](MODULE-1-BOOKING.md).

## Sales Dashboard and Shopify

API prefixes: `/api/v1/sales`, `/api/v1/sales/portlets`,
`/api/v1/sales/admin/sync`, `/api/v1/sales/webhooks`.

### Backend files

- [`sales-dashboard.module.ts`](../apps/api/src/modules/sales-dashboard/sales-dashboard.module.ts) — module wiring.
- [`descriptor.ts`](../apps/api/src/modules/sales-dashboard/descriptor.ts) — module navigation, portlets and permissions.
- [`dashboards/dashboards.controller.ts`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts) — dashboards, widgets, orders, notes, exports and dashboard administration.
- [`dashboards/access.service.ts`](../apps/api/src/modules/sales-dashboard/dashboards/access.service.ts) — effective dashboard access.
- [`metrics/metrics.service.ts`](../apps/api/src/modules/sales-dashboard/metrics/metrics.service.ts) — widget payloads.
- [`metrics/customer-metrics.service.ts`](../apps/api/src/modules/sales-dashboard/metrics/customer-metrics.service.ts) — customer metrics.
- [`analytics/snapshot.service.ts`](../apps/api/src/modules/sales-dashboard/analytics/snapshot.service.ts) — ShopifyQL analytics snapshots.
- [`orders/order-notes.service.ts`](../apps/api/src/modules/sales-dashboard/orders/order-notes.service.ts) — local notes mirrored to Shopify order notes.
- [`orders/bulk-comments.service.ts`](../apps/api/src/modules/sales-dashboard/orders/bulk-comments.service.ts) — bulk order-note jobs.
- [`orders/payment-export.service.ts`](../apps/api/src/modules/sales-dashboard/orders/payment-export.service.ts) — payment-reference CSV export and boundaries.
- [`shopify/shopify.service.ts`](../apps/api/src/modules/sales-dashboard/shopify/shopify.service.ts) — Shopify API access, tokens and cost/rate controls.
- [`portlets/portlets.controller.ts`](../apps/api/src/modules/sales-dashboard/portlets/portlets.controller.ts) — personal home portlets.
- [`realtime/sales.gateway.ts`](../apps/api/src/modules/sales-dashboard/realtime/sales.gateway.ts) — authenticated Socket.IO namespace.
- [`webhooks/webhooks.ts`](../apps/api/src/modules/sales-dashboard/webhooks/webhooks.ts) — HMAC verification and webhook receipt route.
- [`webhooks/topics.ts`](../apps/api/src/modules/sales-dashboard/webhooks/topics.ts) — Shopify topic registry.
- [`webhooks/webhook-lifecycle.ts`](../apps/api/src/modules/sales-dashboard/webhooks/webhook-lifecycle.ts) — webhook event state transitions.
- [`webhooks/webhook-processor.ts`](../apps/api/src/modules/sales-dashboard/webhooks/webhook-processor.ts) — applies queued webhook payloads to the mirror.
- [`webhooks/webhook-worker.ts`](../apps/api/src/modules/sales-dashboard/webhooks/webhook-worker.ts) — claims and processes webhook events.
- [`sync/sync.service.ts`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts) — reconciliation, diagnostics and sync admin controller.
- [`sync/scheduler.service.ts`](../apps/api/src/modules/sales-dashboard/sync/scheduler.service.ts) — periodic sync jobs.
- [`sync/backfill.service.ts`](../apps/api/src/modules/sales-dashboard/sync/backfill.service.ts) — historical Shopify bulk backfill.
- [`sync/bulk-stream.ts`](../apps/api/src/modules/sales-dashboard/sync/bulk-stream.ts) — parse Shopify bulk-operation output.
- [`sync/reconcile-pages.ts`](../apps/api/src/modules/sales-dashboard/sync/reconcile-pages.ts) — paginated reconciliation helpers.
- [`sync/abandoned-checkout.service.ts`](../apps/api/src/modules/sales-dashboard/sync/abandoned-checkout.service.ts) — abandoned checkout sync.
- [`sync/store-credit.service.ts`](../apps/api/src/modules/sales-dashboard/sync/store-credit.service.ts) — store-credit sync.

### Web pages and components

- `SalesIndex.tsx` — dashboard directory.
- `SalesDashboard.tsx` — selected dashboard and widgets.
- `Orders.tsx` — order list/detail navigation and payment export.
- `Composer.tsx` — dashboard/widget layout and access management.
- `Sync.tsx` — sync operations and diagnostics.
- `OrderNotes.tsx`, `BulkComment.tsx` — order note workflows.
- `widgets/registry.tsx` and `charts/*` — payload-kind renderers.
- `portlets/registry.tsx` — personal sales portlet renderers.
- `lib/realtime.tsx` — connect/subscribe to the sales Socket.IO gateway and invalidate query data.

### Web-to-API call map

- [`SalesIndex.tsx`](../apps/web/src/pages/SalesIndex.tsx) reads
  `/sales/dashboards`; [`SalesDashboard.tsx`](../apps/web/src/pages/SalesDashboard.tsx)
  reads `/sales/dashboards/:key/data`.
- [`Orders.tsx`](../apps/web/src/pages/Orders.tsx) reads `/sales/orders` and
  downloads the payment export with `apiRaw`; order detail notes are called
  from [`OrderNotes.tsx`](../apps/web/src/components/OrderNotes.tsx).
- [`BulkComment.tsx`](../apps/web/src/components/BulkComment.tsx) starts,
  polls and cancels `/sales/orders/bulk-comment*`.
- [`Composer.tsx`](../apps/web/src/pages/Composer.tsx) uses dashboard/widget/
  access routes. These endpoints are handled by
  [`DashboardsController`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts).
- [`Sync.tsx`](../apps/web/src/pages/Sync.tsx) uses `/sales/admin/sync*`;
  these handlers are in [`SyncController`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts).
- The home portlet registry
  ([`portlets/registry.tsx`](../apps/web/src/portlets/registry.tsx)) resolves
  `sales-dashboard` keys to `/sales/portlets/:key`, handled by
  [`PortletsController`](../apps/api/src/modules/sales-dashboard/portlets/portlets.controller.ts).
- The Shopify webhook is not called by a page: its external receiver is
  [`WebhooksController`](../apps/api/src/modules/sales-dashboard/webhooks/webhooks.ts).
  Every route row below links to its exact API method.

### Dashboard, order and portlet routes

Controller sources are linked in the Handler column.

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/sales/dashboards` | Resolve dashboards visible to the caller. | [`DashboardsController.dashboards`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L47) |
| GET | `/api/v1/sales/dashboards/:key` | Dashboard metadata and widget layout. | [`DashboardsController.dashboard`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L51) |
| GET | `/api/v1/sales/dashboards/:key/data?range=&primary=&against=` | Compute all widget payloads for a dashboard. | [`DashboardsController.dashboardData`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L60) |
| GET | `/api/v1/sales/widgets/:key/data?range=&primary=&against=` | Compute one widget payload. | [`DashboardsController.widgetData`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L97) |
| GET | `/api/v1/sales/widgets` | Widget catalogue for the composer. | [`DashboardsController.widgets`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L106) |
| GET | `/api/v1/sales/orders?page=&pageSize=&status=` | Paginated order list, totals, permission-filtered customer/payment data. | [`DashboardsController.orders`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L190) |
| GET | `/api/v1/sales/orders/:id` | Order detail, line items and refunds. | [`DashboardsController.order`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L286) |
| GET | `/api/v1/sales/orders/:id/notes` | Notes attached to an order. | [`DashboardsController.orderNotes`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L343) |
| POST | `/api/v1/sales/orders/:id/notes` | Add an order note and publish the combined note to Shopify. | [`DashboardsController.addOrderNote`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L350) |
| PATCH | `/api/v1/sales/orders/notes/:noteId` | Edit a note and republish the combined Shopify note. | [`DashboardsController.editOrderNote`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L358) |
| DELETE | `/api/v1/sales/orders/notes/:noteId` | Remove a note and republish the combined Shopify note. | [`DashboardsController.removeOrderNote`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L366) |
| POST | `/api/v1/sales/orders/notes/retry` | Retry note writes that previously failed. | [`DashboardsController.retryOrderNotes`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L374) |
| POST | `/api/v1/sales/orders/bulk-comment` | Start a bulk order-note run from parsed references. | [`DashboardsController.startBulkComment`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L131) |
| GET | `/api/v1/sales/orders/bulk-comment/recent` | Recent bulk-note runs for the caller. | [`DashboardsController.recentBulkComments`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L138) |
| GET | `/api/v1/sales/orders/bulk-comment/:id` | Get a bulk-note run's status/progress. | [`DashboardsController.bulkCommentStatus`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L142) |
| POST | `/api/v1/sales/orders/bulk-comment/:id/cancel` | Cancel a bulk-note run. | [`DashboardsController.cancelBulkComment`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L149) |
| GET | `/api/v1/sales/orders/payment-export/preview?from=&to=` | Preview the rows/date boundary of the next payment export. | [`DashboardsController.exportPreview`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L159) |
| POST | `/api/v1/sales/orders/payment-export?from=&to=` | Advance the export boundary and return a CSV download. | [`DashboardsController.takeExport`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L172) |
| POST | `/api/v1/sales/dashboards` | Create a dashboard. | [`DashboardsController.create`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L382) |
| PATCH | `/api/v1/sales/dashboards/:id` | Edit dashboard name/description. | [`DashboardsController.update`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L395) |
| PUT | `/api/v1/sales/dashboards/:id/widgets` | Replace dashboard widget layout. | [`DashboardsController.setWidgets`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L411) |
| DELETE | `/api/v1/sales/dashboards/:id` | Retire a dashboard. | [`DashboardsController.remove`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L433) |
| GET | `/api/v1/sales/dashboards/:id/access` | Read role/user dashboard grants and revocations. | [`DashboardsController.getAccess`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L444) |
| PUT | `/api/v1/sales/dashboards/:id/access` | Replace dashboard access assignments. | [`DashboardsController.setAccess`](../apps/api/src/modules/sales-dashboard/dashboards/dashboards.controller.ts#L467) |
| GET | `/api/v1/sales/portlets/my-dashboards` | Personal dashboard links/headlines. | [`PortletsController.myDashboards`](../apps/api/src/modules/sales-dashboard/portlets/portlets.controller.ts#L22) |
| GET | `/api/v1/sales/portlets/store-pulse` | Personal home-screen business pulse. | [`PortletsController.pulse`](../apps/api/src/modules/sales-dashboard/portlets/portlets.controller.ts#L54) |
| GET | `/api/v1/sales/portlets/my-alerts` | Current user's sales alerts. | [`PortletsController.myAlerts`](../apps/api/src/modules/sales-dashboard/portlets/portlets.controller.ts#L58) |

### Sync administration and Shopify ingress

Sync controller:
[`sync.service.ts`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts).
Webhook controller:
[`webhooks.ts`](../apps/api/src/modules/sales-dashboard/webhooks/webhooks.ts).

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/sales/admin/sync` | Sync health and current source state. | [`SyncController.health`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1476) |
| POST | `/api/v1/sales/admin/sync/backfill` | Start historical order backfill (`since` optional). | [`SyncController.backfill`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1489) |
| POST | `/api/v1/sales/admin/sync/webhooks/register` | Register Shopify webhook subscriptions. | [`SyncController.register`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1502) |
| GET | `/api/v1/sales/admin/sync/failed-events?limit=&offset=` | List failed webhook events. | [`SyncController.failedEvents`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1531) |
| POST | `/api/v1/sales/admin/sync/failed-events/:id/replay` | Requeue one failed event; audited. | [`SyncController.replayEvent`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1547) |
| GET | `/api/v1/sales/admin/sync/reconcile-check?date=` | Compare one date across Shopify, snapshots and local mirror. | [`SyncController.reconcileCheck`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1565) |
| GET | `/api/v1/sales/admin/sync/diagnostics` | Check configuration, Redis and Shopify connectivity without returning secrets. | [`SyncController.diagnostics`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1572) |
| POST | `/api/v1/sales/admin/sync/shop` | Refresh shop name/currency/timezone/plan metadata. | [`SyncController.shopSettings`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1617) |
| GET | `/api/v1/sales/admin/sync/schema/:typeName` | Describe a Shopify GraphQL type. | [`SyncController.schema`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1636) |
| GET | `/api/v1/sales/admin/sync/schema?types=` | Describe multiple Shopify GraphQL types. | [`SyncController.schemas`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1651) |
| POST | `/api/v1/sales/admin/sync/store-credit` | Start a store-credit export. | [`SyncController.storeCredit`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1660) |
| POST | `/api/v1/sales/admin/sync/abandoned` | Pull abandoned checkouts now. | [`SyncController.abandoned`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1667) |
| POST | `/api/v1/sales/admin/sync/reconcile` | Reconcile the order mirror. | [`SyncController.reconcile`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1674) |
| POST | `/api/v1/sales/admin/sync/snapshots/hourly-backfill` | Fill hourly analytics history (`months` optional). | [`SyncController.hourlyBackfill`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1680) |
| POST | `/api/v1/sales/admin/sync/snapshots` | Capture analytics snapshots now. | [`SyncController.snapshot`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1687) |
| POST | `/api/v1/sales/admin/sync/webhooks/verify` | Verify registered Shopify webhooks. | [`SyncController.verify`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1691) |
| POST | `/api/v1/sales/admin/sync/retention` | Run data-retention cleanup. | [`SyncController.retention`](../apps/api/src/modules/sales-dashboard/sync/sync.service.ts#L1695) |
| POST | `/api/v1/sales/webhooks/shopify` | Public Shopify webhook receiver; HMAC-checks, persists, queues, and acknowledges the event. | [`WebhooksController.receive`](../apps/api/src/modules/sales-dashboard/webhooks/webhooks.ts#L83) |

Existing detail: [`Sales dashboard reference.md`](Sales%20dashboard%20reference.md),
[`Shopify integration report.md`](Shopify%20integration%20report.md), and
[`docs-WOROOD-HUB-Module-2-Sales-Dashboard.md`](docs-WOROOD-HUB-Module-2-Sales-Dashboard.md).

## Finance

API prefix: `/api/v1/finance`.

### Backend files

- [`finance.module.ts`](../apps/api/src/modules/finance/finance.module.ts) — controller, module wiring and endpoint guards.
- [`index.ts`](../apps/api/src/modules/finance/index.ts) — module exports.
- [`dto.ts`](../apps/api/src/modules/finance/dto.ts) — validated input/query shapes.
- [`workflow.ts`](../apps/api/src/modules/finance/workflow.ts) — request workflow/state transitions.
- [`request-form.ts`](../apps/api/src/modules/finance/request-form.ts) — request form configuration.
- [`requests.service.ts`](../apps/api/src/modules/finance/requests.service.ts) — request lifecycle, access scope, approvals and notes.
- [`edits.service.ts`](../apps/api/src/modules/finance/edits.service.ts) — post-approval change requests.
- [`payments.service.ts`](../apps/api/src/modules/finance/payments.service.ts) — payment recording and outstanding payments.
- [`cashflow.service.ts`](../apps/api/src/modules/finance/cashflow.service.ts) — cash-flow reports/forecasts.
- [`request-widgets.service.ts`](../apps/api/src/modules/finance/request-widgets.service.ts) — finance home portlets.
- [`projection.ts`](../apps/api/src/modules/finance/projection.ts) — spreadsheet-to-portal projection rules.
- [`files.service.ts`](../apps/api/src/modules/finance/files.service.ts) — upload tickets, confirmation and access-controlled files.
- [`finance-mail.ts`](../apps/api/src/modules/finance/finance-mail.ts) — finance email content/delivery.
- [`migration/import.service.ts`](../apps/api/src/modules/finance/migration/import.service.ts) — legacy data import batches.
- `sheets/row-mapping.ts` — finance request to spreadsheet row mapping.
- `sheets/sheets-client.ts` — Google Sheets API access.
- `sheets/sheets-queue.service.ts`, `sheets/sheets-worker.ts` — durable spreadsheet write queue and worker.
- `zoho/accounts.service.ts` — Zoho account catalogue and diagnostics.
- `zoho/books-client.ts` — Zoho Books API client.
- `zoho/purchase-orders.service.ts` — supplier and purchase-order workflow.
- `zoho/record-id.ts` — Zoho record identifier parsing.
- `zoho/zoho-queue.service.ts`, `zoho/zoho-worker.ts` — durable Zoho write queue and worker.

### Web pages and components

- `Finance.tsx` — request list, approvals, request creation/detail, payments, files and purchase-order UI.
- `FinanceCashFlow.tsx` — monthly cash flow and comparison.
- `App.tsx` — finance browser routes.
- `api.ts` — authenticated HTTP transport; uploads/downloads are noted above.

### Web-to-API call map

- [`Finance.tsx`](../apps/web/src/pages/Finance.tsx) calls request form/list/
  detail, summary, department, approval/edit, payment, vendor/purchase-order
  and note endpoints. The same file owns file-ticket/upload/confirm/remove
  calls. These routes are handled by
  [`FinanceController`](../apps/api/src/modules/finance/finance.module.ts).
- [`FinanceCashFlow.tsx`](../apps/web/src/pages/FinanceCashFlow.tsx) calls
  `/finance/cash-flow` and `/finance/cash-flow/compare`; both are also handled
  by `FinanceController`.
- Search the exact route in the tables below to see the specific
  `FinanceController.method()` linked to the endpoint.

### Request, approval and edit routes

Handlers are in [`finance.module.ts`](../apps/api/src/modules/finance/finance.module.ts).

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/finance/request-form` | Current user's request form fields and department context. | [`FinanceController.requestForm`](../apps/api/src/modules/finance/finance.module.ts#L108) |
| GET | `/api/v1/finance/requests?` | List requests visible to caller; supports list filters. | [`FinanceController.list`](../apps/api/src/modules/finance/finance.module.ts#L113) |
| GET | `/api/v1/finance/requests/summary?state=` | Department-scoped totals for requests and payments. | [`FinanceController.summary`](../apps/api/src/modules/finance/finance.module.ts#L127) |
| GET | `/api/v1/finance/requests/departments` | Departments visible to caller for filtering. | [`FinanceController.requestDepartments`](../apps/api/src/modules/finance/finance.module.ts#L140) |
| GET | `/api/v1/finance/approvals` | Requests and approved-request edits awaiting the caller. | [`FinanceController.queue`](../apps/api/src/modules/finance/finance.module.ts#L154) |
| GET | `/api/v1/finance/requests/:id` | Request detail. | [`FinanceController.get`](../apps/api/src/modules/finance/finance.module.ts#L163) |
| POST | `/api/v1/finance/requests` | Create a draft request. | [`FinanceController.create`](../apps/api/src/modules/finance/finance.module.ts#L170) |
| POST | `/api/v1/finance/requests/:id/submit` | Submit a request into the approval workflow. | [`FinanceController.submit`](../apps/api/src/modules/finance/finance.module.ts#L175) |
| PATCH | `/api/v1/finance/requests/:id` | Update an editable request. | [`FinanceController.update`](../apps/api/src/modules/finance/finance.module.ts#L180) |
| POST | `/api/v1/finance/requests/:id/decide` | Approve/reject/return a request, with reason/pricing/optional purchase order. | [`FinanceController.decide`](../apps/api/src/modules/finance/finance.module.ts#L190) |
| DELETE | `/api/v1/finance/requests/:id` | Remove a request where workflow rules permit. | [`FinanceController.remove`](../apps/api/src/modules/finance/finance.module.ts#L201) |
| POST | `/api/v1/finance/requests/:id/edits` | Request a change to an approved request. | [`FinanceController.requestEdit`](../apps/api/src/modules/finance/finance.module.ts#L212) |
| GET | `/api/v1/finance/requests/:id/edits` | List change requests for a request. | [`FinanceController.editsFor`](../apps/api/src/modules/finance/finance.module.ts#L218) |
| GET | `/api/v1/finance/edits` | List edits waiting for the caller. | [`FinanceController.editQueue`](../apps/api/src/modules/finance/finance.module.ts#L224) |
| POST | `/api/v1/finance/edits/:editId/decide` | Decide an edit request. | [`FinanceController.decideEdit`](../apps/api/src/modules/finance/finance.module.ts#L229) |
| POST | `/api/v1/finance/edits/:editId/withdraw` | Withdraw an edit request. | [`FinanceController.withdrawEdit`](../apps/api/src/modules/finance/finance.module.ts#L236) |
| POST | `/api/v1/finance/requests/:id/notes` | Add a request note (optionally internal). | [`FinanceController.addNote`](../apps/api/src/modules/finance/finance.module.ts#L548) |
| GET | `/api/v1/finance/mail-check?to=` | Diagnose/request a finance email test. | [`FinanceController.mailCheck`](../apps/api/src/modules/finance/finance.module.ts#L358) |

### Payments, cash flow and purchasing

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/finance/payments/outstanding` | Outstanding payments the caller may see. | [`FinanceController.outstanding`](../apps/api/src/modules/finance/finance.module.ts#L246) |
| GET | `/api/v1/finance/requests/:id/payments` | Payments recorded for a request. | [`FinanceController.paymentsFor`](../apps/api/src/modules/finance/finance.module.ts#L251) |
| POST | `/api/v1/finance/requests/:id/payments` | Record a payment (`finance.payment.record`). | [`FinanceController.recordPayment`](../apps/api/src/modules/finance/finance.module.ts#L256) |
| GET | `/api/v1/finance/cash-flow?month=&method=` | Monthly cash-flow forecast/report. | [`FinanceController.cashFlow`](../apps/api/src/modules/finance/finance.module.ts#L281) |
| GET | `/api/v1/finance/cash-flow/compare?month=` | Compare cash-flow calculation methods. | [`FinanceController.cashFlowCompare`](../apps/api/src/modules/finance/finance.module.ts#L288) |
| GET | `/api/v1/finance/vendors` | Vendor list for purchase forms. | [`FinanceController.vendors`](../apps/api/src/modules/finance/finance.module.ts#L299) |
| POST | `/api/v1/finance/vendors/sync` | Refresh vendor data from Zoho. | [`FinanceController.syncVendors`](../apps/api/src/modules/finance/finance.module.ts#L305) |
| GET | `/api/v1/finance/vendors/:vendorId/next-reference` | Suggest the next reference for a vendor. | [`FinanceController.nextReference`](../apps/api/src/modules/finance/finance.module.ts#L319) |
| GET | `/api/v1/finance/requests/:id/purchase-order` | Purchase order associated with a request. | [`FinanceController.purchaseOrder`](../apps/api/src/modules/finance/finance.module.ts#L325) |
| POST | `/api/v1/finance/requests/:id/purchase-order/received` | Mark goods as received / advance the Zoho PO. | [`FinanceController.markReceived`](../apps/api/src/modules/finance/finance.module.ts#L331) |
| POST | `/api/v1/finance/requests/:id/purchase-order` | Draft a Zoho purchase order for a request. | [`FinanceController.draftPurchaseOrder`](../apps/api/src/modules/finance/finance.module.ts#L338) |

### Files, migration, Sheets and Zoho operations

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/finance/requests/:id/files` | List files visible to caller. | [`FinanceController.listFiles`](../apps/api/src/modules/finance/finance.module.ts#L527) |
| POST | `/api/v1/finance/requests/:id/files` | Request a file upload ticket. | [`FinanceController.requestFileUpload`](../apps/api/src/modules/finance/finance.module.ts#L532) |
| POST | `/api/v1/finance/files/:fileId/confirm` | Validate and confirm uploaded bytes. | [`FinanceController.confirmFile`](../apps/api/src/modules/finance/finance.module.ts#L538) |
| DELETE | `/api/v1/finance/files/:fileId` | Remove an authorized attachment. | [`FinanceController.removeFile`](../apps/api/src/modules/finance/finance.module.ts#L543) |
| POST | `/api/v1/finance/migration/read` | Read legacy rows into a non-live import batch; feature-flagged. | [`FinanceController.readImport`](../apps/api/src/modules/finance/finance.module.ts#L388) |
| GET | `/api/v1/finance/migration/:batchId` | Review a migration batch. | [`FinanceController.reviewImport`](../apps/api/src/modules/finance/finance.module.ts#L396) |
| POST | `/api/v1/finance/migration/:batchId/promote` | Promote an approved batch to live records; feature-flagged. | [`FinanceController.promoteImport`](../apps/api/src/modules/finance/finance.module.ts#L404) |
| POST | `/api/v1/finance/migration/:batchId/discard` | Discard an import batch; feature-flagged. | [`FinanceController.discardImport`](../apps/api/src/modules/finance/finance.module.ts#L413) |
| GET | `/api/v1/finance/sheet/describe` | Identify the connected spreadsheet and tabs. | [`FinanceController.describeSheet`](../apps/api/src/modules/finance/finance.module.ts#L436) |
| GET | `/api/v1/finance/sheet/header?tab=` | Read a tab header for operational verification. | [`FinanceController.sheetHeader`](../apps/api/src/modules/finance/finance.module.ts#L443) |
| GET | `/api/v1/finance/sheet/health` | Spreadsheet queue health. | [`FinanceController.sheetHealth`](../apps/api/src/modules/finance/finance.module.ts#L449) |
| POST | `/api/v1/finance/sheet/drain` | Drain queued spreadsheet writes now. | [`FinanceController.drainSheet`](../apps/api/src/modules/finance/finance.module.ts#L456) |
| GET | `/api/v1/finance/zoho/diagnose` | Run Zoho endpoint diagnostics. | [`FinanceController.zohoDiagnose`](../apps/api/src/modules/finance/finance.module.ts#L483) |
| GET | `/api/v1/finance/zoho/whoami` | Identify the connected Zoho organization/user. | [`FinanceController.zohoWhoAmI`](../apps/api/src/modules/finance/finance.module.ts#L489) |
| GET | `/api/v1/finance/zoho/accounts` | List account choices for payment forms. | [`FinanceController.zohoAccountList`](../apps/api/src/modules/finance/finance.module.ts#L496) |
| POST | `/api/v1/finance/zoho/accounts/sync` | Refresh Zoho account cache. | [`FinanceController.syncZohoAccounts`](../apps/api/src/modules/finance/finance.module.ts#L503) |
| GET | `/api/v1/finance/zoho/health` | Zoho queue health. | [`FinanceController.zohoHealth`](../apps/api/src/modules/finance/finance.module.ts#L509) |
| POST | `/api/v1/finance/zoho/events/:eventId/retry` | Retry a failed Zoho event. | [`FinanceController.retryZoho`](../apps/api/src/modules/finance/finance.module.ts#L515) |

**Known route discrepancy to verify:** `Finance.tsx` currently calls
`/finance/vendors/next-po-number/next-reference`, while the API declares
`/finance/vendors/:vendorId/next-reference`. Confirm the intended vendor
identifier/path before relying on the next-reference picker.

## Tasks & Tickets

API prefix: `/api/v1/tasks`; the module is only mounted when the Tasks feature
is enabled.

### Backend files

- [`tasks.module.ts`](../apps/api/src/modules/tasks/tasks.module.ts) — module descriptor, portlets and HTTP controllers.
- [`tasks.service.ts`](../apps/api/src/modules/tasks/tasks.service.ts) — ticket creation, visibility, transitions, comments, contributors and dependencies.
- [`board.service.ts`](../apps/api/src/modules/tasks/board.service.ts) — employee/manager boards and department queue.
- [`attachments.service.ts`](../apps/api/src/modules/tasks/attachments.service.ts) — ticket attachment upload and access.
- [`attachment-files.ts`](../apps/api/src/modules/tasks/attachment-files.ts) — attachment file validation/storage helpers.
- [`scheduler.service.ts`](../apps/api/src/modules/tasks/scheduler.service.ts) — SLA and escalation sweeps.
- [`events.ts`](../apps/api/src/modules/tasks/events.ts) — task event/notification publishing.
- [`permissions.ts`](../apps/api/src/modules/tasks/permissions.ts) — task permission keys.
- [`dto.ts`](../apps/api/src/modules/tasks/dto.ts) — task request DTOs and validation.
- [`visibility.service.ts`](../apps/api/src/modules/tasks/visibility.service.ts) — ticket visibility rules.
- [`ticket-mail.ts`](../apps/api/src/modules/tasks/ticket-mail.ts) — ticket notification email composition.

### Web pages and components

- `Tasks.tsx` — personal task lists and creation.
- `TicketBoardPage.tsx`, `MyTicketBoard.tsx`, `TicketBoard.tsx`, `TicketViews.tsx` — manager/employee boards and cards.
- `TicketBacklog.tsx`, `TicketDashboard.tsx` — manager decisions and department reporting.
- `TaskDetail.tsx` — detail, workflow actions, comments, files, contributors and dependencies.
- `AddTaskDialog.tsx`, `Attachments.tsx`, `lib/upload.ts` — creation/assignment and ticket upload flow.
- `portlets/registry.tsx` — task home-screen portlets.

### Web-to-API call map

- [`Tasks.tsx`](../apps/web/src/pages/Tasks.tsx) creates requests and reads
  personal task lists.
- [`TicketBoardPage.tsx`](../apps/web/src/pages/TicketBoardPage.tsx) and
  [`MyTicketBoard.tsx`](../apps/web/src/pages/MyTicketBoard.tsx) read boards
  and post move actions; [`TicketBacklog.tsx`](../apps/web/src/pages/TicketBacklog.tsx)
  reads manager decisions and posts lifecycle actions.
- [`TicketDashboard.tsx`](../apps/web/src/pages/TicketDashboard.tsx) reads the
  department dashboard.
- [`TaskDetail.tsx`](../apps/web/src/pages/TaskDetail.tsx) reads a ticket and
  posts updates, transitions, comments, contributor and dependency changes.
- [`AddTaskDialog.tsx`](../apps/web/src/components/AddTaskDialog.tsx) reads
  departments/assignable people and posts assignment;
  [`Attachments.tsx`](../apps/web/src/components/Attachments.tsx) handles
  attachment removal.
- `lib/upload.ts` requests an attachment ticket, sends bytes to object storage,
  then confirms through the API.
- [`portlets/registry.tsx`](../apps/web/src/portlets/registry.tsx) loads task
  portlets through `GET /tasks/portlets/:key`.
- These routes are handled by
  [`TasksController`](../apps/api/src/modules/tasks/tasks.module.ts). Search
  the endpoint row below for its exact method link.

### Routes

Handlers are in [`tasks.module.ts`](../apps/api/src/modules/tasks/tasks.module.ts).

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/tasks/portlets/:key` | Personal/manager task home-portlet payload. | [`TasksPortletsController.portlet`](../apps/api/src/modules/tasks/tasks.module.ts#L93) |
| GET | `/api/v1/tasks/departments` | Departments available to the caller for assignment. | [`TasksController.departments`](../apps/api/src/modules/tasks/tasks.module.ts#L108) |
| GET | `/api/v1/tasks/departments/:id/people` | People assignable within a department. | [`TasksController.people`](../apps/api/src/modules/tasks/tasks.module.ts#L111) |
| GET | `/api/v1/tasks` | List tickets visible to the caller. | [`TasksController.list`](../apps/api/src/modules/tasks/tasks.module.ts#L116) |
| GET | `/api/v1/tasks/counts` | Counts for task lists/queues. | [`TasksController.counts`](../apps/api/src/modules/tasks/tasks.module.ts#L119) |
| POST | `/api/v1/tasks` | Create a task/request. | [`TasksController.create`](../apps/api/src/modules/tasks/tasks.module.ts#L122) |
| GET | `/api/v1/tasks/board?side=&departmentId=&askedBy=` | Manager board for work being done or requested. | [`TasksController.board`](../apps/api/src/modules/tasks/tasks.module.ts#L129) |
| GET | `/api/v1/tasks/backlog?departmentId=&askedBy=` | Decisions/requests waiting on managers. | [`TasksController.backlog`](../apps/api/src/modules/tasks/tasks.module.ts#L138) |
| GET | `/api/v1/tasks/board/mine` | Current user's board. | [`TasksController.myBoard`](../apps/api/src/modules/tasks/tasks.module.ts#L144) |
| GET | `/api/v1/tasks/dashboard?side=&departmentId=&askedBy=` | Department work/ageing dashboard. | [`TasksController.dashboard`](../apps/api/src/modules/tasks/tasks.module.ts#L149) |
| GET | `/api/v1/tasks/:id` | Ticket detail and readable history. | [`TasksController.detail`](../apps/api/src/modules/tasks/tasks.module.ts#L159) |
| PATCH | `/api/v1/tasks/:id` | Update editable request fields. | [`TasksController.update`](../apps/api/src/modules/tasks/tasks.module.ts#L164) |
| POST | `/api/v1/tasks/:id/assign` | Assign ticket to a person. | [`TasksController.assign`](../apps/api/src/modules/tasks/tasks.module.ts#L171) |
| POST | `/api/v1/tasks/:id/transfer` | Transfer ticket/ownership. | [`TasksController.transfer`](../apps/api/src/modules/tasks/tasks.module.ts#L176) |
| POST | `/api/v1/tasks/:id/reject` | Reject a request with a reason. | [`TasksController.reject`](../apps/api/src/modules/tasks/tasks.module.ts#L181) |
| POST | `/api/v1/tasks/:id/cancel` | Cancel a ticket/request. | [`TasksController.cancel`](../apps/api/src/modules/tasks/tasks.module.ts#L186) |
| POST | `/api/v1/tasks/:id/start` | Start assigned work. | [`TasksController.start`](../apps/api/src/modules/tasks/tasks.module.ts#L191) |
| POST | `/api/v1/tasks/:id/due` | Set or change the due date. | [`TasksController.due`](../apps/api/src/modules/tasks/tasks.module.ts#L196) |
| POST | `/api/v1/tasks/:id/resolve` | Submit work for requester review. | [`TasksController.resolve`](../apps/api/src/modules/tasks/tasks.module.ts#L201) |
| POST | `/api/v1/tasks/:id/review/approve` | Approve review and finish the ticket. | [`TasksController.confirm`](../apps/api/src/modules/tasks/tasks.module.ts#L206) |
| POST | `/api/v1/tasks/:id/review/reject` | Return reviewed work with a reason. | [`TasksController.rejectReview`](../apps/api/src/modules/tasks/tasks.module.ts#L211) |
| POST | `/api/v1/tasks/:id/attachments` | Request an upload ticket scoped to the task. | [`TasksController.requestUpload`](../apps/api/src/modules/tasks/tasks.module.ts#L223) |
| POST | `/api/v1/tasks/attachments/:attachmentId/confirm` | Confirm uploaded bytes. | [`TasksController.confirmUpload`](../apps/api/src/modules/tasks/tasks.module.ts#L229) |
| DELETE | `/api/v1/tasks/attachments/:attachmentId` | Remove a permitted attachment. | [`TasksController.removeAttachment`](../apps/api/src/modules/tasks/tasks.module.ts#L235) |
| POST | `/api/v1/tasks/:id/implementation` | Begin implementation after acceptance. | [`TasksController.startImplementation`](../apps/api/src/modules/tasks/tasks.module.ts#L241) |
| POST | `/api/v1/tasks/:id/resume` | Resume work after changes, optionally setting due date. | [`TasksController.resumeAfterChanges`](../apps/api/src/modules/tasks/tasks.module.ts#L246) |
| POST | `/api/v1/tasks/:id/review/again` | Return the ticket to review. | [`TasksController.returnToReview`](../apps/api/src/modules/tasks/tasks.module.ts#L252) |
| POST | `/api/v1/tasks/:id/move` | Board drag/drop transition; server validates lifecycle. | [`TasksController.move`](../apps/api/src/modules/tasks/tasks.module.ts#L258) |
| POST | `/api/v1/tasks/:id/plan` | Plan/schedule a ticket. | [`TasksController.plan`](../apps/api/src/modules/tasks/tasks.module.ts#L263) |
| POST | `/api/v1/tasks/:id/hold` | Put work on hold with a reason. | [`TasksController.hold`](../apps/api/src/modules/tasks/tasks.module.ts#L268) |
| POST | `/api/v1/tasks/:id/complete` | Mark implementation complete. | [`TasksController.complete`](../apps/api/src/modules/tasks/tasks.module.ts#L275) |
| POST | `/api/v1/tasks/:id/comments` | Add a comment. | [`TasksController.comment`](../apps/api/src/modules/tasks/tasks.module.ts#L280) |
| POST | `/api/v1/tasks/:id/contributors` | Add a contributor. | [`TasksController.addContributor`](../apps/api/src/modules/tasks/tasks.module.ts#L285) |
| DELETE | `/api/v1/tasks/:id/contributors/:userId` | Remove a contributor. | [`TasksController.removeContributor`](../apps/api/src/modules/tasks/tasks.module.ts#L290) |
| POST | `/api/v1/tasks/:id/dependencies` | Add a dependency link. | [`TasksController.addDependency`](../apps/api/src/modules/tasks/tasks.module.ts#L296) |
| DELETE | `/api/v1/tasks/:id/dependencies/:linkId` | Remove a dependency link. | [`TasksController.removeDependency`](../apps/api/src/modules/tasks/tasks.module.ts#L301) |
| POST | `/api/v1/tasks/admin/sweep` | Run SLA/escalation sweep immediately (`tasks.manage-any`). | [`TasksController.sweep`](../apps/api/src/modules/tasks/tasks.module.ts#L310) |

Further lifecycle and access rules: [`MODULE-3-TASKS.md`](MODULE-3-TASKS.md).

## Administration

API prefix: `/api/v1/admin`.

### Backend files

- [`administration.module.ts`](../apps/api/src/modules/administration/administration.module.ts) — module descriptor and controller/routes.
- [`users.service.ts`](../apps/api/src/modules/administration/users.service.ts) — user administration and dashboard assignment.
- [`roles.service.ts`](../apps/api/src/modules/administration/roles.service.ts) — roles, permission catalogue and role holders.
- [`departments.service.ts`](../apps/api/src/modules/administration/departments.service.ts) — department hierarchy and managers.
- [`signup.service.ts`](../apps/api/src/modules/administration/signup.service.ts) — public requests and admin decisions.
- [`permissions.ts`](../apps/api/src/modules/administration/permissions.ts) — administration permission keys.
- [`guards.ts`](../apps/api/src/modules/administration/guards.ts) — module-specific guard helpers.
- [`dto.ts`](../apps/api/src/modules/administration/dto.ts) — request validation types.
- [`signup-mail.ts`](../apps/api/src/modules/administration/signup-mail.ts) — account-request email composition.

### Web pages

`People.tsx`, `Departments.tsx`, `Roles.tsx`, `Signups.tsx` and public
`Signup.tsx`. Their routes are listed in the [Web route map](#web-route-map).

### Web-to-API call map

- [`Signup.tsx`](../apps/web/src/pages/Signup.tsx) uses the public signup
  department and create-request endpoints; [`Signups.tsx`](../apps/web/src/pages/Signups.tsx)
  uses pending/decided/approve/reject.
- [`People.tsx`](../apps/web/src/pages/People.tsx) uses user, role, department
  and dashboard-assignment routes.
- [`Departments.tsx`](../apps/web/src/pages/Departments.tsx) uses department
  overview/candidate/manager routes.
- [`Roles.tsx`](../apps/web/src/pages/Roles.tsx) uses role and permission
  catalogue/update routes.
- All four pages call `AdministrationController` in
  [`administration.module.ts`](../apps/api/src/modules/administration/administration.module.ts).
  The matching route row below links to the exact controller method.

### Routes

Handlers are in [`administration.module.ts`](../apps/api/src/modules/administration/administration.module.ts).
Public routes are identified below; other routes require their listed
administration permission.

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/admin/signup/departments` | Public department picker for signup. | [`AdministrationController.signupDepartments`](../apps/api/src/modules/administration/administration.module.ts#L139) |
| POST | `/api/v1/admin/signup` | Public account request; approval is required before account creation. | [`AdministrationController.requestAccount`](../apps/api/src/modules/administration/administration.module.ts#L142) |
| GET | `/api/v1/admin/signup/pending` | List signup requests awaiting review (`core.signup.review`). | [`AdministrationController.pendingSignups`](../apps/api/src/modules/administration/administration.module.ts#L147) |
| GET | `/api/v1/admin/signup/decided` | List approved/rejected signup requests (`core.signup.review`). | [`AdministrationController.decidedSignups`](../apps/api/src/modules/administration/administration.module.ts#L151) |
| POST | `/api/v1/admin/signup/:id/approve` | Approve signup and create the account (`core.signup.review`). | [`AdministrationController.approveSignup`](../apps/api/src/modules/administration/administration.module.ts#L155) |
| POST | `/api/v1/admin/signup/:id/reject` | Reject signup with reason (`core.signup.review`). | [`AdministrationController.rejectSignup`](../apps/api/src/modules/administration/administration.module.ts#L162) |
| GET | `/api/v1/admin/users` | Search/list users (`core.user.manage`). | [`AdministrationController.listUsers`](../apps/api/src/modules/administration/administration.module.ts#L172) |
| GET | `/api/v1/admin/users/:id` | User detail (`core.user.manage`). | [`AdministrationController.getUser`](../apps/api/src/modules/administration/administration.module.ts#L176) |
| POST | `/api/v1/admin/users` | Create user (`core.user.manage`). | [`AdministrationController.createUser`](../apps/api/src/modules/administration/administration.module.ts#L180) |
| PATCH | `/api/v1/admin/users/:id` | Update profile, department, status and roles (`core.user.manage`). | [`AdministrationController.updateUser`](../apps/api/src/modules/administration/administration.module.ts#L188) |
| POST | `/api/v1/admin/users/:id/password` | Set password (`core.user.manage`). | [`AdministrationController.setPassword`](../apps/api/src/modules/administration/administration.module.ts#L196) |
| PUT | `/api/v1/admin/users/:id/dashboards` | Replace individual dashboard assignments (`core.user.manage`). | [`AdministrationController.setDashboards`](../apps/api/src/modules/administration/administration.module.ts#L202) |
| DELETE | `/api/v1/admin/users/:id` | Deactivate/remove user (`core.user.manage`). | [`AdministrationController.removeUser`](../apps/api/src/modules/administration/administration.module.ts#L208) |
| GET | `/api/v1/admin/departments` | Department list for user administration (`core.user.manage`). | [`AdministrationController.departments`](../apps/api/src/modules/administration/administration.module.ts#L216) |
| GET | `/api/v1/admin/dashboards` | Dashboard catalogue for user assignment (`core.user.manage`). | [`AdministrationController.dashboards`](../apps/api/src/modules/administration/administration.module.ts#L220) |
| GET | `/api/v1/admin/departments/overview` | Department hierarchy and manager overview (`core.user.manage`). | [`AdministrationController.departmentOverview`](../apps/api/src/modules/administration/administration.module.ts#L226) |
| POST | `/api/v1/admin/departments` | Create a department (`core.user.manage`). | [`AdministrationController.createDepartment`](../apps/api/src/modules/administration/administration.module.ts#L230) |
| GET | `/api/v1/admin/departments/:id/candidates` | Candidate managers for a department (`core.user.manage`). | [`AdministrationController.departmentCandidates`](../apps/api/src/modules/administration/administration.module.ts#L236) |
| POST | `/api/v1/admin/departments/:id/managers` | Add a department manager (`core.user.manage`). | [`AdministrationController.addManager`](../apps/api/src/modules/administration/administration.module.ts#L242) |
| DELETE | `/api/v1/admin/departments/:id/managers/:userId` | Remove a department manager (`core.user.manage`). | [`AdministrationController.removeManager`](../apps/api/src/modules/administration/administration.module.ts#L249) |
| GET | `/api/v1/admin/roles` | List roles (`core.role.manage` or `core.user.manage`). | [`AdministrationController.listRoles`](../apps/api/src/modules/administration/administration.module.ts#L260) |
| GET | `/api/v1/admin/roles/:id` | Role detail (`core.role.manage` or `core.user.manage`). | [`AdministrationController.getRole`](../apps/api/src/modules/administration/administration.module.ts#L264) |
| GET | `/api/v1/admin/roles/:id/holders` | Users holding a role (`core.role.manage` or `core.user.manage`). | [`AdministrationController.roleHolders`](../apps/api/src/modules/administration/administration.module.ts#L268) |
| GET | `/api/v1/admin/permissions` | Permission catalogue (`core.role.manage` or `core.user.manage`). | [`AdministrationController.permissions`](../apps/api/src/modules/administration/administration.module.ts#L274) |
| POST | `/api/v1/admin/roles` | Create a role (`core.role.manage`). | [`AdministrationController.createRole`](../apps/api/src/modules/administration/administration.module.ts#L278) |
| PATCH | `/api/v1/admin/roles/:id` | Update role metadata (`core.role.manage`). | [`AdministrationController.updateRole`](../apps/api/src/modules/administration/administration.module.ts#L284) |
| PUT | `/api/v1/admin/roles/:id/permissions` | Replace permissions granted by a role (`core.role.manage`). | [`AdministrationController.setRolePermissions`](../apps/api/src/modules/administration/administration.module.ts#L290) |
| DELETE | `/api/v1/admin/roles/:id` | Delete a role (`core.role.manage`). | [`AdministrationController.removeRole`](../apps/api/src/modules/administration/administration.module.ts#L296) |

More on the access model: [`ADMINISTRATION.md`](ADMINISTRATION.md).

## Announcements / Company News

API prefix: `/api/v1/news`.

### Backend files

- [`announcements.module.ts`](../apps/api/src/modules/announcements/announcements.module.ts) — module descriptor and all routes.
- [`announcements.service.ts`](../apps/api/src/modules/announcements/announcements.service.ts) — announcement lifecycle, images, comments, reactions and notifications.
- [`dto.ts`](../apps/api/src/modules/announcements/dto.ts) — request DTOs.
- `CoreModule` provides object storage and notifications.

### Web pages and components

`News.tsx` (board and detail), `NewsManage.tsx` (management view),
`NoticeComposer.tsx` (draft and image upload), `Noticereactions.tsx` (reactions),
and `portlets/CompanyNews.tsx` (home feed).

### Web-to-API call map

- [`News.tsx`](../apps/web/src/pages/News.tsx) reads the live list/details and
  sends comment/reaction actions; [`Noticereactions.tsx`](../apps/web/src/components/Noticereactions.tsx)
  sends the reaction request.
- [`NewsManage.tsx`](../apps/web/src/pages/NewsManage.tsx) lists
  drafts/published/archived notices and performs publish/archive/edit/delete
  actions.
- [`NoticeComposer.tsx`](../apps/web/src/components/NoticeComposer.tsx)
  creates drafts and performs image upload-ticket, direct-upload, confirm and
  reorder calls.
- [`CompanyNews.tsx`](../apps/web/src/portlets/CompanyNews.tsx) reads
  `/news/live`.
- These browser calls are handled by
  [`AnnouncementsController`](../apps/api/src/modules/announcements/announcements.module.ts).
  Search the route path below for the exact method link.

### Routes

Handlers are in [`announcements.module.ts`](../apps/api/src/modules/announcements/announcements.module.ts).
Reading and participation require authentication; writing/publishing requires
`announcements.manage` except where noted in the handler.

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/news/live?limit=` | Live announcements for the home portlet. | [`AnnouncementsController.live`](../apps/api/src/modules/announcements/announcements.module.ts#L65) |
| GET | `/api/v1/news?limit=&offset=&status=` | List announcements; status supports management views. | [`AnnouncementsController.list`](../apps/api/src/modules/announcements/announcements.module.ts#L70) |
| GET | `/api/v1/news/:id` | Announcement detail. | [`AnnouncementsController.get`](../apps/api/src/modules/announcements/announcements.module.ts#L75) |
| POST | `/api/v1/news` | Create a draft (`announcements.manage`). | [`AnnouncementsController.create`](../apps/api/src/modules/announcements/announcements.module.ts#L82) |
| PATCH | `/api/v1/news/:id` | Edit announcement (`announcements.manage`). | [`AnnouncementsController.update`](../apps/api/src/modules/announcements/announcements.module.ts#L88) |
| POST | `/api/v1/news/:id/publish` | Publish announcement and notify employees (`announcements.manage`). | [`AnnouncementsController.publish`](../apps/api/src/modules/announcements/announcements.module.ts#L96) |
| POST | `/api/v1/news/:id/archive` | Archive announcement (`announcements.manage`). | [`AnnouncementsController.archive`](../apps/api/src/modules/announcements/announcements.module.ts#L102) |
| DELETE | `/api/v1/news/:id` | Remove announcement (`announcements.manage`). | [`AnnouncementsController.remove`](../apps/api/src/modules/announcements/announcements.module.ts#L108) |
| POST | `/api/v1/news/:id/images` | Request an image upload ticket (`announcements.manage`). | [`AnnouncementsController.requestUpload`](../apps/api/src/modules/announcements/announcements.module.ts#L116) |
| POST | `/api/v1/news/images/:imageId/confirm` | Validate/confirm an uploaded image (`announcements.manage`). | [`AnnouncementsController.confirmImage`](../apps/api/src/modules/announcements/announcements.module.ts#L123) |
| DELETE | `/api/v1/news/images/:imageId` | Remove an image (`announcements.manage`). | [`AnnouncementsController.removeImage`](../apps/api/src/modules/announcements/announcements.module.ts#L129) |
| POST | `/api/v1/news/:id/images/order` | Reorder announcement images (`announcements.manage`). | [`AnnouncementsController.reorder`](../apps/api/src/modules/announcements/announcements.module.ts#L135) |
| GET | `/api/v1/news/:id/comments` | List comments. | [`AnnouncementsController.comments`](../apps/api/src/modules/announcements/announcements.module.ts#L146) |
| POST | `/api/v1/news/:id/reactions` | Add/change a reaction. | [`AnnouncementsController.react`](../apps/api/src/modules/announcements/announcements.module.ts#L152) |
| POST | `/api/v1/news/:id/comments` | Add a comment. | [`AnnouncementsController.comment`](../apps/api/src/modules/announcements/announcements.module.ts#L159) |
| DELETE | `/api/v1/news/comments/:commentId` | Remove a comment; service checks whether caller may remove it. | [`AnnouncementsController.removeComment`](../apps/api/src/modules/announcements/announcements.module.ts#L165) |

## Warehouse

API prefix: `/api/v1/warehouse`.

### Backend files

- [`index.ts`](../apps/api/src/modules/warehouse/index.ts) — module descriptor, the `WarehouseController`, route handlers and dependency wiring.
- [`transactions.service.ts`](../apps/api/src/modules/warehouse/transactions.service.ts) — stock movement validation and posting.
- [`orders.service.ts`](../apps/api/src/modules/warehouse/orders.service.ts) — Shopify order lookup, patch posting and printable order template.
- [`items.service.ts`](../apps/api/src/modules/warehouse/items.service.ts) — catalogue options, item preview and creation.
- [`approvals.service.ts`](../apps/api/src/modules/warehouse/approvals.service.ts) — movement row change approvals.
- [`dashboard.service.ts`](../apps/api/src/modules/warehouse/dashboard.service.ts) — dashboard tiles/charts and low stock.
- [`insights.service.ts`](../apps/api/src/modules/warehouse/insights.service.ts) — warehouse, item, collection and run-out insights.
- [`reports.service.ts`](../apps/api/src/modules/warehouse/reports.service.ts) — date-range sales/returns reports.
- [`costing.service.ts`](../apps/api/src/modules/warehouse/costing.service.ts) — costs, settings and demand planning.
- [`returns.service.ts`](../apps/api/src/modules/warehouse/returns.service.ts) — return issues and patch comments/status.
- [`qc.service.ts`](../apps/api/src/modules/warehouse/qc.service.ts) — quality-check lifecycle and hand-back.
- [`rolls.service.ts`](../apps/api/src/modules/warehouse/rolls.service.ts) — fabric rolls and job orders.
- [`stages.service.ts`](../apps/api/src/modules/warehouse/stages.service.ts) — cutting/production/quality stages.
- [`documents.service.ts`](../apps/api/src/modules/warehouse/documents.service.ts) — printable warehouse documents, serials and labels.
- [`attachments.service.ts`](../apps/api/src/modules/warehouse/attachments.service.ts) — warehouse image/PDF uploads.
- `sheets/tabs.ts` — spreadsheet tab names, column indexes and expected headers.
- `sheets/warehouse-sheet.client.ts` — Google Sheets reads/writes.
- `sheets/warehouse-reader.service.ts` — cached catalogue, stock balances and movement reads.
- `sheets/warehouse-queue.service.ts` — durable sheet write queue and health.
- `sheets/warehouse-worker.ts` — drains queued sheet writes.
- `sheets/parse-date.ts` — warehouse sheet date parsing.

### Web pages and components

- `WarehouseDashboard.tsx` — stock dashboard, tiles, charts and sheet status.
- `WarehousePost.tsx` — receiving/transfer/return stock movement form.
- `WarehouseNewOrders.tsx` — lookup Shopify orders and save a patch.
- `WarehouseTemplates.tsx` — printable patch/document views.
- `WarehouseItems.tsx` — catalogue, item card/search and create item.
- `WarehouseApprovals.tsx` — approve movement edits/deletions.
- `WarehouseRolls.tsx` — roll/job/stage workflow.
- `WarehouseQc.tsx` — quality-check workflow.
- `WarehouseReturns.tsx` — return issues and patch log/comments/status.
- `WarehouseLabels.tsx` — item labels and documents.
- `WarehousePlanning.tsx` — costs/settings/demand.
- `WarehouseInsights.tsx` — warehouse/item/collection/run-out insight pages.
- `WarehouseReports.tsx` — report date ranges and results.
- `WarehouseFiles.tsx` — files attached to a return issue or movement.

### Web-to-API call map

- [`WarehousePost.tsx`](../apps/web/src/pages/WarehousePost.tsx) reads movement
  types, serial, warehouses, items and balances, then posts a movement.
- [`WarehouseNewOrders.tsx`](../apps/web/src/pages/WarehouseNewOrders.tsx)
  reads next patch, looks up Shopify orders and posts the whole patch.
- [`WarehouseItems.tsx`](../apps/web/src/pages/WarehouseItems.tsx) reads the
  catalogue/balances/movements and calls item options/preview/create.
- [`WarehouseDashboard.tsx`](../apps/web/src/pages/WarehouseDashboard.tsx)
  calls dashboard tiles/charts, warehouses and sheet status;
  [`WarehouseInsights.tsx`](../apps/web/src/pages/WarehouseInsights.tsx) calls
  item/warehouse/collection/run-out insight endpoints.
- [`WarehouseApprovals.tsx`](../apps/web/src/pages/WarehouseApprovals.tsx)
  lists and decides approvals.
- [`WarehouseRolls.tsx`](../apps/web/src/pages/WarehouseRolls.tsx) calls
  roll/job/batch/stage routes; [`WarehouseQc.tsx`](../apps/web/src/pages/WarehouseQc.tsx)
  calls quality lifecycle routes.
- [`WarehouseReturns.tsx`](../apps/web/src/pages/WarehouseReturns.tsx) calls
  return-issue and patch-log routes.
- [`WarehouseLabels.tsx`](../apps/web/src/pages/WarehouseLabels.tsx) reads
  items/documents and requests label data;
  [`WarehouseTemplates.tsx`](../apps/web/src/pages/WarehouseTemplates.tsx)
  reads patch templates and reserves/records printed documents.
- [`WarehousePlanning.tsx`](../apps/web/src/pages/WarehousePlanning.tsx)
  reads/updates costs and settings and reads demand;
  [`WarehouseReports.tsx`](../apps/web/src/pages/WarehouseReports.tsx) reads
  presets and report data.
- [`WarehouseFiles.tsx`](../apps/web/src/components/WarehouseFiles.tsx)
  requests an upload ticket, uploads bytes directly to storage, confirms the
  file and refreshes the attachment list.
- All `/warehouse/*` calls above are handled by
  [`WarehouseController`](../apps/api/src/modules/warehouse/index.ts). Each
  route below links to the exact `WarehouseController.method()` in that file.

### Reports, orders, stock and attachments

Handlers are in [`warehouse/index.ts`](../apps/api/src/modules/warehouse/index.ts).

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/warehouse/reports/presets` | Common report date ranges. | [`WarehouseController.reportPresets`](../apps/api/src/modules/warehouse/index.ts#L167) |
| GET | `/api/v1/warehouse/reports?from=&to=&fresh=` | Build a warehouse sales/return report. | [`WarehouseController.report`](../apps/api/src/modules/warehouse/index.ts#L172) |
| GET | `/api/v1/warehouse/orders/next-patch` | Compute the next new-order patch number. | [`WarehouseController.nextPatch`](../apps/api/src/modules/warehouse/index.ts#L181) |
| GET | `/api/v1/warehouse/orders/lookup?reference=` | Resolve a Shopify order and match its lines to warehouse items/stock. | [`WarehouseController.lookupOrder`](../apps/api/src/modules/warehouse/index.ts#L191) |
| POST | `/api/v1/warehouse/orders/patch` | Validate and queue all orders on one patch. | [`WarehouseController.postPatch`](../apps/api/src/modules/warehouse/index.ts#L198) |
| GET | `/api/v1/warehouse/orders/template?patch=` | Printable order template for a patch. | [`WarehouseController.orderTemplate`](../apps/api/src/modules/warehouse/index.ts#L205) |
| GET | `/api/v1/warehouse/stock/behind?band=` | Items running low or out of stock. | [`WarehouseController.itemsBehind`](../apps/api/src/modules/warehouse/index.ts#L227) |
| GET | `/api/v1/warehouse/attachments/:kind/:subjectId` | List confirmed files on a return issue or movement. | [`WarehouseController.attachments`](../apps/api/src/modules/warehouse/index.ts#L242) |
| POST | `/api/v1/warehouse/attachments/:kind/:subjectId` | Request a file upload ticket. | [`WarehouseController.attachmentUpload`](../apps/api/src/modules/warehouse/index.ts#L252) |
| POST | `/api/v1/warehouse/attachments/file/:fileId/confirm` | Validate and confirm uploaded bytes. | [`WarehouseController.attachmentConfirm`](../apps/api/src/modules/warehouse/index.ts#L271) |
| DELETE | `/api/v1/warehouse/attachments/file/:fileId` | Remove a file uploaded by the caller. | [`WarehouseController.attachmentRemove`](../apps/api/src/modules/warehouse/index.ts#L277) |
| GET | `/api/v1/warehouse/sheet-status` | Counts queued/failed writes and reports sheet mode. | [`WarehouseController.sheetStatus`](../apps/api/src/modules/warehouse/index.ts#L290) |

### Cost, planning, documents and returns

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/warehouse/settings` | Read production/costing settings. | [`WarehouseController.settings`](../apps/api/src/modules/warehouse/index.ts#L309) |
| POST | `/api/v1/warehouse/settings` | Update settings. | [`WarehouseController.setSettings`](../apps/api/src/modules/warehouse/index.ts#L317) |
| GET | `/api/v1/warehouse/costs` | Read item cost table. | [`WarehouseController.costs`](../apps/api/src/modules/warehouse/index.ts#L323) |
| POST | `/api/v1/warehouse/costs` | Update item costs. | [`WarehouseController.setCosts`](../apps/api/src/modules/warehouse/index.ts#L327) |
| GET | `/api/v1/warehouse/costs/report?month=` | Monthly cost vs sales report. | [`WarehouseController.costReport`](../apps/api/src/modules/warehouse/index.ts#L334) |
| GET | `/api/v1/warehouse/demand?weeks=` | Demand/production planning from sales history. | [`WarehouseController.demand`](../apps/api/src/modules/warehouse/index.ts#L341) |
| POST | `/api/v1/warehouse/labels` | Return label data for browser rendering. | [`WarehouseController.labels`](../apps/api/src/modules/warehouse/index.ts#L350) |
| GET | `/api/v1/warehouse/documents?type=` | List printable document records. | [`WarehouseController.documents`](../apps/api/src/modules/warehouse/index.ts#L356) |
| POST | `/api/v1/warehouse/documents/reserve` | Reserve the next serial before printing. | [`WarehouseController.reserveDoc`](../apps/api/src/modules/warehouse/index.ts#L369) |
| POST | `/api/v1/warehouse/documents/printed` | Record that a reserved document was printed. | [`WarehouseController.recordPrint`](../apps/api/src/modules/warehouse/index.ts#L375) |
| GET | `/api/v1/warehouse/documents/handovers?operationOrder=` | List workshop handover documents. | [`WarehouseController.handovers`](../apps/api/src/modules/warehouse/index.ts#L381) |
| GET | `/api/v1/warehouse/returns?status=&q=` | Search/list return issues. | [`WarehouseController.issues`](../apps/api/src/modules/warehouse/index.ts#L389) |
| GET | `/api/v1/warehouse/returns/count` | Count open return issues. | [`WarehouseController.openIssues`](../apps/api/src/modules/warehouse/index.ts#L396) |
| POST | `/api/v1/warehouse/returns` | Log a return issue. | [`WarehouseController.logIssue`](../apps/api/src/modules/warehouse/index.ts#L400) |
| POST | `/api/v1/warehouse/returns/update` | Update/resolve a return issue. | [`WarehouseController.updateIssue`](../apps/api/src/modules/warehouse/index.ts#L406) |
| GET | `/api/v1/warehouse/patches?status=` | List patch records. | [`WarehouseController.patches`](../apps/api/src/modules/warehouse/index.ts#L414) |
| GET | `/api/v1/warehouse/patches/:patch/comments` | Read patch comments. | [`WarehouseController.patchComments`](../apps/api/src/modules/warehouse/index.ts#L420) |
| POST | `/api/v1/warehouse/patches/comment` | Add a patch comment. | [`WarehouseController.patchComment`](../apps/api/src/modules/warehouse/index.ts#L426) |
| POST | `/api/v1/warehouse/patches/status` | Open or close a patch. | [`WarehouseController.patchStatus`](../apps/api/src/modules/warehouse/index.ts#L433) |

### Quality, workshop, rolls and insights

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/warehouse/qc?cycle=` | List quality batches for a Q.C/W.Q cycle. | [`WarehouseController.qcBatches`](../apps/api/src/modules/warehouse/index.ts#L448) |
| GET | `/api/v1/warehouse/qc/:serial` | Quality batch detail. | [`WarehouseController.qcBatch`](../apps/api/src/modules/warehouse/index.ts#L455) |
| POST | `/api/v1/warehouse/qc/receive` | Record that quality received a batch. | [`WarehouseController.qcReceive`](../apps/api/src/modules/warehouse/index.ts#L462) |
| POST | `/api/v1/warehouse/qc/hand-back` | Record counted hand-back; does not yet move stock. | [`WarehouseController.qcHandBack`](../apps/api/src/modules/warehouse/index.ts#L469) |
| POST | `/api/v1/warehouse/qc/recall` | Recall a hand-back round. | [`WarehouseController.qcRecall`](../apps/api/src/modules/warehouse/index.ts#L475) |
| POST | `/api/v1/warehouse/qc/confirm` | Warehouse confirms the count and moves stock. | [`WarehouseController.qcConfirm`](../apps/api/src/modules/warehouse/index.ts#L486) |
| POST | `/api/v1/warehouse/qc/acknowledge` | Manager acknowledges a quantity difference. | [`WarehouseController.qcAcknowledge`](../apps/api/src/modules/warehouse/index.ts#L499) |
| POST | `/api/v1/warehouse/qc/short` | Mark a quality batch short. | [`WarehouseController.qcShort`](../apps/api/src/modules/warehouse/index.ts#L508) |
| GET | `/api/v1/warehouse/rolls/jobs/:oo/stages` | Stage overview for one operation order. | [`WarehouseController.stageOverview`](../apps/api/src/modules/warehouse/index.ts#L517) |
| POST | `/api/v1/warehouse/stages/cut/start` | Start cutting. | [`WarehouseController.startCutting`](../apps/api/src/modules/warehouse/index.ts#L523) |
| POST | `/api/v1/warehouse/stages/cut/lot` | Release a cutting lot. | [`WarehouseController.releaseLot`](../apps/api/src/modules/warehouse/index.ts#L529) |
| POST | `/api/v1/warehouse/stages/cut/end` | Finish cutting. | [`WarehouseController.endCutting`](../apps/api/src/modules/warehouse/index.ts#L535) |
| POST | `/api/v1/warehouse/stages/production/send` | Send production to quality. | [`WarehouseController.sendToQuality`](../apps/api/src/modules/warehouse/index.ts#L541) |
| POST | `/api/v1/warehouse/stages/quality/count` | Record workshop quality count. | [`WarehouseController.countLot`](../apps/api/src/modules/warehouse/index.ts#L548) |
| POST | `/api/v1/warehouse/stages/quality/handover` | Record quality handover. | [`WarehouseController.handOver`](../apps/api/src/modules/warehouse/index.ts#L554) |
| GET | `/api/v1/warehouse/rolls?status=&operationOrder=` | List fabric rolls. | [`WarehouseController.rollsList`](../apps/api/src/modules/warehouse/index.ts#L562) |
| GET | `/api/v1/warehouse/rolls/jobs?status=` | List roll job orders. | [`WarehouseController.jobOrders`](../apps/api/src/modules/warehouse/index.ts#L568) |
| GET | `/api/v1/warehouse/rolls/jobs/:oo/batches` | List batches for an operation order. | [`WarehouseController.batches`](../apps/api/src/modules/warehouse/index.ts#L574) |
| POST | `/api/v1/warehouse/rolls/receive` | Receive one or more rolls. | [`WarehouseController.receiveRoll`](../apps/api/src/modules/warehouse/index.ts#L583) |
| POST | `/api/v1/warehouse/rolls/plan` | Plan rolls against a job. | [`WarehouseController.planRoll`](../apps/api/src/modules/warehouse/index.ts#L589) |
| POST | `/api/v1/warehouse/rolls/issue` | Issue rolls to workshop. | [`WarehouseController.issueRolls`](../apps/api/src/modules/warehouse/index.ts#L595) |
| POST | `/api/v1/warehouse/rolls/report` | Report production output. | [`WarehouseController.reportProduction`](../apps/api/src/modules/warehouse/index.ts#L602) |
| POST | `/api/v1/warehouse/rolls/receive-batch` | Receive a production batch. | [`WarehouseController.receiveBatch`](../apps/api/src/modules/warehouse/index.ts#L608) |
| POST | `/api/v1/warehouse/rolls/close` | Close an operation order. | [`WarehouseController.closeJob`](../apps/api/src/modules/warehouse/index.ts#L615) |
| GET | `/api/v1/warehouse/dashboard/warehouses/:code` | Inventory breakdown for one warehouse. | [`WarehouseController.warehouseInventory`](../apps/api/src/modules/warehouse/index.ts#L625) |
| GET | `/api/v1/warehouse/dashboard/warehouses` | Warehouse comparison/details. | [`WarehouseController.warehouseDetail`](../apps/api/src/modules/warehouse/index.ts#L631) |
| GET | `/api/v1/warehouse/dashboard/find?item=` | Find one item across warehouses. | [`WarehouseController.findItem`](../apps/api/src/modules/warehouse/index.ts#L636) |
| GET | `/api/v1/warehouse/dashboard/run-out` | Forecast how long sellable stock lasts. | [`WarehouseController.runOut`](../apps/api/src/modules/warehouse/index.ts#L646) |
| GET | `/api/v1/warehouse/dashboard/collections?warehouse=` | Stock totals by collection. | [`WarehouseController.collections`](../apps/api/src/modules/warehouse/index.ts#L651) |
| GET | `/api/v1/warehouse/dashboard/defects` | Items with most stock in the defects warehouse. | [`WarehouseController.defects`](../apps/api/src/modules/warehouse/index.ts#L658) |

### Items, dashboard, stock movements and approvals

| Method | Endpoint | Purpose | API handler (source) |
| --- | --- | --- | --- |
| GET | `/api/v1/warehouse/items/options` | Item-create pickers: Keys-tab mappings plus already-used catalogue values. | [`WarehouseController.itemOptions`](../apps/api/src/modules/warehouse/index.ts#L665) |
| POST | `/api/v1/warehouse/items/preview` | Preview the sheet-generated item name/code without creating it. | [`WarehouseController.previewItem`](../apps/api/src/modules/warehouse/index.ts#L670) |
| POST | `/api/v1/warehouse/items` | Queue creation of a catalogue item. | [`WarehouseController.createItem`](../apps/api/src/modules/warehouse/index.ts#L674) |
| GET | `/api/v1/warehouse/dashboard/tiles` | Dashboard stock tiles and negative balances. | [`WarehouseController.tiles`](../apps/api/src/modules/warehouse/index.ts#L683) |
| GET | `/api/v1/warehouse/dashboard/charts?warehouse=` | Movement trend, warehouse/location stock and low-stock chart data. | [`WarehouseController.charts`](../apps/api/src/modules/warehouse/index.ts#L693) |
| GET | `/api/v1/warehouse/items` | Read item catalogue. | [`WarehouseController.items`](../apps/api/src/modules/warehouse/index.ts#L708) |
| GET | `/api/v1/warehouse/warehouses` | Warehouse/location catalogue. | [`WarehouseController.warehouses`](../apps/api/src/modules/warehouse/index.ts#L713) |
| GET | `/api/v1/warehouse/types` | Movement types and required fields. | [`WarehouseController.types`](../apps/api/src/modules/warehouse/index.ts#L718) |
| GET | `/api/v1/warehouse/next-serial?type=` | Next serial for a movement form. | [`WarehouseController.nextSerial`](../apps/api/src/modules/warehouse/index.ts#L723) |
| GET | `/api/v1/warehouse/coding` | Color/kind/material code maps. | [`WarehouseController.coding`](../apps/api/src/modules/warehouse/index.ts#L728) |
| GET | `/api/v1/warehouse/balances` | Current balances by item/location. | [`WarehouseController.balances`](../apps/api/src/modules/warehouse/index.ts#L734) |
| GET | `/api/v1/warehouse/item/:name/balances` | All balances for one item. | [`WarehouseController.itemBalances`](../apps/api/src/modules/warehouse/index.ts#L739) |
| GET | `/api/v1/warehouse/movements?item=&warehouse=&kind=&order=&patch=&limit=` | Filter recent ledger movements. | [`WarehouseController.movements`](../apps/api/src/modules/warehouse/index.ts#L745) |
| POST | `/api/v1/warehouse/post` | Validate and queue a stock movement. | [`WarehouseController.post`](../apps/api/src/modules/warehouse/index.ts#L768) |
| POST | `/api/v1/warehouse/approvals` | Request a ledger row edit/deletion. | [`WarehouseController.requestChange`](../apps/api/src/modules/warehouse/index.ts#L785) |
| GET | `/api/v1/warehouse/approvals` | List pending changes (`warehouse.approval.decide`). | [`WarehouseController.pendingApprovals`](../apps/api/src/modules/warehouse/index.ts#L796) |
| POST | `/api/v1/warehouse/approvals/:id/decide` | Approve/reject a requested change. | [`WarehouseController.decide`](../apps/api/src/modules/warehouse/index.ts#L800) |
| GET | `/api/v1/warehouse/sheet/health` | Inspect warehouse sheet queue and dead events. | [`WarehouseController.sheetHealth`](../apps/api/src/modules/warehouse/index.ts#L816) |
| POST | `/api/v1/warehouse/sheet/refresh` | Invalidate cached sheet reads. | [`WarehouseController.refresh`](../apps/api/src/modules/warehouse/index.ts#L821) |

## Route and file maintenance

- A route exists only when its module is imported in `app.module.ts` and a
  controller is registered by that module.
- Use the `@Controller()` prefix plus the method decorator path to reconstruct
  a route. Then include the global `/api/v1` prefix.
- Keep each module's route table and file inventory next to its source links.
- If a route is added or changed, update the endpoint table and the web caller
  map. If it is external ingress, document the external caller and signature
  verification instead of inventing a browser page.
- Related design documents already in this repository:
  - [`MODULE-1-BOOKING.md`](MODULE-1-BOOKING.md) — Meeting Rooms.
  - [`docs-WOROOD-HUB-Module-2-Sales-Dashboard.md`](docs-WOROOD-HUB-Module-2-Sales-Dashboard.md),
    [`Sales dashboard reference.md`](Sales%20dashboard%20reference.md) and
    [`Shopify integration report.md`](Shopify%20integration%20report.md) — Sales/Shopify.
  - [`MODULE-3-TASKS.md`](MODULE-3-TASKS.md) — Tasks & Tickets.
  - [`ADMINISTRATION.md`](ADMINISTRATION.md) — Administration and access.
