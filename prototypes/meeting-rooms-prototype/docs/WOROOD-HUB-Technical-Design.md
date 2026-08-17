# WOROOD HUB — Technical Design Document

**Module 1: Meeting Room Reservation System**
Version 1.0 · 9 August 2026 · Prepared for Worood Technology

---

## 1. Purpose and scope

WOROOD HUB is an enterprise intranet portal for Worood employees. It is deliberately not built as a single meeting-room application that later grows extra features; it is built as a small platform with one module installed. The Meeting Room Reservation System is that first module, and the way it plugs in is the template every future module follows — leave requests, help desk, document library, asset booking, announcements.

This document covers the recommended technology stack, the database structure, the application architecture, the AWS EC2 requirements, and the security and operational model. It reflects a working prototype that has been built and verified end to end, not a paper design: the schema, the API, the portal and the deployment scripts described here all exist and run.

The functional scope of module 1 is: employees can view meeting rooms with their name, capacity, location and equipment; check availability by date and time; reserve a room; see upcoming and previous reservations; cancel or modify their own bookings; and the system must make double booking impossible. Facilities staff can additionally manage the room catalogue and adjust booking policy per room.

---

## 2. Recommended technology stack

### 2.1 Summary

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node.js (LTS) | 22.x |
| Language | TypeScript | 5.7 |
| API framework | NestJS | 10.x |
| Data access | Drizzle ORM over `node-postgres` | 0.45 |
| Database | PostgreSQL | 16 |
| Frontend | React + Vite | 18 / 6 |
| Client data layer | TanStack Query | 5.x |
| Routing | React Router | 6.x |
| Authentication | JWT access token + rotating refresh token, bcrypt password hashing | — |
| Web server | nginx (TLS termination, static assets, reverse proxy) | 1.24+ |
| Process supervision | systemd | — |
| API documentation | OpenAPI via `@nestjs/swagger` | — |

### 2.2 Why this stack

**One language across the whole system.** TypeScript on both sides means the shape of a reservation is defined once and shared. A developer moving between the availability calculation and the booking screen is not switching mental models, which matters a great deal on a small team maintaining many modules.

**NestJS gives the platform its shape for free.** The requirement that new modules must be addable "without major changes to the existing system" is fundamentally a dependency-management problem. NestJS's module system, dependency injection and guards make that structural rather than aspirational: each feature module is a self-contained unit with its own controllers, services and permissions, wired into the application root with two lines. Express alone would work, but the discipline would have to be invented and then defended in code review forever.

**PostgreSQL is doing real work here, not just storing rows.** The single hardest requirement in this module is preventing double bookings, and PostgreSQL solves it properly with a GiST exclusion constraint over a time range. Section 4.3 explains this in detail. That capability, plus range types, `citext`, JSONB for module settings, and mature timezone handling, is the reason PostgreSQL is specified rather than MySQL.

**Drizzle rather than Prisma or TypeORM.** Drizzle is a thin, fully typed SQL builder with no native engine binary and no code-generation step. It compiles to plain SQL, which matters because parts of this schema — the exclusion constraint in particular — are expressed in DDL that heavier ORMs cannot model and would silently drop from a generated migration. It also starts fast and uses little memory, which suits a small EC2 instance. Migrations are hand-written SQL files applied by a 60-line runner, so what is in version control is exactly what runs against production.

**React with Vite, not a full-stack framework.** The portal is an authenticated internal application: there is no SEO requirement and no anonymous traffic, so server-side rendering buys nothing and costs operational complexity. Vite produces a static bundle that nginx serves directly, which means the Node process only ever handles API calls and stays small and predictable under load.

### 2.3 Alternatives considered

A Laravel or .NET Core stack would both deliver this module competently. Laravel was set aside because a second language would be introduced alongside the React frontend. .NET Core would be the stronger choice if Worood standardises on Microsoft infrastructure and Active Directory; if that changes, the architecture in this document ports almost unchanged, since the module boundaries and the database design are not framework-specific.

A serverless design (API Gateway plus Lambda plus RDS) was considered and rejected for this phase. At Worood's scale it costs more in operational complexity than it saves in money, and the requirement is explicitly to host on EC2.

---

## 3. Application architecture

### 3.1 Shape: a modular monolith

