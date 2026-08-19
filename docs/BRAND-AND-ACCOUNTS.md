# The mark, and the people the demonstration runs on

August 2026.

## The logo

The mark drawn in `Icon.tsx` was a stand-in — a stylised bloom written by hand
because there was no artwork available. The real artwork is now committed at
`apps/web/public/brand/worood-logo.png`, and the portal draws from it.

It was **traced, not redrawn**. The bloom is a fan of fronds with hairline
detail between them and a circle closing it; approximating that by hand would
have produced something that looked like the logo rather than something that is
the logo. Potrace at the source resolution, then optimised:

```bash
potrace mark.pbm -s --flat --turdsize 3 --alphamax 1.334 --opttolerance 0.4
```

Tracing at 4× first produced a visually identical result at **87 KB** against
**5.3 KB** at source resolution — the extra resolution only bought curve points
nobody can see. The two were rendered side by side and compared before choosing.

`components/WoroodLogo.tsx` exports three things: `WoroodMark` (the bloom,
square, for anywhere an avatar-sized slot exists), `WoroodWordmark` (wide, sized
by width), and `WoroodLogo` (the two stacked, as the artwork stacks them —
used on the login screen). All three take `currentColor`, so the colour is a
CSS decision rather than a baked-in fill; that is what lets the same component
be knocked out in white on a photograph later.

`Icon.tsx` re-exports them, so every existing `import { WoroodMark } from
'./Icon'` keeps working. The mark is a brand asset rather than an icon, but no
caller should have to care about the reorganisation.

### The gold

`--brand-gold: #a27e4e`, sampled from the artwork. It is deliberately **not**
`--accent`.

The accent is an interface colour: it carries link text, focus rings and the
active navigation state, and it was chosen against contrast requirements. The
gold is the mark's own colour and is not ours to adjust. Keeping them separate
means the logo stays right if the interface palette is ever retuned, and it
means nothing but the logo uses the gold — so no accessibility question is ever
raised about it. Dark mode lifts it to `#c49a63`, because the artwork's gold is
a shade too dim against a near-black plane.

Standalone assets for anything outside the app — slides, e-mail, documents —
are at `public/brand/worood-mark.svg` and `public/brand/worood-wordmark.svg`.
The favicon is the real mark on the portal's own paper.

## The demonstration accounts

Six people, replacing the seven placeholders. The names and titles are Worood's;
**the roles are a mapping and can be changed from Administration → Roles without
a deploy** — nothing below is compiled in.

| Person | Role | Reaches |
|---|---|---|
| Omnia Osama — Customer Care | `customer-care` | Orders with customer identity. **No dashboard permission at all.** |
| Nadia — Marketing Director | `marketing` | Marketing dashboards. **No orders at all.** |
| Mohamed Yousry — Financial Manager | `finance` | Finance reconciliation and the daily figures, with orders and customers. |
| Heba Fayed — Operations Manager | `operations` | Rooms, anyone's reservation, order flow, Data & Sync. Not the composer; orders arrive with the customer withheld. |
| Mohamed Kandil — CEO | `executive` | All five dashboards, orders and customers. Not Data & Sync, not the console. |
| Khalid Hesham — System Administrator | `admin` | Everything, including People and Roles. |

Password for all six: `Worood@2026`.

### Why these permissions

The point of the demonstration is that the portal is composed from what each
person is granted, so the six were arranged to make every branch of the
resolution rule visible on a real person rather than on a contrived one:

- **A role that reaches several dashboards** — Executive, all five.
- **Roles that reach exactly what they need** — Finance two, Marketing two,
  Operations one.
- **A role that reaches none** — Customer Care. This is the account that makes
  the permission gate *visibly* true: the sales portlets are absent from her
  home screen, not present and empty.
- **A dashboard added to one person** — Heba, Executive Daily.
- **A dashboard taken back from one person** — Nadia, Combined Sales and
  Marketing, which her role would otherwise give her.

Two decisions worth stating, because both narrow access rather than widen it:

**Marketing holds no order permission.** Campaign performance is not a reason to
read a customer's name and address. This also means Marketing and Customer Care
together prove the keys are independent in *both* directions — one has
`dashboard.view` without `order.view`, the other has `order.view` without
`dashboard.view` — which is a stronger demonstration than one account simply
missing everything.

**Operations holds `order.view` without `customer.view`.** Fulfilment needs the
order flow, not the person. The API withholds the customer object and says it is
doing so, rather than blanking the fields. The old suite had to fabricate a role
on the fly to test this; it is now how the company is actually set up.

**The CEO is not an administrator.** The widest *reading* permission does not
imply an operational one: Mohamed Kandil sees every dashboard and cannot open
Data & Sync or the administration console. Seniority is not a permission.

### If the mapping is wrong

It is data, not code. Administration → Roles changes what a role carries;
Administration → People changes who holds it. Both bind on the next request.
`docs/ADMINISTRATION.md` covers the model and the rails.

## Tests

The suites were updated with the cast, not around it. Two assertions were
rewritten to *find* what they need rather than name it — which dashboards a role
carries is seeded data, and a test that hard-codes those keys is a hostage to
the seed. One placeholder in the screenshot harness surfaced a real bug while
this was going on: a portlet rendered "Booked by undefined" when the API omitted
the organiser's name, because the guard tested `isOrganiser` rather than the
name being present. Fixed in the component, not in the fixture.
