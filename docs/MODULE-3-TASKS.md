# Module 3: Tasks & Tickets

September 2026. **Status: built.** 111 assertions pass against a running API
with a real PostgreSQL.

## What it is

Internal only. Every participant is a Worood employee; no customer touches it.
An employee raises a request, it lands on a department, that department's
manager gives it to somebody, and that person does it.

There is **one row shape**, not two. A task for yourself is a ticket whose
requester and assignee are the same person. A request to your own colleague is
a ticket addressed to your own department. The alternative — a `kind` column
with two workflows behind it — buys two comment tables, two notification paths
and two screens that look identical and disagree within a month.

## The core change this needed

`core_departments` has been a tree since `0001` and `core_users` has carried a
department since `0001`, but nothing in the platform could say **who runs a
department**. `0016` adds `core_department_managers`, as a table rather than a
column because a department may have more than one manager — which is how cover
during leave works without handing anybody a company-wide role.

**Managing a department is a position, not a role.** A role would be
company-wide, and the Marketing manager would be able to assign work inside
Customer Care. So `loadPrincipal` derives `tasks.item.assign` from membership of
`core_department_managers`, and `core_user_managed_departments()` decides where
it applies. The permission opens the button; the tree decides the scope. This is
the same separation Module 1 draws between holding `reservation.manage-any` and
owning the reservation you are editing.

Two rails follow, and neither is optional: the last manager of a department
cannot be removed or suspended, and a department with no manager never appears
in the target picker. A department without a manager is a black hole — tickets
land in it and nobody in the system can move them.

`Principal` gains `departmentId` and `managedDepartmentIds`. Work is addressed
to a department, so the display name that was already there is not enough.

## Visibility is per ticket, not per department

`tk_participants` **is** the access list, plus the managers of the target
department and anyone above them in the tree. One join answers "may this person
see it", and the same rows are the notification recipients, so the two cannot
drift apart. It lives in `visibility.service.ts` and nothing re-derives it.

| Who | Sees | May do |
|---|---|---|
| Requester | always | Before assignment: title, description, priority, department, or cancel. After: comment. On resolution: accept and close, or send back with a reason |
| Manager of the target department | every ticket in it, and everything below it in the tree | Assign, reassign, transfer, refuse, add and remove contributors, comment |
| Assignee | their ticket | Status, due date, dependencies, comment. **Not** title or description |
| Assignee or manager of a **blocked** ticket | also the ticket blocking it | Whatever that ticket's own rules allow them |
| Contributor | the ticket | Read and comment. Added by a manager only — never by the assignee |
| Past assignee | read | Comment |
| Manager who transferred it away | read only | — |
| Manager higher in the tree | everything below them | Same actions, but **is not notified** |
| `tasks.item.view-any` | everything | Read |
| Anyone else in the department | **nothing** | — |

Three consequences worth stating rather than discovering:

- A ticket with no contributors is invisible to the rest of the department.
  That is the whole of the confidentiality model, and it is confidentiality from
  your colleagues, not from the management chain above you.
- A ticket you raise for yourself is visible to your manager, who can also take
  it off you. Normal for a work system, but it should not surprise anyone.
- **Transfer removes the old department's access**, except for the manager who
  performed it — the requester will ask them where it went, and "I can't see it
  either" is not an answer.

**Higher managers see but are not notified.** If notification followed the same
tree rule, whoever sits at the top would receive every ticket in the company and
filter the lot into a folder within a week. They hear about two things only:
a ticket left unassigned for a day, and lateness.

## Administration → Departments

The org chart being load-bearing means it needs a screen, and it has one:
who runs each department, added and removed, with the departments that have
**no active manager shown first and marked**.

Three rails, all enforced on the server so a direct API call hits the same
wall, and all refusing with a message that names what to do first:

- the last manager of a department cannot be removed;
- they cannot be suspended or deleted either — a suspended account cannot sign
  in, so a department whose only manager is suspended is as unreachable as one
  with none;