WOROOD HUB is a modular monolith. One deployable process, one database, but strict internal boundaries. This is the right choice at this size for a specific reason: microservices would put a network boundary between modules that will constantly need to reference the same employee directory, and would multiply the operational burden across a small team. The boundaries that matter — module ownership of tables, permissions and routes — are enforced by convention and code review, and they are the same boundaries that would later allow a module to be extracted into its own service if it ever earns that.

```
                        ┌─────────────────────────────────┐
   Browser  ───TLS───▶  │  nginx                          │
                        │   · static React bundle         │
                        │   · /api → 127.0.0.1:3000       │
                        └───────────────┬─────────────────┘
                                        │
                        ┌───────────────▼─────────────────┐
                        │  Node.js · NestJS               │
                        │                                 │
                        │  CORE PLATFORM                  │
                        │   auth · RBAC · users · audit   │
                        │   notifications · module registry│
                        │                                 │
                        │  FEATURE MODULES                │
                        │   ┌───────────────────────────┐ │
                        │   │ meeting-rooms  (mr_*)     │ │
                        │   ├───────────────────────────┤ │
                        │   │ leave-requests (lv_*)  ▸  │ │
                        │   │ help-desk      (hd_*)  ▸  │ │
                        │   │ documents      (dm_*)  ▸  │ │
                        │   └───────────────────────────┘ │
                        └───────────────┬─────────────────┘
                                        │
                        ┌───────────────▼─────────────────┐
                        │  PostgreSQL 16                  │
                        │   core_* tables · mr_* tables   │
                        └─────────────────────────────────┘
```

### 3.2 The core platform

The core owns everything shared. Authentication issues and rotates tokens. Role-based access control resolves a user's effective permissions as the union of the permissions attached to their roles. The user directory is the single source of truth for who employees are. The audit log is append-only and written to by every module. Notifications are stored per user and tagged with the module that raised them. Settings are stored as module-scoped JSONB rows, so a module can ship configuration without a schema change.

No feature module writes to a `core_*` table other than through the core's own services, and no core component imports from a feature module. That single rule is what keeps modules removable.

### 3.3 The module contract

Every feature module declares one descriptor, and the platform derives everything else from it. This is the extensibility mechanism, so it is worth showing in full:

```ts
export const MEETING_ROOMS_MODULE = registerHubModule({
  key: 'meeting-rooms',
  name: 'Meeting Rooms',
  nameAr: 'قاعات الاجتماعات',
  version: '1.0.0',
  apiPrefix: '/api/v1/meeting-rooms',
  tablePrefix: 'mr_',
  enabled: true,
  navigation: [
    { label: 'Book a Room',      path: '/meeting-rooms/book',   icon: 'search' },
    { label: 'Manage Rooms',     path: '/meeting-rooms/admin',  icon: 'settings',
      requiresAnyPermission: ['meeting-rooms.room.manage'] },
    /* … */
  ],
  portlets: [
    { key: 'next-meeting', title: 'My Next Meeting', width: 4, order: 10 },
    { key: 'free-now',     title: 'Free Right Now',  width: 4, order: 30 },
    /* … */
  ],
  permissions: [
    { key: 'meeting-rooms.room.manage', description: 'Create, edit and retire rooms' },
    /* … */
  ],
});
```

From that single declaration the platform produces the sidebar navigation, filtered per user by permission; the dashboard portlet grid and its default layout; the permission rows the RBAC seeder registers; and the response to `GET /api/v1/hub/modules`, which the portal shell reads on boot. The frontend has no hard-coded menu. This is verified by automated test: an ordinary employee's `/hub/modules` response omits the "Manage Rooms" entry, while an administrator's includes it.

### 3.4 Adding a future module

Adding, for example, a Leave Requests module means creating `src/modules/leave-requests/` with its own controllers and services, adding one SQL migration file that creates `lv_*` tables, adding the descriptor, and adding two lines to the application root module. Nothing in the meeting-rooms module, the core platform, or the portal shell is edited. The dashboard and navigation update themselves.

Because permission keys are namespaced by module, and because each module owns a table prefix, removing a module is equally clean: delete the folder, drop the prefix, remove the descriptor.

### 3.5 Request lifecycle

A request arriving at an API route passes through, in order: nginx (TLS, rate limiting on the login endpoint, proxy headers); the throttler guard; the JWT guard, which verifies the access token and attaches the principal with its roles and permissions; the permissions guard, which checks the route's declared permission keys against the principal; a validation pipe that rejects unknown or malformed fields outright; the controller; the service, which owns business rules; and Drizzle. Errors are normalised by a single exception filter into one JSON envelope, so the frontend has exactly one error shape to handle and internal details never reach the browser.

