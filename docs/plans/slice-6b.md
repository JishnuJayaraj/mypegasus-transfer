# Slice 6b — UX foundation (staff app and portal)

Status: **revised** after the owner's review of 2026-11-06: Q221–Q225 answered (the
owner's decisions, recorded in D2, D3, D4, D7, D9 and D10), the quick views, the dashboard's
empty text and the back-office task corrected, and the contracts C1–C6 added. 6b-1 and 6b-2 may
start; 6b-3 waits for D6/C2 as written here, 6b-4 for the dashboard text in 6b-4. Sequencing with
Slice 7: D1.
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
9. **Data protection stays visible in the design:** nothing in browser storage in this slice
   (the search term and column choice stay in memory, data-protection.md; Q223), sensitive blocks
   behind "Anzeigen", no analytics on work list interactions.

## Decisions

- **D1. Placement: interleaved with Slice 7, UI-first where they meet.** Slice 7 (DSV) adds a list
  ("participant signed, not fully executed"), a track to the participant page and several
  document actions; Slice 8 adds the whole TG participant file. Building their screens on the new
  patterns is cheaper than retrofitting. The order:
  1. This plan and Slice 7's plan (PR #104) are merged (2026-11-06).
  2. 6b-1 (shell) and 6b-2 (UI kit) next, in parallel with Slice 7's backend PRs (schema, status
     functions, guards, jobs, API), which need no UI.
  3. 6b-3 (work list) before 7-4 (the DSV work list, bulk generation, the cutoff cases), so the
     DSV list and its quick view are built once on the new table. The other Slice 7 PRs use
     6b-2's components for their web parts once merged; none waits for 6b-4 to 6b-6.
  4. 6b-4, 6b-5 and 6b-6 alongside the rest of Slice 7; 6b-5 before Slice 7's participant-page PR
     if they collide, else Slice 7 adds its track card to the new overview afterwards.
  The deeper polish (D9) waits for later.