- they cannot be moved to another department, which would leave them running a
  team they are not in while the assign picker offers only that team's members.

Somebody outside a department cannot be made to run it, for the same reason:
they would see a queue with nobody to put on it.

## Lifecycle

| From | Who moves it | To |
|---|---|---|
| `NEW` | manager of the target department | `ASSIGNED`, or `REJECTED` with a reason, or transferred |
| `NEW` | requester | `CANCELLED` with a reason |
| `ASSIGNED` | assignee | `IN_PROGRESS`, setting `due_at` |
| `IN_PROGRESS` | assignee | `BLOCKED` (dependency) or `RESOLVED` |
| `IN_PROGRESS` | manager | reassign — back to `ASSIGNED` |
| `BLOCKED` | automatic | `IN_PROGRESS` when the last blocker closes |
| `RESOLVED` | requester | `CLOSED`, or back to `IN_PROGRESS` with a reason |
| `CLOSED` | requester or manager | reopened, incrementing `reopened_count` |

A ticket raised for yourself opens at `ASSIGNED` — waiting for your own manager
to hand you back your own note would be theatre. Raising one to your own
department *without* claiming it still queues, because you asked the team.

Transitions are named routes (`/start`, `/resolve`, `/confirm`) rather than a
settable status field. Each has its own preconditions, its own event and its own
notification, and a writable column would let a caller skip all three.

**Finished tickets do not disappear.** Being on a ticket never expires, so the
list defaults to *everything* rather than to open work — a ticket closed an hour
ago is exactly the one somebody comes back looking for, and filtering it out by
default made it unfindable for the person who raised it, the person who did it
and their manager alike. Finished work sorts below live work rather than being
hidden from it.

**There is no automatic close on silence.** A resolved ticket waits for its
requester however long that takes.

## Lateness is a condition, not a status

`sla_state` is its own column, so a ticket can be `IN_PROGRESS` and `OVERDUE` at
once. That pair is the useful fact: it says both where the work is and that it
is late. Collapsing the two, so "delayed" replaces "in progress", throws away
half of it and leaves nobody able to say whether anyone is working on the thing.

`TasksScheduler` sweeps every fifteen minutes, in-process on an interval like
`SalesScheduler` rather than inventing a second mechanism. It recomputes state
from `due_at` rather than stepping through it, so a missed cycle, a restart or
two processes briefly overlapping all produce the same answer.

The clock keeps running while a ticket is `BLOCKED`. The requester is waiting
either way; what changes is the explanation, and the strip says the delay is a
dependency rather than neglect. Suppressing lateness while blocked would make
"waiting on another department" a free pass.

## Dependencies

When the assignee needs something from a third department, "add dependency"
creates **an ordinary new ticket** addressed to that department — its own
requester, its own queue, its own manager, its own assignee, its own date — and
a `BLOCKED_BY` link. No special path, no special state, no special screen.

- **Either the assignee or a manager of the department may raise one.** A
  manager often knows before the assignee does that Facilities will have to be
  involved, and making them message the assignee to click a button adds a step
  and nothing else. Whoever raises it becomes the new ticket's requester.
- Because of that, the blocking ticket is visible to the **assignee and the
  managers of the blocked ticket** — not only to whoever asked. Otherwise a
  manager raising it would leave the person actually stuck able to see only the
  summary strip, which is the wrong way round. The original requester still
  gets the strip and nothing more: the blocking work is not theirs.
- The third department sees **their ticket only**. What reaches them is what was
  typed into the dependency, so the form asks for the requirement in full.
- The original requester sees a strip: **blocked, waiting on Facilities, asked
  three days ago, in progress**. Department, status and dates. The title is
  *absent* rather than blanked — a field that is present and empty invites the
  reader to wonder what was removed.