### 3.6 Business logic placement

Booking rules live in services, not controllers, and the pure arithmetic of availability lives in a dependency-free module (`services/slots.ts`) that has no knowledge of the database or the framework. That separation is deliberate: booking policy is the part of this module most likely to change as Worood's habits emerge, and pure functions are the cheapest thing in the system to change safely. They are covered by twenty unit tests.

---

## 4. Database structure

### 4.1 Conventions

Tables carry a prefix identifying their owner: `core_` for the platform, `mr_` for meeting rooms, and a new prefix per future module. Primary keys are UUIDs generated by `gen_random_uuid()`, which avoids leaking record counts and keeps future data merges painless. Every timestamp is `timestamptz` and stored in UTC; local office hours are interpreted against the site's IANA timezone at query time. `updated_at` is maintained by a database trigger rather than by application code, so it cannot drift. Records that carry history — users, rooms — are soft-deleted, because a retired room must still be readable from a two-year-old reservation.

### 4.2 Core platform tables

| Table | Purpose |
|---|---|
| `core_departments` | Self-referencing department tree |
| `core_users` | Employees: credentials, profile, status, lockout counters, timezone, locale |
| `core_roles` | Named roles (`employee`, `facilities`, `admin`) |
| `core_permissions` | Permission keys, each namespaced to its owning module |
| `core_role_permissions` | Role → permission grants |
| `core_user_roles` | User → role assignments |
| `core_refresh_tokens` | Hashed refresh tokens with device, IP, expiry and revocation |
| `core_audit_logs` | Append-only activity trail written by every module |
| `core_notifications` | Per-user in-app notifications, tagged by module |
| `core_settings` | Module-scoped JSONB configuration |
| `core_migrations` | Applied migrations with checksums |

### 4.3 Meeting Rooms tables

| Table | Purpose |
|---|---|
| `mr_locations` | Office sites and buildings, each with its own IANA timezone |
| `mr_equipment` | Equipment catalogue (projector, video conference, whiteboard, …) |
| `mr_rooms` | Rooms with capacity, floor, status and per-room booking policy |
| `mr_room_equipment` | Which equipment each room has, and how many |
| `mr_room_blackouts` | Maintenance windows and holidays; treated as busy |
| `mr_reservations` | Bookings, with the overlap-prevention constraint |
| `mr_reservation_attendees` | Internal employees or external guest e-mails |

Booking policy lives on the room row — opening and closing time, slot granularity, minimum and maximum duration, how far ahead the room can be booked, changeover buffer, and whether it needs approval. Facilities can tune these from the admin screen without a code change, which is the difference between a system that adapts to how Worood actually works and one that people work around.

### 4.4 The double-booking guarantee

This is the most important design decision in the module, so it is worth being precise about why the obvious approach fails.

The obvious approach is: query for conflicts, and if there are none, insert. Under any real concurrency this is a race. Two employees clicking "reserve" on the same slot within the same few milliseconds both run the check, both see an empty result, and both insert. Adding a transaction does not fix it, because at the default `READ COMMITTED` isolation level neither transaction can see the other's uncommitted row. Escalating to `SERIALIZABLE` would fix it but forces the application to handle serialisation failures everywhere and costs throughput across the whole system.

The correct answer is to make non-overlap an invariant of the database:

```sql
ALTER TABLE mr_reservations
  ADD CONSTRAINT mr_reservations_no_overlap
  EXCLUDE USING gist (
    room_id                                  WITH =,
    tstzrange(starts_at, ends_at, '[)')      WITH &&
  )
  WHERE (status IN ('PENDING', 'CONFIRMED'));
```

Two rows may not coexist if they share a `room_id` **and** their time ranges overlap. PostgreSQL enforces this through the index itself, so the second concurrent transaction is rejected regardless of ordering, timing, or how many application processes are running. Three details matter. The `'[)'` half-open range means a meeting ending at 10:00 and one starting at 10:00 do not clash, which is what people expect. The `WHERE` clause scopes the constraint to live bookings, so cancelling a reservation frees the room instantly with no cleanup. And the supporting GiST index is the same structure that accelerates the availability queries, so the guarantee costs nothing in read performance.