- **D2. Carbon stays; no Tailwind/shadcn.** Keep `@carbon/react` behind `packages/ui` so the
  planned Carbon v12 upgrade still touches one package (ADR-0003). New patterns (page header, side
  panel, empty state, filter panel, batch bar) are thin wrappers in `packages/ui` built from
  `@carbon/react` primitives and following the Carbon for IBM Products patterns — no
  `@carbon/ibm-products` dependency in this slice (Q222, the owner's decision). A wrapper is built
  when a named consumer in this slice needs it, never speculatively. The Carbon v12 migration
  itself is not in this slice: when v12 is stable it is its own PR touching `packages/ui` only.
- **D3. Theme:** `g100` for the header (dark band, as in the reference), `g10` for the content,
  via Carbon's `Theme` zones, with Carbon's existing interactive blue as the accent (Q221). Dark
  mode for the content is later (D9).
- **D4. Product identity (Q221, the owner's decision):** the name "Transferplattform" from i18n,
  Carbon's accent, and a neutral placeholder SVG mark and favicon (self-hosted, `img-src 'self'`
  suffices). Final branding is independent of this slice and swaps the mark and favicon only.
- **D5. The work list sorts by urgency by default,** in the browser over the snapshot (it is
  already loaded whole): overdue first, then the nearest deadline, then the most open items, then
  last name. Sortable column headers override it; the sort sits in the URL as a code (`sort=`),
  like the code filters. The API order stays (deterministic snapshot); nothing changes server side.
- **D6. Quick views and a filter panel replace the filter grid.** A row of quick views above the
  table. Each quick view is exactly one existing `WorklistFilter` with an unchanged predicate
  (`packages/domain/src/worklist/filter.ts`), and its label says what that predicate selects —
  never more. Choosing a quick view replaces the current filters; the count shows in the label.

  | Quick view (label) | Filter | Selects exactly | Shown to |
  |---|---|---|---|
  | Alle | `{}` | the viewer's whole list scope (an assigned consultant: their assigned participations, so the toolbar says "Ihre zugewiesenen Teilnehmenden") | everyone with the work list |
  | Überfällig | `deadlineState: overdue` | at least one listed deadline whose date has passed (deadlines.ts) | everyone |
  | In den nächsten 14 Tagen | `deadlineState: upcoming` | at least one deadline from today to 14 calendar days ahead, the date included (Q78's horizon) | everyone |
  | Angaben/Unterlagen fehlen | `actions: any` | at least one missing participant field or document, or a rejected upload (the participant's actions; not staff work) | everyone |
  | Hinweise | `flag: any` | at least one lifecycle flag (conflicts, missed TG start, cutoff warnings …) | everyone |
  | Termine zu klären | `appointment: to_resolve` | appointment items needing resolution | PL (the only resolver, data-protection.md) |
  | Ohne Beratung | `consultant: none` | no assigned consultant | PL and back office |
  | Mir zugewiesen | `consultant: <own staff id>` | assigned to the viewer | a PL who is also a consultant of the project |

  The quick view and the dashboard tile with the same filter share one i18n key, so their labels
  can't drift (a unit test asserts each pair's filters are equal); the tile "Frist in 14 Tagen"
  and "mit offenen Angaben oder Unterlagen" are renamed to the labels above. Slice 7 adds its DSV
  quick view the same way. A view with count 0 stays visible (disabled is not used; the empty
  state explains it).
  All 14 filters move into a "Filter" side panel grouped as *Status* (main, profiling, DSV, flags),
  *Fristen & Termine* (deadline kind/state, appointment), *Zuständigkeit* (consultant, wave),
  *Erreichbarkeit* (portal, activation, notice, Agentur). Active filters show as dismissible tags
  above the table. The URL contract of the code filters is unchanged, so every dashboard link
  keeps working.
- **D7. Default columns: six (seven in `ta_tg`).** *Teilnehmende* (last, first name; Personalnummer
  as a secondary line), *Status* (main status tag; profiling and DSV as separate tags, C3),
  *Nächster Schritt* (C2, and "+n weitere"), *Frist* (D5's urgency with relative date),
  *Beratung*, *Welle* (`ta_tg`), and a row overflow menu. The other columns (Agentur, Portal,
  Erinnert, Aktivierung, Hinweis, Termin) are available through a column chooser. The choice is
  kept **in memory only** for the session (Q223, the owner's decision): not in `localStorage`, not
  in the URL; a reload restores the defaults. Persistent per-user storage follows only after the
  DPO check (D9), since a user id in a storage key is still an identifier.
- **D8. Bulk actions as a batch bar.** Carbon `TableBatchActions` appears only with a selection:
  "Berater zuweisen", "Welle zuweisen", "Erinnern", "Einladen", "Kug 200b erzeugen",
  "Aktivierung drucken" as buttons (overflow when more than four); each opens a side panel or modal
  with its choice and its existing preview/confirmation. Capabilities decide which buttons exist,
  as today.
- **D9. Later, not in this slice** (to be placed by the owner; proposed into Slice 9 hardening or
  v1.1): content dark mode; server-side saved views; persistent column preferences after the DPO
  check (Q223); a cross-project staff start page "Meine Aufgaben" — wanted (Q224, the owner's
  decision), with its cross-project API and access model as its own scope; it blocks nothing
  here; keyboard shortcuts and a command palette (the search-term rules apply); density setting;
  visual regression screenshots; the Carbon v12 upgrade; the participant timeline (D12) once
  Slice 8's data exists.
- **D10. Responsive scope (Q225, the owner's decision):** 1280px is the *preferred* layout, not a
  functional cutoff. At any width — including 400% zoom of a 1280px window (320 CSS px, WCAG
  1.4.10 Reflow) — forms, filters, side panels and dialogs reflow into one column and stay fully
  usable without two-dimensional scrolling. Data tables may scroll horizontally inside their own
  container (an exception Reflow allows); the page itself never does. The portal stays
  mobile-first at 320px. Each UI PR adds a manual zoom check (200% and 400%, Chrome) to its
  description alongside the axe results.
- **D11. Usability check:** before 6b-3 merges, a 30-minute walkthrough with one PL and one
  consultant on synthetic data. Concrete tasks, each timed and observed, not a tour:
  1. "Find everyone whose deadline has passed and tell me the most urgent one."
  2. "For this participant, what is the next step and why?" (explain from *Nächster Schritt* and
     the overview alone)
  3. "Prepare a reminder for everyone with missing documents, show me the preview, don't send."
  4. "Open one of them, then return to the list" — the filters, sort and quick view must be intact.
  Findings go into the PR, not a new round of plans.
- **D12. Participant timeline (the owner's idea, 2026-11-06): yes, as a card on the participant
  overview, staged.** A horizontal time axis from the first relevant date to the planned TG end,
  with a "heute" marker; bars for phases (Transferagentur phase, TG period from `tgEntryDate` to
  the planned or actual exit), point markers for dated facts (DSV signed, profiling session, ASU
  registration, deadlines, appointments), and from Slice 8 bars for leave (Urlaub), qualification
  measures and other absences, each kind with its own colour **and** pattern/icon and a text
  label. Hover and keyboard focus show a tooltip with kind, dates and status; every marker is a
  focusable link to the tab that holds it. Below the graphic, the same events as a list (the
  accessible equivalent, and what a screen reader and the 400% zoom see). Drawn as inline SVG
  with CSS classes (no inline `<style>`, CSP-safe), no chart library.
  *Stage 1 (6b-5):* only facts the participant page already loads (status dates, deadlines,
  appointments) — no new API, nothing sensitive. *Stage 2 (Slice 8):* leave, qualification and
  coaching, which don't exist yet; each event kind passes the field-level access matrix
  (data-protection.md) like any other field, and an absence's reason is never shown unless its
  data class allows it (sensitive categories need a decision of their own, data-protection.md). It is also the natural seed of a project-level "Gantt" of waves, which waits for D9.

## Top tasks the screens are designed for

| Role | Task | Path after this slice |
|---|---|---|
| PL | "What is overdue today and who is it?" | Project → Übersicht: "Heute zu tun" tiles → work list filtered and sorted by urgency |
| PL | Remind everyone with missing data | Work list → quick view "Angaben/Unterlagen fehlen" → select all → batch bar "Erinnern" → side panel preview → send |
| PL | Assign a wave | Work list → selection → batch bar "Welle zuweisen" (the PL's capability, unchanged) |
| Consultant | "What is my next step for each of my people?" | Work list (their assigned scope), column *Nächster Schritt* |
| Consultant | Work one participant | Participant page → overview: status, what's missing, next deadlines/appointments → the tab the open item links to |
| Back office | Print activation letters | Work list → selection → batch bar "Aktivierung drucken" → print view |
| Back office | Record a BA report | Participant page → "Handlungsbedarf"/*Offen* → BA reporting task → `reported` or `not_required` (the PL or back office closes one, data-protection.md) |
| Participant | "What do I still have to do?" | Portal home: checklist with progress, next appointment, then the wizard |

## Contracts (before the owning PR)

Small rules every UI PR from 6b-2 on follows; each lands in `ui-patterns.md` with 6b-2, and the
owning PR tests it.

- **C1. Blocked actions (6b-2; every PR with actions).** An action the viewer is not authorised for
  is **not rendered** (capabilities, as today). An authorised action that is temporarily
  unavailable is rendered disabled **with its prerequisite next to it** ("Erst möglich, wenn der
  DSV-Scan geprüft ist"), from the API's refusal code or the capability's reason code — never a
  bare disabled button and never a tooltip-only explanation (not reachable by touch or zoom). A
  batch action that applies to only some selected rows says how many and why ("12 von 15: 3 ohne
  Kanal"), as the reminder preview already does.
- **C2. "Nächster Schritt" (6b-3; a domain function with full tests).** `nextStep(item)` in
  `packages/domain/src/worklist/` picks one item from everything the row already carries, by tier,
  then by date within a tier (oldest overdue first, nearest upcoming first), then by the existing
  kind order:
  1. *Overdue:* overdue deadlines, overdue appointments, appointments to resolve.
  2. *Undated or escalated work that must not wait for a date:* case items
     (`evidence_invalidated` "Nachweis ungültig", the Kug 200b offer and withdrawal notice), open
     Agentur items, lifecycle flags (conflicts, missed TG start, cutoff warnings). An undated item
     is never ranked below a dated one of a lower tier.
  3. *Upcoming deadlines* (within the 14-day horizon).
  4. *Participant actions:* rejected uploads first, then missing documents, then missing fields.
  5. Nothing open: "–".
  The column shows the item's label and, for tiers 1 and 3, its relative date; "+n weitere" opens
  the full list in the row's detail. The work list's default sort (D5) uses the same tiers, so the
  first row is always the most urgent *step*, not only the nearest date. Slice 7 adds its DSV items
  to a tier in its own PR; the tiers are a product rule and live in process-and-lifecycle.md's
  work-list section, not only in code.
- **C3. Parallel tracks (6b-3, 6b-5).** The main status, the profiling track and the DSV track
  run concurrently (process-and-lifecycle.md). They are shown as **three separate status
  summaries**, each with its own tag and, where useful, its own short step list — never one linear
  progress indicator that implies profiling must finish before the DSV, or the reverse. A
  `ProgressIndicator` is allowed only within one track.
- **C4. Drafts (6b-2 `SidePanel` and every modal with input).** A side panel or modal with edited
  input does not discard it silently: closing (×, Escape, clicking outside, navigating) with
  unsaved changes asks "Änderungen verwerfen?" (Verwerfen / Weiter bearbeiten), with focus on the
  safe choice. Draft values stay in component state only — never in browser storage when they can
  hold personal data. Saving keeps the panel open on a validation error with the input intact.
- **C5. Portal progress (6b-6).** The home's progress counts **participant tasks**, not fields:
  the self-service sections the participant must complete, the required uploads, required
  consents and booked appointments, from the completeness engine's existing result. Optional
  information is listed separately as "Freiwillig" and never lowers the percentage. Progress is
  computed from presence flags and the completeness result, **never by loading sensitive values**
  (special-category or highly confidential fields stay behind their own endpoints,
  data-protection.md); if the portal can't derive it without them, 6b-6 adds a value-free
  progress field to the API and says so in the PR.
- **C6. Return paths (6b-3, 6b-5).** Leaving the work list for a participant and coming back
  restores the quick view, filters, sort and scroll position; the code filters and sort come from
  the URL, the search term from in-memory state (never stored, data-protection.md), so a full
  reload loses only the search term.

## PRs

| PR | Scope | Est. lines | Depends on |
|---|---|---|---|
| 6b-1 | Shell and chrome | ~700 | – |
| 6b-2 | UI kit: page header, states, cards, status tags, `ui-patterns.md` | ~1,100 | 6b-1 |
| 6b-3 | Work list (incl. `nextStep`, C2) | ~1,500 | 6b-2 |
| 6b-4 | Project page, dashboard, projects list | ~900 | 6b-2 (6b-3 for the quick-view links) |
| 6b-5 | Participant page (incl. timeline stage 1, D12) | ~1,300 | 6b-2 |
| 6b-6 | Portal home and portal shell | ~600 | 6b-2 |

6b-4, 6b-5 and 6b-6 are independent of each other and can be built in parallel sessions. Gates:
6b-1 and 6b-2 may start now; 6b-3 needs D6 and C2 as written here; 6b-4 the dashboard text below.

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
  focus returns, no page-level horizontal scroll, axe passes); the existing suite stays on Desktop
  Chrome. The 375px run stands in for 400% zoom of a 1280px window (D10); the manual zoom check
  (200%/400%) is in the PR description.

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
  filters and bulk actions, with C4's unsaved-changes confirmation built in; full-width below
  42rem (D10).
- A disabled-with-reason pattern for actions (C1).
- `DataTable` v2 replacing `SimpleTable` where a list is interactive: sortable headers,
  sticky header, selection with batch bar, row overflow menu, column chooser, "Weitere anzeigen".
  `SimpleTable` stays for small read-only tables.
- Remove the `tp-load-more` misuse and the `tp-bulk-actions` wrapper around the search; replace
  with the layout primitives.
- Each component lands with its first consumer in this slice (D2); none without one.
- `docs/architecture/ui-patterns.md` with principles 1–9, contracts C1–C6 and when to use which
  pattern;
  CLAUDE.md's definition of done gets "UI follows `docs/architecture/ui-patterns.md`".

### 6b-3 — Work list

- `nextStep` (C2) in `packages/domain` with full coverage, its tiers written into
  process-and-lifecycle.md's work-list section; the default sort (D5) uses its tiers.
- D5–D8: urgency sort, sortable headers (`sort` in the URL), quick views (D6's table, the renamed
  tile labels), filter side panel with
  grouped filters and active-filter tags, search in the table toolbar (Carbon `TableToolbarSearch`,
  term in state only), six default columns + in-memory chooser, batch bar with C1's partial-apply
  counts, row click to the participant, C6's return path.
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
  1. *Heute zu tun*: up to four severity tiles from the existing counts, with D6's labels and
     filters: "Überfällig", "In den nächsten 14 Tagen", "Angaben/Unterlagen fehlen" and, for the
     PL, "Termine zu klären" (else "Hinweise"); each a card with icon, number, label, a severity
     border and an arrow. When all four are zero the row reads **"Keine offenen Punkte in diesen
     Ansichten"** — never "Alles erledigt": open work outside these views (a mandatory BA
     reporting task, also after the participation closed; Agentur items; flags; Slice 7's DSV
     items) is not counted there. Directly below, the other open-work counts stay reachable
     ("Weitere offene Arbeit": Hinweise, Agentur offen, nicht erreichbar, …). A true all-clear
     would need every relevant category checked and is not offered in this slice.
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
  *Stand* (three separate summaries per C3 — main status, profiling track, DSV track (`ta_tg`) —
  each a tag, its current step and its key date; dates of entry/exit/withdrawal) ·
  *Offen* (the participant's open items in C2's order — deadlines, case items, flags, Agentur
  items, BA reporting tasks, participant actions — each linking to the tab that resolves it,
  with C1's prerequisite where an action is blocked) ·
  *Termine & Zuständigkeit* (next appointment, consultants, placement Agentur).
  Person and contact facts move into a "Stammdaten" card below; activation, assignments, wave and
  dates become cards whose edit forms open in a side panel instead of inline forms.
- The track summaries show the fixed lifecycle core only; no regional step is hard-coded
  (ADR-0004); if a step depends on configuration it comes from the resolved config or is omitted.
- Timeline stage 1 (D12) as a full-width card below the three columns: facts the page already
  loads, the list equivalent below it, no new API.
- Tabs keep their capabilities rules (Profiling, Arbeitsuche); "Verlauf" last.

### 6b-6 — Portal

- Remove `ApiStatus` from the participant's home (the health endpoint stays for operations).
- Home for a logged-in participant: "Das fehlt noch" checklist of participant tasks with a
  progress bar per C5 (optional information separate as "Freiwillig", never counted; no sensitive
  value loaded to compute it), the next appointment card, then links
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
   Escape and returns focus; no horizontal page scroll; axe passes (new e2e project). At 375px
   every filter, side panel and dialog of the changed pages is usable; only a table scrolls,
   inside its container (D10); the manual 200%/400% zoom check is in each UI PR.
3. Every staff page has exactly one `h1`; no tab panel repeats its tab's label as a heading; the
   projects page shows "Projekte" once.
4. The project and participant pages show breadcrumbs; the participant page's breadcrumb links back
   to the work list with its filters.
5. The work list opens sorted by C2's tiers without any filter: an overdue deadline above an
   undated "Nachweis ungültig", that above an upcoming deadline, that above a missing field
   (domain tests cover every tier and tie); a column header changes the sort and the URL gets
   `sort=`; reload keeps it.
6. With nothing selected, no bulk control is rendered; selecting a row shows the batch bar with
   only the actions the capabilities allow.
7. At 1440×900 the first work-list row is visible without scrolling (e2e).
8. The default work list has at most seven columns; the chooser adds the others; nothing of the
   choice is written to browser storage or the URL (test), and a reload restores the defaults.
9. The search term never appears in the URL, a query key or browser storage (the existing test
   stays; a new one covers the toolbar search).
10. Every dashboard number still opens the work list with exactly the counted rows (the existing
    e2e stays green unchanged in its assertions).
11. The region select is no longer above the project tabs; it is in "Einrichtung" for those who may
    change it.
12. Loading shows a skeleton; an empty list distinguishes "no participants yet" from "no matches"
    and offers "Filter zurücksetzen" in the latter.
13. The portal home shows no API status; a logged-in participant sees their open tasks and the
    progress; an optional item never changes the percentage; the home makes no request to a
    sensitive-field endpoint (e2e network assertion).
14. The 2,000-row budget and every existing axe check still pass; no CSP violation (the e2e fail on any).
15. `ui-patterns.md` exists and is linked from CLAUDE.md and `architecture/overview.md`.
16. Each quick view's label matches its filter (D6's table), and the quick view and its dashboard
    tile have equal filters (unit test).
17. With the four featured counts zero and an open BA reporting task, the dashboard says "Keine
    offenen Punkte in diesen Ansichten" and the other open-work counts remain linked (component
    test).
18. An authorised but blocked action shows its prerequisite as text; an unauthorised one isn't in
    the DOM (component tests, C1).
19. Closing a side panel with edited input asks before discarding; Escape on the dialog keeps the
    input (component test, C4).
20. No screen shows profiling and DSV as steps of one sequence (C3; reviewed in each PR's
    screenshots).
21. Back from a participant restores the quick view, filters, sort and scroll position (e2e, C6).

## Not in this slice

Lifecycle or status changes (C2's `nextStep` only reads the row), new access rules, new list fields beyond what a PR names, the items of
D9, a re-theme beyond D3, Carbon v12.

## Questions (open-questions.md)

Answered by the owner on 2026-11-06 ([the answers](../decisions/2026-11-06-answers-ux-foundation.md)), recorded as `accepted`: Q221 product
identity (D4), Q222 thin Carbon wrappers (D2), Q223 column preferences in memory (D7), Q224
"Meine Aufgaben" later in its own scope (D9), Q225 1280px preferred, reflow required (D10).
Q223 keeps a 🔒 for the DPO check before any persistent storage.