**Resolved is not accepted.** A department saying "done" does not release the
block: the person who asked still has to agree it is what they needed, and
until they do the parent stays `BLOCKED`. That is the right rule and it is
useless unless the parent's own screen says so and can be clicked through — so
the blocked banner names the ticket, links to it, and changes to *"Facilities
say it is done — open TK-1043 and accept it"* the moment the answer arrives.

It unblocks itself when the last blocker closes. If the blocker is **refused**
rather than resolved, the parent still returns to `IN_PROGRESS` and the
notification carries the reason, so the assignee acts instead of waiting. If the
parent is **cancelled**, the child is not cancelled with it: that is another
department's work, and its requester is told to decide.

Cycles are refused by a database trigger rather than by every call site.

## What the API refuses, and what it says

Every refusal names the thing that caused it, in the house style:

- assigning to somebody outside the department → *"Nadia is not in this
  department. Transfer the ticket instead if it belongs elsewhere."*
- a second manager assigning a ticket that has just gone → *"Somebody else
  assigned this a moment ago. Reload to see who has it."* — a conditional
  `UPDATE` on the previous assignee, so the loser is told rather than left
  believing they assigned it.
- resolving with work still owed → *"Still waiting on TK-1043 (Facilities).
  Release the dependency first."*
- refusing without a reason → refused at the database by `CHECK`.
- a due date in the past → *"A commitment in the past is not a commitment."*

## Notifications

The participant list is the recipient list. In-portal now, through
`core_notifications` as Module 1 already does. **A notification failure never
fails the operation** — the assignment is the participant row, the notification
is the announcement.

E-mail is agreed and not built. It needs a transport, an outbox keyed
`(event_id, user_id, channel)` so a job retry cannot send twice, per-user
preferences, digesting for busy managers, and Arabic and English templates off
`core_users.locale`. The same service should then carry Module 1's meeting
notifications, which are written but reach the portal only.

## Roles, and why there is no "manager" role

Two different questions, answered in two different screens, and conflating them
is the mistake this module is shaped to avoid.

**Administration → People** decides what a person *is*: their role, and what
features that role can reach. Adding an employee at deployment time is done
here, exactly as it was before this module existed.

**Administration → Departments** decides what a person *runs*. Authority over a
department is a position in the org chart, not a role — a role is company-wide,
so a `manager` role would let whoever held it assign work inside every
department in the company. `tasks.item.assign` is therefore derived in
`loadPrincipal` from `core_department_managers`, and the tree decides where it
applies.

So there is no `manager` role to create, and creating one would be wrong.

That reasoning is sound and it is not the administrator's problem. Somebody
adding an employee thinks "she runs Customer Care" and should not have to
remember a second screen, so the question is asked **on the People screen**,
directly under Roles, both when creating a person and when editing one. It
saves immediately rather than with the form, because it is a row in another
table with rails of its own that have to answer at once.

Administration → Departments remains the place to see the whole org chart at a
glance and to spot a department that has lost its last manager. Neither screen
is the "real" one — they ask the same question from the two directions people
actually arrive from.

The module registers **four** permission keys, and every one of them is checked
by something: `assign` (derived, never granted), `view-any`, `manage-any`,
`report.view`. There is deliberately no "may see tickets" and no "may raise a
ticket" key. Both would gate nothing — visibility is per ticket, and asking a
colleague for something is what the module is for — and registering keys no
route checks would put dead rows on the Roles screen and set a trap: a role
created a year from now would be missing them, and whoever created it would
spend an afternoon working out which one broke ticketing. A role created from
Administration → Roles works with this module out of the box.

## Permissions on an existing install

Nothing in the application writes to `core_permissions`; only the seeder does.
That is fine on a fresh install and wrong on a live one, where the seeder must
never run — it truncates, it rewrites role grants and it inserts the
demonstration cast. So `0017` registers the module's own keys, additively and
idempotently: the four permission rows, and all four to `admin`.

Without it the module would land with its permission rows missing, every route
declaring a key would refuse everybody including the administrator, and the
Roles screen would list nothing to grant — leaving no way to fix it from inside
the product.