When the constraint fires, the API catches SQLSTATE `23P01`, looks up the reservation actually holding the slot, and returns HTTP 409 naming the conflicting meeting, its reference and its organiser — so the employee sees "already booked by Hala Mansour" rather than a generic failure.

This is verified rather than asserted. The end-to-end suite fires eight simultaneous booking requests at one slot from two different user sessions and asserts that exactly one succeeds and seven receive 409. It also asserts that a partially overlapping booking is rejected, that a back-to-back booking is accepted, and that a cancelled slot becomes immediately bookable by someone else.

### 4.5 Indexing

Beyond the primary keys and unique constraints, the indexes that matter are `(room_id, starts_at, ends_at)` on reservations for availability lookups, `(organizer_id, starts_at DESC)` for the "my reservations" screen, `(status, starts_at)` for administrative views, the GiST index backing the exclusion constraint, and partial indexes on `status` filtered to non-deleted rows for rooms and users. At Worood's data volumes — on the order of tens of thousands of reservations per year — these are comfortably sufficient.

### 4.6 Migrations

Migrations are plain, numbered `.sql` files applied in order inside a transaction by a small runner, which records each file's name and SHA-256 checksum in `core_migrations`. Re-running is a no-op, so the systemd unit runs migrations before every service start; a deploy that cannot migrate never begins serving traffic. If an already-applied migration is edited, the runner refuses to start and tells the developer to write a new migration instead — a cheap guard against the most common cause of environment drift.

---

## 5. API surface

