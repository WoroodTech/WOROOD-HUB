# Consolidation and UI enhancements

August 2026. This note records what was merged, what changed on screen, and — where a
choice was contested — why it went the way it did.

## 1. What was consolidated

Four archives existed. They are now one repository.

| Archive | What it was | Where it went |
|---|---|---|
| `woroodhubfixed` | Platform + Meeting Rooms + Sales Dashboard, with git history | **The repository.** Everything below is built on it. |
| `woroodhub` | The same tree, one revision older (no `.gitignore`, no `load-env.ts`, older README) | Discarded — a strict subset, nothing was lost. |
| `woroodhubprototype` | The meeting-rooms-only prototype that preceded the platform | `prototypes/meeting-rooms-prototype/` |
| `woroodhubemployeedashboard` | A standalone employee dashboard UI on mock data | Its ideas are now the home screen. Source kept at `prototypes/employee-dashboard/` |

The two prototype trees are archived rather than deleted because they are the record of
how the design arrived where it did. They are not built, not linted, and not imported by
anything: nothing in `apps/` reaches into `prototypes/`.

## 2. One palette, and it is the warm one

The employee-dashboard prototype carried a second, incompatible identity: a green/teal
enterprise palette (`#1f6f5c`) against cool grey surfaces. The main app is warm —
terracotta on unbleached paper — and its chart ramp is not a matter of taste: the eight
categorical hues in `charts/palette.ts` were generated in OKLCH and validated for
colour-vision deficiency at the adjacent-pair and all-pairs level, in both schemes.
Re-hueing the app would have invalidated that work and bought nothing.

So the terracotta identity wins, and the prototype's components were restyled onto it.

**Large dark surfaces were removed.** The sidebar was a near-black slab (`#241d17`) at
248px wide — the single biggest block of colour on every screen, and the one thing
fighting the warm paper everywhere else. It is now a sand surface (`#f6efe2`) with the
active item carried by the accent rather than by contrast:

```
--sidebar: #f6efe2;   /* was #241d17 */
--sidebar-ink: #241d17;
--sidebar-line: #e3d8c6;
--sidebar-hover: #ede3d2;
```

Dark mode keeps a sidebar that is *near* the page rather than blacker than it
(`#1b1815` against a `#100e0c` plane) — the same principle, inverted.

## 3. The home screen

The prototype's dashboard and the platform's home screen were solving the same problem
twice. The platform's version won on architecture — it renders whatever
`GET /hub/modules` says the employee has, so a new module appears without a code change —
and the prototype's contributions were ported onto it:

- **Profile banner** (`portlets/ProfileBanner.tsx`) — identity, role and location in one
  strip. It matters here because the grid genuinely changes shape between accounts;
  seeing *which* account you are is part of understanding what you are looking at.
- **Quick actions** (`quick-actions`) — not a hard-coded list. It is every live module's
  navigation, flattened and capped at six.
- **What's coming** (`coming-soon`) — every module registered with `comingSoon`, read off
  the same descriptors. Registering a module puts it here; nobody edits a file.

Both new portlets are the hub's own rather than a module's, so they have no endpoint.

## 4. Personalisation

`lib/layout.ts`. An employee can reorder cards (drag, or arrow buttons for the keyboard
path), change a card's width through four steps (4 / 6 / 8 / 12 columns) and fold a card
away into a tray. State is per-user in `localStorage`.

Two rules that are not negotiable:

- **Arrangement is the user's; permission is not.** A portlet the employee may not see
  never reaches the browser — the server omits it from `dashboard`, and the absence *is*
  the gate. Nothing in the layout code can reveal one, and nothing needs to hide one.
- **The saved layout is reconciled against the server on every load.** A revoked portlet
  disappears from the arrangement; a newly granted one appears in its server-suggested
  position rather than being silently swallowed because the saved layout predates it.

## 5. Dark mode

`lib/theme.tsx`. Three states, not two: light, dark, and **system**. System is a real
persisted choice — a user who picks it keeps following the OS across reloads, and a user
who picks light stays light at night.

The mode is stamped on `<html>` as `data-theme`, and the token set is reachable two ways:
by the media query when nobody has chosen, and by the attribute when someone has. The
attribute wins, because a choice outranks a default.

Two details worth keeping:

- Transitions are suppressed for one frame during the switch (`.is-theming`). Without it,
  every token animating at once reads as a fault rather than as polish.
- Charts paint literal hex into SVG, so they cannot follow a CSS variable. The appearance
  change broadcasts `wh:appearance`, and the shell remounts `<main>` on it. Everything
  the charts show is already in the query cache, so this costs a repaint, not a fetch.

## 6. Motion

Three durations and one easing curve, as tokens (`--t-fast`, `--t-mid`, `--t-slow`,
`--ease`). Cards fade up on arrival, buttons compress on press, portlets dim while
dragged, hidden cards return with a toast.

`prefers-reduced-motion` is honoured globally, and it is not a lesser experience — the
same states, without the travel.

## 7. RTL

The stylesheet was already written in logical properties, so the layout mirrors on
`dir="rtl"` without a second sheet. What did not mirror for free:

- **English copy inside a right-to-left frame.** The portal flips before its Arabic copy
  exists, so `unicode-bidi: plaintext` is applied to text-bearing elements: each run is
  laid out in the direction of its own first strong character. English reads LTR, Arabic
  reads RTL, and no component makes a per-string decision. The rule keeps working when
  the Arabic copy lands.
- **Runs with no strong character at all** — clock ranges, order references, money,
  relative ages. `plaintext` would hand these to the paragraph, and `13:15 – 14:15` read
  right-to-left is a different range. These are pinned `direction: ltr` outright.
- **Directional glyphs.** Chevrons mean *forward*, and forward is leftwards in Arabic, so
  they are flipped rather than left pointing at the previous page.

Arabic *copy* is not in this change. Direction is; translation is the next piece of work.

## 8. Looking at it

```bash
cd apps/web
npm run build
npx vite preview --port 4173 &
node scripts/ui-screenshots.mjs      # -> screenshots/ui/
```

The script stubs the API deliberately — it is not testing the API. It exists so a change
to the stylesheet, the theme switch or the home layout can be *seen*, at two viewports,
in every appearance the portal ships: light, dark, RTL, and customise mode. Output is
committed under `screenshots/ui/`.