`tasks.item.view-any` is deliberately granted to nobody else. Reading every
ticket in the company is a decision about people, not a default, and
Administration → Roles is where it belongs.

Verified on the upgrade path rather than assumed: a database seeded *before* the
module, then migrated with `0016` and `0017` and nothing else, ends with the
administrator holding all four keys, opening a Customer Care ticket he does not
manage, and acting on it — while an ordinary manager asking for `scope=all`
still gets a 404.

## The seed

The cast was six people in six departments of one, which could not demonstrate a
single assignment: there was nobody to assign to. Thirteen colleagues are added
underneath them, all on the bare `employee` role.

Customer Care deliberately has **two managers**, Omnia and Mariam. It is the
case that needs seeing: two people able to assign, and only one of them can win.

## Tests

```bash
npm run migrate && npm run seed -- --reset
npm run build && node dist/main.js &
npx tsx test/tasks.test.ts       # 111 assertions
```

Each is proven by doing it rather than by inspecting a row:

- a colleague in the same department who is not on a ticket gets **404, not
  403** — a person who may not see a ticket should not learn that it exists;
- Nadia holds `tasks.item.assign` and still cannot assign inside Customer Care,
  which is what proves the key is scoped by the org chart rather than global;
- the assignee cannot rewrite the request, and the requester cannot either once
  somebody is on it;
- the assignee cannot bring in a colleague; the manager can;
- Facilities cannot see the ticket that caused their dependency, while the
  requester can see that it is blocked, on whom and since when, and not its
  content;
- closing the child unblocks the parent on its own;
- the full three-department chain: the asking manager sees the ticket and may
  comment but not assign, sees it in the department view, and is refused the
  third department's ticket while still getting the strip;
- a closed ticket is still listed for the requester, the assignee, the
  contributor and the department manager, with live work sorted above it;
- a resolved dependency leaves the parent blocked, and the parent can see the
  answer is waiting **and reach it** — the assertion that would have caught the
  detail screen reading the wrong dependency list, leaving somebody staring at
  a blocked ticket with nothing to click;
- a manager raises a dependency, the assignee can open the blocking ticket, and
  the original requester still cannot — the strip and nothing more;
- a closed ticket offers no actions to anybody, **including an administrator**:
  `manage-any` replaces the identity check, never the status check, and getting
  that wrong left Accept, Send back and Cancel on screen a week after a ticket
  was closed;
- every way of emptying a department of its managers is refused, in both
  directions: one of two may go, the last may not, and adding a second lifts
  the rail again — the rails count rather than refusing categorically, in the
  same shape as the existing last-administrator rails;
- the sweep marks a ticket overdue **without touching where the work is**;
- the assignee cannot close his own work; the requester sends it back and it
  returns to the same person;
- the CEO reads a ticket in a department he does not manage and cannot act on
  it, and is refused the sweep — the widest reading permission is still not an
  operational one;
- every reason-carrying route, called with **exactly the body the dialog
  sends**. The suite originally built each body by hand and passed while the
  screen sent `resolution` to `/cancel` and got a 400 — the pipe runs with
  `forbidNonWhitelisted`, so an undeclared field is refused rather than
  ignored. Worth keeping refused; worth testing from the caller's side.

Screenshots: `node scripts/shot-tasks.mjs` in `apps/web`, against the real API,
covering the requester, the manager and the assignee, plus RTL and dark.

## Still open

- **E-mail.** Agreed, specified above, not built.
- **Attachments.** Deferred. They need file storage, which no module has yet,
  and it belongs in the core as `core_attachments` rather than inside this one.
- **Reporting.** `tasks.report.view` exists and nothing reads it yet: per
  department, ageing, resolution time, overdue count.
- **Departments cannot be created or renamed** from the console — only their
  managers are editable. Creating one is still SQL.
- **Recurring tickets.** Monthly maintenance is the obvious case.
- **Arabic copy.** The layout mirrors; the strings are still English.