The API is versioned in the path (`/api/v1/…`) so a future breaking change can be introduced alongside the current version rather than in place of it. OpenAPI documentation is generated from the code and served at `/api/docs` outside production.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/login` | Sign in; returns access token, refresh token, principal |
| `POST` | `/auth/refresh` | Rotate tokens (single-use refresh) |
| `POST` | `/auth/logout` | Revoke the presented refresh token |
| `GET` | `/auth/me` | Current principal with roles and permissions |
| `POST` | `/auth/change-password` | Change own password; revokes other sessions |
| `GET` | `/health` | Liveness plus database round-trip (public) |
| `GET` | `/hub/modules` | Modules, navigation and portlets visible to this user |
| `GET` | `/users` | Employee directory search (attendee picker) |
| `GET` | `/meeting-rooms/locations` | Office sites |
| `GET` | `/meeting-rooms/equipment` | Equipment catalogue |
| `GET` | `/meeting-rooms/rooms` | Rooms, filtered by site, capacity, equipment, text |
| `GET` | `/meeting-rooms/rooms/:id` | Room detail |
| `GET` | `/meeting-rooms/rooms/:id/schedule` | Day timeline: busy blocks and free slots |
| `GET` | `/meeting-rooms/availability` | Find rooms free on a date, with free slots per room |
| `GET` | `/meeting-rooms/free-now` | Rooms with nothing booked for the next N minutes |
| `POST` | `/meeting-rooms/rooms` | Create a room (Facilities) |
| `PATCH` | `/meeting-rooms/rooms/:id` | Update a room or its booking policy (Facilities) |
| `DELETE` | `/meeting-rooms/rooms/:id` | Retire a room — soft delete |
| `POST` | `/meeting-rooms/reservations` | Reserve a room; 409 if the slot is taken |
| `GET` | `/meeting-rooms/reservations` | List reservations: own by default, all with permission |
| `GET` | `/meeting-rooms/reservations/next` | The employee's next upcoming meeting |
| `GET` | `/meeting-rooms/reservations/:id` | Detail with attendees |
| `PATCH` | `/meeting-rooms/reservations/:id` | Move, re-room, retitle, change attendees |
| `POST` | `/meeting-rooms/reservations/:id/cancel` | Cancel and free the slot immediately |

Booking rules enforced on write, each with a specific and human-readable error message: the start must be in the future; the end must be after the start; the duration must fall between the room's minimum and maximum; the booking must be within the room's advance-booking window; it must start and end on the same day; it must fall inside the room's opening hours evaluated in the site's own timezone; the attendee count must not exceed capacity; the period must not intersect a maintenance blackout; and the room must be active.

---

## 6. Security model

Passwords are hashed with bcrypt at cost factor 12. Five consecutive failed sign-ins lock an account for fifteen minutes, and every failure is written to the audit log with the source IP. A sign-in against an unknown e-mail still performs a hash comparison, so response timing does not disclose whether an address exists.

Sessions use a short-lived JWT access token, fifteen minutes by default, carrying the user's roles and effective permissions, paired with an opaque refresh token valid for thirty days. Refresh tokens are stored only as SHA-256 hashes, so a database disclosure cannot be replayed, and they are single-use: presenting one revokes it and issues a new pair. Presenting a token that has already been used is treated as evidence of theft and revokes every session for that user. Changing a password revokes all other sessions.

Authorisation is permission-based rather than role-based at the point of enforcement. Routes declare permission keys; roles are simply bundles of those keys. Adding a role, or moving a permission between roles, is a data change rather than a deployment. Three roles ship by default: `employee` can view rooms and manage their own bookings; `facilities` additionally manages the room catalogue and any booking; `admin` holds every permission. Ownership is checked separately from permission: an employee may modify only their own reservation, which is asserted by test.

At the transport and input layers, nginx terminates TLS 1.2/1.3 and sets HSTS and the standard hardening headers; the Node process listens only on the loopback interface and is never directly reachable. Request validation rejects unknown fields outright rather than ignoring them. All database access is parameterised through Drizzle. CORS is restricted to the configured portal origin. The login endpoint is rate-limited at nginx in addition to the application-wide throttle. The systemd unit runs the service as an unprivileged user with `ProtectSystem=strict`, `NoNewPrivileges`, a private `/tmp` and a memory ceiling.

Every security-relevant action — sign-in, failed sign-in, password change, reservation created, modified or cancelled — is written to `core_audit_logs` with the actor, the entity, a before/after payload where applicable, and the source IP.

### 6.1 Path to single sign-on

Built-in e-mail and password authentication was chosen for phase one. The auth layer is deliberately isolated behind `AuthService` and the JWT guard, so adding Microsoft Entra ID or LDAP later means adding an identity provider that resolves to a `core_users` row and issues the same tokens. No controller, no guard and no frontend code changes. If Worood expects to adopt Microsoft 365 sign-in within the year, it is worth scheduling that work before the user base grows, because migrating credentials later is more disruptive than adding the provider early.

---

## 7. Frontend architecture

The portal is a single-page React application. The shell — sidebar, top bar, dashboard grid — is generic: it renders whatever `GET /hub/modules` returns. Module pages are ordinary routed components. The dashboard is a twelve-column grid of portlets; each module declares which portlets it contributes and how wide they are, and the shell maps portlet keys to components.

Server state is managed by TanStack Query, which handles caching, background refresh and invalidation. After a booking succeeds, the availability, reservation-list and next-meeting queries are invalidated together, so every view reflects the change without a page reload. The API client holds the access token in memory and the refresh token in `localStorage`, transparently refreshing once on a 401; a single in-flight refresh is shared across concurrent requests so a burst cannot trigger a refresh storm.

All times are rendered in the employee's own timezone, and the booking search reasons in that same clock so that a time typed into the form means what the employee expects when the API interprets it against the room's site timezone. Arabic names are stored alongside English throughout (`name_ar`, `full_name_ar`), and the font stack includes Noto Sans Arabic, so a full Arabic interface with RTL layout is an increment rather than a rewrite.

The styling is a single stylesheet of design tokens and components — roughly 600 lines, no UI framework. At this size a utility framework would add weight and a build dependency without adding clarity. The production bundle is about 250 KB, 77 KB gzipped.

---

## 8. AWS EC2 requirements

### 8.1 Sizing for under 200 employees

With fewer than 200 employees, realistic peak concurrency is on the order of 10–20 simultaneous users, clustered around the start of the working day and just before meetings. This is a small workload. The honest recommendation is a single right-sized instance running both Node and PostgreSQL, not a distributed topology that would cost more to run and considerably more to operate.

| Component | Recommendation | Notes |
|---|---|---|
| Instance type | `t3.medium` (2 vCPU, 4 GB) or `t4g.medium` for Graviton/ARM | Graviton is meaningfully cheaper for the same performance; the stack is architecture-independent |
| Alternative | `m7g.large` (2 vCPU, 8 GB) | If burst credits prove tight or the database grows quickly |
| Root volume | 30 GB gp3 | Operating system, application, logs |
| Data volume | 50 GB gp3, 3000 IOPS, mounted at `/var/lib/postgresql` | Separate volume so the database can be resized and snapshotted independently |
| Operating system | Ubuntu Server 24.04 LTS | Five years of security updates |
| Elastic IP | One | Stable address for DNS and firewall rules |
| Region | `me-south-1` (Bahrain) or `eu-south-1`/`eu-central-1` | Choose for latency to Cairo and any data-residency requirement; confirm the region offers Graviton and the services below |

The reasoning behind 4 GB: PostgreSQL is configured with 1 GB `shared_buffers` and 3 GB `effective_cache_size`; the Node process is capped at 1.5 GB by systemd and in practice uses well under 300 MB; nginx is negligible. That leaves comfortable headroom. Burstable `t3`/`t4g` instances suit this profile precisely because intranet traffic is spiky rather than sustained — but enable **unlimited mode** so a busy Monday morning degrades into a small bill rather than into throttling.

### 8.2 Network and access

Place the instance in a public subnet with an Elastic IP, or behind an Application Load Balancer if Worood wants managed TLS certificates through ACM and a straightforward path to a second instance later. Two security groups: a web group allowing 443 from the internet (or from Worood's IP ranges only, if the portal should not be publicly reachable) and 80 solely for ACME certificate renewal; and a management group allowing 22 only from the office IP range or, better, no SSH at all in favour of AWS Systems Manager Session Manager, which removes the need for an open SSH port and for distributing key pairs. PostgreSQL's port is never exposed; it listens on loopback only.

### 8.3 Storage, backup and recovery

Two layers of backup, because they fail differently. AWS Backup takes daily EBS snapshots of both volumes with 30-day retention, protecting against instance-level loss. Separately, a nightly `pg_dump` in custom format is uploaded to S3 with server-side encryption and a lifecycle policy that moves objects to infrequent access after 30 days, to Glacier Instant Retrieval after 180, and expires them at one year. The logical dump is what makes selective recovery possible — restoring one accidentally deleted table without rolling back the entire instance.

A recovery point objective of 24 hours and a recovery time objective of about two hours are achievable with this setup and are appropriate for an internal booking system. If Worood later decides that meeting-room data warrants tighter figures, moving PostgreSQL to Amazon RDS with automated backups and point-in-time recovery is the next step, and requires only a change of `DATABASE_URL`.

Restores must be rehearsed, not assumed. Schedule a quarterly restore test into a scratch instance.

### 8.4 Deployment and operations

The instance is prepared once by `deploy/ec2-bootstrap.sh`, which installs Node 22, PostgreSQL 16 with the required extensions and tuned settings, nginx, ufw, fail2ban and unattended security upgrades; creates the database role with a generated password; writes an environment file readable only by the service account, with freshly generated JWT secrets; and installs the nginx site and systemd unit. Releases run `deploy/release.sh`, which builds both applications, publishes them, and restarts the service; migrations run in `ExecStartPre`, so a failed migration prevents the new version from serving traffic at all.

For monitoring, the CloudWatch agent should ship CPU, memory, disk and burst-credit metrics, with alarms on CPU credit balance, disk above 80 per cent, memory above 85 per cent, and any instance status check failure. The `/healthz` endpoint verifies a real database round-trip and is the right target for both the load balancer and an external uptime monitor. Application logs go to journald and should be forwarded to CloudWatch Logs with 30-day retention. Alarms should notify an SNS topic subscribed to the IT team's address.

### 8.5 Indicative cost

Precise pricing varies by region and changes over time, so these should be confirmed in the AWS Pricing Calculator for the chosen region before budgeting. As an order of magnitude, a single `t4g.medium` with 80 GB of gp3 storage, an Elastic IP, snapshot storage, S3 backups and CloudWatch typically lands in the region of 60–90 USD per month on demand. A one-year Compute Savings Plan or Reserved Instance on the compute portion commonly reduces the instance line by roughly a third to a half, which is worth doing once the instance size has settled after a month or two of real use.

### 8.6 Growth path

Nothing in this design has to be rebuilt as Worood grows. The first step, if the database begins competing with the application for memory, is to move PostgreSQL to Amazon RDS — a change to one environment variable. The second, if a single instance stops being enough or zero-downtime deploys become a requirement, is to put an Application Load Balancer in front of two instances; the API is already stateless, since sessions live in the database rather than in process memory. Beyond that, adding ElastiCache for Redis in front of the room catalogue and moving static assets to S3 with CloudFront are straightforward increments. Each of these is a deployment change, not an application rewrite, which is the point of the architecture.

---

## 9. Environments

Three environments are recommended. Local development uses Docker Compose for PostgreSQL only, with both applications run directly for fast reload. Staging is a single small instance, ideally `t4g.small`, mirroring production configuration and used to rehearse migrations before they touch production data. Production is as specified in section 8.

Secrets never enter version control. In production they live in the environment file, generated on the instance and readable only by the service account; AWS Systems Manager Parameter Store with SecureString parameters is the natural next step if secret rotation becomes a requirement.

---

## 10. Verification

The prototype has been built and exercised end to end against PostgreSQL 16. The results below are from an actual run, not a plan.

Twenty unit tests cover the availability arithmetic: overlap detection including the back-to-back boundary case, interval merging, changeover buffers, slot generation against opening hours, exclusion of slots that have already started, and full-day and zero-duration edge cases.

Fifty-six end-to-end tests exercise the running API across thirteen areas: platform health; authentication including wrong-password rejection, lockout behaviour and anonymous access denial; the module registry and permission-filtered navigation; the room catalogue with capacity and equipment filters; availability search by date and time; reservation creation; double-booking prevention; booking rules; upcoming and previous reservation lists including the permission boundary between an employee's own bookings and everyone's; modification including the ownership check; cancellation and slot re-use; dashboard portlet data; and refresh-token rotation and replay rejection.

The concurrency test deserves specific mention: eight simultaneous requests for the same room and slot, issued from two different user sessions, produce exactly one confirmed reservation and seven HTTP 409 responses naming the winning booking. All seventy-six tests pass. The portal itself was driven through a headless browser to confirm sign-in, dashboard, room search, booking, room schedule, reservation management and room administration all render and function; screenshots accompany this document.

---

## 11. Recommended next steps

The immediate work to take module 1 from prototype to production is: load Worood's real room inventory and employee list; put the instance up and issue a TLS certificate; add e-mail notifications and `.ics` calendar attachments on booking, modification and cancellation, which is the single highest-value addition and the most common request once a system like this goes live; and add a check-in step that auto-releases a room fifteen minutes into a no-show, which is what actually recovers capacity in practice.

The decisions Worood should make before development continues are whether Microsoft 365 single sign-on is coming — and if so, to schedule it early; whether the interface needs full Arabic and RTL support at launch or later; which region satisfies any data-residency requirement; and whether the approval workflow already modelled in the schema (`requires_approval` on rooms, `PENDING` reservation status) should be switched on for high-demand rooms such as the Training Hall.

Beyond that, the natural module order is Leave Requests, then Help Desk, then a Document Library — each following the contract in section 3.3, and none requiring changes to what is already built.

---

## Appendix A — Repository layout

```
worood-hub/
├── apps/
│   ├── api/                        NestJS API
│   │   ├── src/
│   │   │   ├── common/             config, DB module, auth guards, error filter
│   │   │   ├── core/               auth · users · audit · hub registry · health
│   │   │   ├── modules/
│   │   │   │   └── meeting-rooms/  descriptor · dto · services · controllers
│   │   │   └── db/
│   │   │       ├── migrations/     0001_core_platform.sql · 0002_meeting_rooms.sql
│   │   │       ├── schema.ts       typed mirror of the SQL
│   │   │       ├── migrate.ts      checksum-verified migration runner
│   │   │       └── seed.ts         demo data
│   │   ├── test/                   unit tests
│   │   └── scripts/                end-to-end API test harness
│   └── web/                        React + Vite portal
│       └── src/
│           ├── components/         shell · shared UI
│           ├── lib/                API client · auth context · formatting
│           └── pages/              login · dashboard · book · rooms · reservations · admin
├── deploy/
│   ├── ec2-bootstrap.sh            one-time instance preparation
│   ├── release.sh                  build and release
│   ├── backup.sh                   nightly pg_dump to S3
│   ├── nginx/worood-hub.conf
│   └── systemd/worood-hub-api.service
├── docs/                           this document
└── docker-compose.yml              local PostgreSQL
```

## Appendix B — Demo accounts

All accounts share the password `Worood@2026` in the seeded environment.

| E-mail | Role | Sees |
|---|---|---|
| `omar.khaled@worood.co` | Employee | Own reservations only |
| `facilities@worood.co` | Facilities Coordinator | Room management, all reservations |
| `admin@worood.co` | System Administrator | Everything |
