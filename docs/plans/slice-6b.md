# Slice 6b — UX foundation (staff app and portal)

Status: **draft**, waiting for the product owner's approval. Placed before Slice 7 (see D1).
Roadmap: give every screen one job, a visible hierarchy and progressive disclosure, fix the shell's
defects, and give `packages/ui` the patterns Slices 7–9 build on, without changing the lifecycle,
the access rules or the API contract except where a PR below names it.
Builds on: `packages/ui` (the Carbon wrapper, ADR-0003), the work list and dashboard of Slice 5
(data-protection.md, the work list and the dashboard), the participant page's tabs and
capabilities, the self-service wizard's progress (`packages/self-service-ui`), the axe checks in
`apps/web/e2e/helpers.ts` and the 2,000-row budget in `apps/web/e2e/dashboard.spec.ts`.

## Why

The UI is generated from the data model and the permission model: every field a column, every
code filter a dropdown, every capability a control that is always on screen. Nothing decides what
matters on a screen. The bones are good (accessibility, i18n, state handling, capabilities, a
strict CSP) and Carbon stays: what is missing is a product-design layer, not a component library.

Findings this slice fixes (from the owner's review, 2026-11-06, checked against the code):

| Area | Finding |
|---|---|
| Work list | 17 columns (`participants.tsx`, `columns`); 14 filter selects as a grid (`worklist-tools.tsx`); six bulk-action rows rendered with nothing selected; opens in creation order (`worklist.ts` orders by `createdAt`), urgency only with a deadline filter; the search sits under the filters in a `tp-bulk-actions` div. |
| Repetition | "Teilnehmende" three times (tab, `h2`, table title); "Projekte" twice; "Übersicht" tab + `h2` + ten equal-weight tables. |
| Admin chrome | The region select + "Speichern" above the project tabs for everyone (`project-region.tsx`); `tp-load-more` used as a margin hack for unrelated buttons. |
| Shell | `/login` shows an empty 16rem rail and an offset form (`shell.tsx`, `.tp-content`); no `HeaderMenuButton`, the rail is always expanded, nothing works under 66rem; no breadcrumb on the project page; no favicon, mark or product identity. |
| Hierarchy | One theme (`g10`), status as plain text, dashboard tiles that don't read as clickable or severe, no content max-width, headings sized by which component they sit in, one `SimpleTable` for every list (no sort, no sticky header, no column choice). |
| States | `<p>Wird geladen…</p>`, one-line errors, one-sentence empty states with no next step and no "no data" vs "no matches" distinction. |
| Portal | The API health notification on the participant's home; the home is a greeting, a channel list and four links, with no "what is still missing". |

## Design principles (become `docs/architecture/ui-patterns.md` in 6b-2)

1. **One job per screen, three things that matter.** Every screen states its job in the plan of
   the PR that builds it; the top of the screen answers "what needs me now?".
2. **Four layers of disclosure.** Glance (page header, today's tiles) → list or overview → detail
   (tabs) → action (side panel or modal). A control appears in the layer where its object is, and
   only when it can apply (bulk actions only with a selection; admin settings only in "Einrichtung").
3. **One primary action per page,** top right in the page header; secondary actions in an
   "Aktionen" menu (like the attached reference); row actions in the row's overflow menu.
4. **Status has one visual language.** A central map from each status/track/deadline state to a
   Carbon tag type and icon: red = overdue/blocked, yellow = due soon/needs confirmation,
   green = done, blue = in progress/info, gray = inactive/terminal. Never colour alone: tag text and
   an icon carry the meaning (WCAG 1.4.1).
5. **Dates are relative and absolute:** "seit 3 Tagen überfällig · 03.11.2026" in lists; the
   absolute date in `TT.MM.JJJJ` always present.
6. **Name a heading once.** A tab label is the panel's name; panels don't repeat it as an `h2`
   (the panel is labelled by its tab). One `h1` per page; `h2`/`h3` get the type scale from one rule
   in `packages/ui`, never from the component they sit in.
7. **Every state is designed:** loading = skeleton of the final layout; empty = what this is, why
   it is empty, the next step (and "Filter zurücksetzen" when filters cause it); error = what
   failed and how to retry; forbidden = who may see it.
8. **Spacing and layout come from `packages/ui` primitives** (`Stack`, `Grid`, `Section`, `Card`),
   never from a class named for something else.
9. **Data protection stays visible in the design:** no personal data in browser storage (the
   search term stays in state, data-protection.md), sensitive blocks behind "Anzeigen", no
   analytics on work list interactions.

## Decisions

- **D1. Placement: before Slice 7.** Slice 7 (DSV) adds a list ("participant signed, not fully
  executed"), a track to the participant page and several document actions; Slice 8 adds the whole
  TG participant file. Building them on the new patterns is cheaper than retrofitting three slices.
  The slice is bounded (six PRs, no domain changes); the deeper polish (D9) waits for later.
- **D2. Carbon stays; no Tailwind/shadcn.** Keep `@carbon/react` behind `packages/ui` so the
  planned Carbon v12 upgrade still touches one package (ADR-0003). New patterns (page header, side
  panel, empty state, filter panel, batch bar) are thin wrappers in `packages/ui` built from
  `@carbon/react` primitives and following the Carbon for IBM Products patterns — not a dependency
  on `@carbon/ibm-products` (its bundle, its CSP behaviour and its release cadence against v12 are
  unknown; Q211). The Carbon v12 migration itself is not in this slice: when v12 is stable it is
  its own PR touching `packages/ui` only.
- **D3. Theme:** `g100` for the header (dark band, as in the reference), `g10` for the content,
  via Carbon's `Theme` zones. Dark mode for the content is later (D9).
- **D4. Product identity:** an SVG mark and favicon (self-hosted, `img-src 'self'` suffices) and
  the product name from i18n; the real name, mark and accent colour are the owner's (Q210). Until
  then a neutral placeholder mark.
- **D5. The work list sorts by urgency by default,** in the browser over the snapshot (it is
  already loaded whole): overdue first, then the nearest deadline, then the most open items, then
  last name. Sortable column headers override it; the sort sits in the URL as a code (`sort=`),
  like the code filters. The API order stays (deterministic snapshot); nothing changes server side.
- **D6. Quick views and a filter panel replace the filter grid.** A row of quick views above the
  table (role-dependent: "Überfällig", "Diese Woche fällig", "Handlungsbedarf", "Ohne Berater" for
  the PL; "Meine Teilnehmenden" first for a consultant) — each one an existing `WorklistFilter`.
  All 14 filters move into a "Filter" side panel grouped as *Status* (main, profiling, DSV, flags),
  *Fristen & Termine* (deadline kind/state, appointment), *Zuständigkeit* (consultant, wave),
  *Erreichbarkeit* (portal, activation, notice, Agentur). Active filters show as dismissible tags
  above the table. The URL contract of the code filters is unchanged, so every dashboard link
  keeps working.
- **D7. Default columns: six (seven in `ta_tg`).** *Teilnehmende* (last, first name; Personalnummer
  as a secondary line), *Status* (main status tag; profiling/DSV as small secondary tags),
  *Nächster Schritt* (the most urgent open item and "+n weitere"), *Frist* (D5's urgency with
  relative date), *Beratung*, *Welle* (`ta_tg`), and a row overflow menu. The other columns
  (Agentur, Portal, Erinnert, Aktivierung, Hinweis, Termin) are available through a column chooser.
  The chosen column keys (codes only, never data) may persist in `localStorage` per user (Q212).
- **D8. Bulk actions as a batch bar.** Carbon `TableBatchActions` appears only with a selection:
  "Berater zuweisen", "Welle zuweisen", "Erinnern", "Einladen", "Kug 200b erzeugen",
  "Aktivierung drucken" as buttons (overflow when more than four); each opens a side panel or modal
  with its choice and its existing preview/confirmation. Capabilities decide which buttons exist,
  as today.
- **D9. Later, not in this slice** (to be placed by the owner; proposed into Slice 9 hardening or
  v1.1): content dark mode; server-side saved views; a cross-project staff start page "Meine
  Aufgaben" (needs a cross-project API and its own access decision, Q213); keyboard shortcuts and a
  command palette (the search-term rules apply); density setting; visual regression screenshots;
  the Carbon v12 upgrade.
- **D10. Responsive scope for the staff app:** full use from 1280px; usable navigation and reading
  from 768px (tablet); under 768px the shell works (menu, no overlap) but the work list is not
  optimised (Q214). The portal stays mobile-first at 320px.
- **D11. Usability check:** before 6b-3 merges, a 30-minute walkthrough with one PL and one
  consultant on synthetic data against the top tasks below; findings go into the PR, not a new
  round of plans.

## Top tasks the screens are designed for

| Role | Task | Path after this slice |
|---|---|---|
| PL | "What is overdue today and who is it?" | Project → Übersicht: "Heute zu tun" tiles → work list filtered and sorted by urgency |
| PL | Remind everyone with missing data | Work list → quick view "Handlungsbedarf" → select all → batch bar "Erinnern" → side panel preview → send |
| Consultant | "What is my next step for each of my people?" | Work list opens as "Meine Teilnehmenden", column *Nächster Schritt* |
| Consultant | Work one participant | Participant page → overview: status, what's missing, next deadlines/appointments → the tab the open item links to |
| Back office | Assign a wave, print activation letters | Work list → selection → batch bar |
| Participant | "What do I still have to do?" | Portal home: checklist with progress, next appointment, then the wizard |

## PRs

| PR | Scope | Est. lines | Depends on |
|---|---|---|---|
| 6b-1 | Shell and chrome | ~700 | – |
| 6b-2 | UI kit: page header, states, cards, status tags, `ui-patterns.md` | ~1,100 | 6b-1 |
| 6b-3 | Work list | ~1,450 | 6b-2 |
| 6b-4 | Project page, dashboard, projects list | ~900 | 6b-2 (6b-3 for the quick-view links) |
| 6b-5 | Participant page | ~1,000 | 6b-2 |
| 6b-6 | Portal home and portal shell | ~600 | 6b-2 |

6b-4, 6b-5 and 6b-6 are independent of each other and can be built in parallel sessions.

### 6b-1 — Shell and chrome

- `AppShell` takes `nav` as optional: without it (login, logged out) no `SideNav` is rendered and
  `.tp-content` has no inline-start margin. The login page is a centred card.
- Responsive navigation: `HeaderMenuButton` + `SideNav` with `expanded` state, rail mode
  (`isRail`) from 66rem, overlay with focus trap and Escape below it; the state of a manual toggle
  in component state only.
- Side nav icons (Carbon icons) and an active-route indicator; grouping "Arbeit" (Projekte,
  Freigaben) and "Verwaltung" (Mitarbeitende, Regionen, Eskalationen).
- Header: product mark + name (D4), `g100` theme zone (D3); the user's name, role and "Abmelden" in
  a `HeaderPanel` behind a user icon instead of loose text and button; the dev user switcher stays
  dev-only inside that panel.
- Favicon and `<title>` per route ("Teilnehmende · Projekt Nord – Transferplattform"), through i18n.
- Content max-width (`max-inline-size: 99rem`, centred) and the global type scale for `h1`–`h3`.
- e2e: a second Playwright project at 768px and 375px for a shell smoke test (menu opens/closes,
  focus returns, axe passes); the existing suite stays on Desktop Chrome.

### 6b-2 — UI kit and patterns

In `packages/ui`, each with component tests (keyboard, axe through the e2e pages that use them):

- `PageHeader` v2: breadcrumbs, title, subtitle/metadata line, status tags, one primary action and
  an "Aktionen" overflow menu.
- `Section` and `Card` (title, optional description and actions, body), `Grid` (1/2/3 columns
  collapsing by breakpoint, logical properties only).
- `StatusTag` + one map from the domain's status, track, deadline and flag codes to tag type,
  icon and label key (principle 4) — lives in `packages/ui`, the codes come from `packages/domain`.
- `RelativeDate` ("in 3 Tagen", "seit 2 Tagen überfällig") with the absolute date.
- States: `PageSkeleton`, table skeleton (Carbon `DataTableSkeleton`), `EmptyState` (variants
  `noData`, `noMatches` with "Filter zurücksetzen", `forbidden`, `error` with retry), `Loading`
  replacing the loose `<p>`s.
- `SidePanel` (Carbon `Modal`-based or a focus-trapped `aside`, decided in the PR with axe) for
  filters and bulk actions.
- `DataTable` v2 replacing `SimpleTable` where a list is interactive: sortable headers,
  sticky header, selection with batch bar, row overflow menu, column chooser, "Weitere anzeigen".
  `SimpleTable` stays for small read-only tables.
- Remove the `tp-load-more` misuse and the `tp-bulk-actions` wrapper around the search; replace
  with the layout primitives.
- `docs/architecture/ui-patterns.md` with principles 1–9 and when to use which pattern;
  CLAUDE.md's definition of done gets "UI follows `docs/architecture/ui-patterns.md`".

### 6b-3 — Work list

- D5–D8: urgency sort, sortable headers (`sort` in the URL), quick views, filter side panel with
  grouped filters and active-filter tags, search in the table toolbar (Carbon `TableToolbarSearch`,
  term in state only), six default columns + chooser, batch bar, row click to the participant.
- The "Teilnehmende hinzufügen" action moves into the page header as the primary action
  (with the import capability), the import link next to it in "Aktionen".
- Summary line becomes the toolbar's count: "142 Teilnehmende · Stand 09:41".
- The 2,000-row budget test in `dashboard.spec.ts` stays and must still pass; a new budget for the
  initial sort (snapshot to first rendered row) is reported with `PERF_BUDGET`.
- Existing e2e specs that click filters or bulk controls are migrated to the new controls; the
  assertions on what is shown and sent stay unchanged.

### 6b-4 — Project page, dashboard and projects list

- Project `PageHeader`: breadcrumb "Projekte / Projekt Nord", customer, type and status as tags,
  the region as metadata text; changing the region moves to "Einrichtung" (for those who may).
- Tabs reordered by frequency: Übersicht, Teilnehmende, Termine, Agentur (`ta_tg`), Einrichtung,
  Team. No repeated headings (principle 6).
- "Einrichtung" becomes sections with cards (Projekt, Agentur, Wellen, Kug 200a-Kopf, Import)
  and an in-page anchor list on wide screens.
- Dashboard ("Übersicht") in three layers:
  1. *Heute zu tun*: up to four severity tiles from the existing counts (overdue deadlines,
     due this week, needs action, needs resolution), each a card with icon, number, label, a
     severity border and an arrow; "Alles erledigt" when all are zero.
  2. *Verlauf*: the lifecycle funnel as horizontal bars (main status, and DSV in `ta_tg`) drawn
     with CSS widths through React `style` props (CSSOM, allowed by the CSP; app.ts) plus the
     numbers as text; the dashboard's comment about charts is corrected.
  3. *Alle Kennzahlen*: the remaining groups as compact cards in a 3-column grid, collapsed by
     default below 1280px.
  Every number still opens the work list with its filter (unchanged contract).
- Projects list: one title; status tags; "Neues Projekt" as the primary action; an empty state
  that explains how a project is created and by whom.

### 6b-5 — Participant page

Modelled on the attached reference (header with actions, columns that separate concerns):

- `PageHeader`: breadcrumb "Projekte / Projekt Nord / Teilnehmende / Muster, Erika",
  Personalnummer and wave as metadata, the three track tags (main, profiling, DSV), the
  capability-driven actions in "Aktionen" (Aktivierungscode, Erinnern, Einladen, Assistierter
  Modus, …).
- `detail.hints` become one "Handlungsbedarf" notification listing the hints, not one banner each.
- Overview tab as a three-column grid (one column under 1056px):
  *Stand* (lifecycle progress as a Carbon `ProgressIndicator` of the phase-1 steps, read-only,
  labels from the domain's status codes; dates of entry/exit/withdrawal) ·
  *Offen* (the participant's open items and deadlines from the work list item, each linking to
  the tab that resolves it) ·
  *Termine & Zuständigkeit* (next appointment, consultants, placement Agentur).
  Person and contact facts move into a "Stammdaten" card below; activation, assignments, wave and
  dates become cards whose edit forms open in a side panel instead of inline forms.
- The progress indicator shows the fixed lifecycle core only; no regional step is hard-coded
  (ADR-0004); if a step depends on configuration it comes from the resolved config or is omitted.
- Tabs keep their capabilities rules (Profiling, Arbeitsuche); "Verlauf" last.

### 6b-6 — Portal

- Remove `ApiStatus` from the participant's home (the health endpoint stays for operations).
- Home for a logged-in participant: "Das fehlt noch" checklist (self-service sections with their
  completion, from the existing self-service data; an API addition only if the progress isn't
  derivable client-side, named in the PR), a progress bar, the next appointment card, then links
  as cards (Selbstauskunft, Termine, Einwilligungen). Channels move to an "Mein Konto" page with
  logout.
- Logged-out home: one clear choice, "Anmelden" or "Mit Aktivierungscode starten", with a short
  explanation of each.
- Portal header: language switch and account menu in the header instead of the page body; still
  no staff code (lint rule).
- `de` + `en`, RTL-ready, 320px; axe on every changed page.

## Acceptance criteria

1. `/login` at 1440px and 375px: no side navigation, the form centred; axe passes.
2. At 768px and 375px the staff shell shows a menu button; the nav opens as an overlay, closes on
   Escape and returns focus; no horizontal page scroll; axe passes (new e2e project).
3. Every staff page has exactly one `h1`; no tab panel repeats its tab's label as a heading; the
   projects page shows "Projekte" once.
4. The project and participant pages show breadcrumbs; the participant page's breadcrumb links back
   to the work list with its filters.
5. The work list opens sorted by urgency without any filter: a participant with an overdue
   deadline is above one without (component test on synthetic data); a column header changes the
   sort and the URL gets `sort=`; reload keeps it.
6. With nothing selected, no bulk control is rendered; selecting a row shows the batch bar with
   only the actions the capabilities allow.
7. At 1440×900 the first work-list row is visible without scrolling (e2e).
8. The default work list has at most seven columns; the chooser adds the others; the stored
   preference contains column keys only (unit test on what is written).
9. The search term never appears in the URL, a query key or browser storage (the existing test
   stays; a new one covers the toolbar search).
10. Every dashboard number still opens the work list with exactly the counted rows (the existing
    e2e stays green unchanged in its assertions).
11. The region select is no longer above the project tabs; it is in "Einrichtung" for those who may
    change it.
12. Loading shows a skeleton; an empty list distinguishes "no participants yet" from "no matches"
    and offers "Filter zurücksetzen" in the latter.
13. The portal home shows no API status; a logged-in participant sees what is still missing and
    the progress.
14. The 2,000-row budget and every existing axe check still pass; no CSP violation (the e2e fail on any).
15. `ui-patterns.md` exists and is linked from CLAUDE.md and `architecture/overview.md`.

## Not in this slice

Domain or lifecycle changes, new access rules, new list fields beyond what a PR names, the items of
D9, a re-theme beyond D3, Carbon v12.

## Questions for the owner (open-questions.md)

Q210 product name, mark and accent colour; Q211 `@carbon/ibm-products` or own wrappers; Q212
column preferences in `localStorage`; Q213 a cross-project "Meine Aufgaben" start page; Q214 the
staff app's minimum viewport.
