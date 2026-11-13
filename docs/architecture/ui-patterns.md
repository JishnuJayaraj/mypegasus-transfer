# UI patterns (staff app and portal)

The product-design layer over Carbon. Every UI change follows this page; a pattern that is
missing here is added here in the PR that needs it. The components live in `packages/ui`
(ADR-0003: the apps use Carbon only through it) and are thin wrappers built from `@carbon/react`
primitives, following the Carbon for IBM Products patterns without depending on
`@carbon/ibm-products` (Q222). A wrapper is built only when a screen needs it.

## Theme and identity

Carbon's `Theme` zones: `g100` for the header band (staff app and portal), `g10` for the content,
Carbon's interactive blue as the accent (Q221). On top sits the product theme (Q254): white
cards on the `g10` background with an 8px radius and one soft elevation, 6px on controls, one
spacing scale. Its tokens are CSS custom properties in `packages/ui/src/theme.scss`
(`--tp-surface`, `--tp-radius-card`, `--tp-radius-control`, `--tp-elevation`, `--tp-space-1` to
`--tp-space-7` for 4 to 48px); a component uses the tokens, never a literal radius or shadow.

**Every override of a Carbon class (`.cds--…`) is in `theme.scss` and nowhere else**
(`theme.test.ts` fails otherwise), under the Carbon version it was checked against, which the
same test compares with the installed `@carbon/react`. An update of Carbon is therefore a review
of that one file: each block is checked again and the version raised. An override changes
appearance or layout only; Carbon's components keep their behaviour and their focus handling. The name comes from i18n ("Transferplattform",
"Teilnehmerportal"); the mark is a neutral placeholder SVG (`ProductMark`) with a self-hosted
favicon. Final branding swaps the mark and the favicon only. Dark mode for the content is later
(roadmap, Slice 6b's deferred items).

## Principles

1. **One job per screen, three things that matter.** Every screen states its job in the plan of
   the PR that builds it; the top of the screen answers "what needs me now?".
2. **Four layers of disclosure.** Glance (page header, today's tiles) → list or overview → detail
   (tabs) → action (side panel or modal). A control appears in the layer where its object is, and
   only when it can apply: bulk actions only with a selection, admin settings only in
   "Einrichtung".
3. **Buttons have one hierarchy.** One primary button per page, in its header: the next step of
   the object where the viewer may take it (`nextStep`, C2), else the page's creating action.
   Every other action sits beside the thing it acts on as an outlined button (`tertiary`) or a
   text button (`ghost`); further page actions are in the header's "Aktionen" menu with the
   destructive ones last, row actions in the row's overflow menu. Carbon's dark `secondary` kind
   is not used: the kit's `Button` has no such kind, and a modal's second button is shown as a
   text button (theme.scss). A blocked action keeps its prerequisite beside it (C1).
4. **Status has one visual language** (`StatusTag`, below): red = overdue/blocked, yellow = due
   soon/needs confirmation, green = done, blue = in progress/info, gray = inactive/terminal. Never
   colour alone: the tag's text and icon carry the meaning (WCAG 1.4.1).
5. **Dates are relative and absolute:** "seit 3 Tagen überfällig · 03.11.2026" in lists; the
   absolute `TT.MM.JJJJ` date is always present (`RelativeDate`).
6. **Name a heading once.** A tab label is the panel's name; a panel doesn't repeat it as an `h2`.
   A project's section, which is a route and no tab, is named by one `h2` under the project's
   header (`SectionHeading`). One `h1` per page (the page header's). Headings get their size from one rule, never from the
   component they sit in: `packages/ui/src/styles.scss` sets `h1` = `heading-04`, `h2` =
   `heading-03`, `h3` = `heading-02` under `:where(.tp-content, .tp-portal-content)`, as weak as an
   element selector so a Carbon component's own heading class (a modal title) still wins. A card's
   heading is `heading-compact-02` whatever its level.
7. **Every state is designed:** loading = a skeleton of the final layout; empty = what this is,
   why it is empty and the next step ("Filter zurücksetzen" when filters cause it); error = what
   failed and how to retry; forbidden = who may see it.
8. **Spacing and layout come from the kit** (`Stack`, `Grid`, `Section`, `Card`, `SectionCard`,
   `Facts`, a table's `footer`), never from a class in an app. `pnpm lint`
   (`scripts/check-layout-classes.mjs`) refuses a kit class (a string starting with `tp-`) and a
   style import in `apps/web` and `apps/portal`, except in the files of
   `scripts/layout-allowlist.json` that had them before the kit's second layer. The list only
   shrinks: a screen that migrates loses its entry, and a stale entry fails the check.
   `@carbon/react` is imported in `packages/ui` only, and a kit component's props name no Carbon
   type, so the kit's internals can change without touching the apps.
9. **Data protection stays visible in the design:** nothing in browser storage (the search term
   and the column choice stay in memory, data-protection.md; Q223), sensitive blocks behind
   "Anzeigen", no analytics on work-list interactions, no participant name in a page title
   (data-protection.md, page titles).

## Contracts

- **C1. Blocked actions.** An action the viewer is not authorised for is **not rendered** (the
  capabilities, as before). An authorised action that is temporarily unavailable is rendered
  disabled **with its prerequisite next to it** (`ActionButton`'s `unavailableReason`: "Erst eine
  Region wählen."), from the API's refusal code or the capability's reason code — never a bare
  disabled button and never a tooltip-only explanation (not reachable by touch or zoom). A batch
  action that applies to only some selected rows says how many and why ("12 von 15: 3 ohne
  Kanal"), as the reminder preview does.
- **C2. "Nächster Schritt".** `nextStep(item)` in `packages/domain/src/worklist/` picks one item
  per row by tier (overdue; undated or escalated work; upcoming deadlines; participant actions;
  nothing open "–"), then by date, then by the existing kind order. The tiers are a product rule
  in process-and-lifecycle.md ("The work list's next step and default order"); the work list's
  default sort (`urgencyOrder`) uses them.
- **C3. Parallel tracks.** The main status, the profiling track and the DSV track run
  concurrently (process-and-lifecycle.md). They are shown as **three separate status tags or
  summaries**, never one linear progress indicator that implies an order between profiling and the
  DSV. A `ProgressIndicator` is allowed only within one track.
- **C4. Drafts.** A side panel or modal with edited input does not discard it silently: closing
  (×, Escape, a click outside, a navigation, a reload) with unsaved changes asks "Änderungen
  verwerfen?" (Verwerfen / Weiter bearbeiten) with the focus on "Weiter bearbeiten"; Escape there
  keeps the input. Draft values stay in component state, never in browser storage. Saving keeps
  the panel open on a validation error with the input intact. A form in a side panel has no
  "Abbrechen" of its own: closing is the panel's.
- **C5. Portal progress.** The portal home counts participant tasks (sections, required uploads,
  consents, booked appointments) from the completeness result, never fields; optional information
  is "Freiwillig" and never lowers the percentage; progress never loads a sensitive value.
- **C6. Return paths.** Leaving the work list for a participant and coming back restores the
  quick view, filters, sort and scroll position: code filters and sort from the URL, the search
  term from memory, so a reload loses only the search term.

## Which pattern

| Need | Use | Notes |
|---|---|---|
| Top of an object's page | `DetailHeader` | `PageHeader`'s props in a card, plus `facts`: the one `h1`, one metadata line, the track tags (C3), up to five key facts (more are dropped: they belong on the page), the primary action and "Aktionen". |
| Top of a page | `PageHeader` | `breadcrumbs` (ancestor links; the page is the title), `title` (the one `h1`), `tags`, `metadata` (one plain line), `primaryAction` (one), `menuActions` ("Aktionen"; destructive ones last, in red). |
| A titled part of a page | `Section` | `h2` by default, `level={3}` inside a section, panel or tab. In a tab panel that is named by its tab, no section heading repeats the tab. |
| One topic that collapses | `SectionCard` | A titled card that collapses to its title and a one-line `summary`; the heading is the button (`aria-expanded`). The open state is component state only (principle 9): the card's own, or its caller's (`open`, `onToggle`) where an in-page link opens the card. `protectedContent` (specially protected data) never starts open, whatever `defaultOpen` says, and the content is in the document only while open. |
| Label and value pairs | `Facts` | A definition list in two or four columns (`columns`), the label beside or above its value (`labels`); one column at 400 % zoom; a missing value is "–". |
| Open items with their actions | `NextSteps` | The items in C2's order as the caller gives them, each with its tone as icon and text (`toneLabel`), one line of detail and its own action beside it; `summary` and `more` in the header; without items it says so (`emptyText`). |
| The steps of one track | `StepList` | For a long tab: the steps at the start, each with its state (icon and text) and one line of status; the selected step's content with its action beside them (below, under 66rem). It starts on the current step. One track only (C3). `keepMounted` keeps every step's content and hides all but the selected one, so an unsaved input survives a look at another step (C4); `selected` and `onSelect` let one step link to another. The step list in use, below. |
| Where one track stands | `TrackBar` | The track's name, its fixed path as a segmented bar (done, current, ahead; each step named for assistive technology, the current one `aria-current="step"`), its `StatusTag`, which carries the meaning as text, and one line under it. One bar per track, never one across tracks (C3); a status off the path has no bar. |
| A main and a side column | `Split side` | Side by side from 66rem (the side a third), the side column after the main one below. The side holds what is looked up (appointments, responsibility, deadlines), the main column what is worked on. |
| The stages of one track as counts | `Funnel` | One row of stages (count over label), each optionally a link to exactly the counted rows (`renderLink`); ended stages (`ended`) are set apart; the row wraps on narrow screens. |
| One topic as a block | `Card` | Details, a small form, a summary; a card's actions are its own. `id` makes it an in-page link target (`#project-import`). |
| A count to act on | `CountTile` | In a `CountTiles` row. A dashboard tile on the theme's surface: icon, number, label, a severity border (by `tone`; a zero is neutral) and an arrow, as one link to exactly the counted rows ("1 Überfällig"). Its label is the quick view's with the same filter. `TilesSkeleton` while loading. |
| A share of a total | `tp-count-table` with `tp-bar` | A compact count table in a card; the bar's width is set through React's `style` prop (the CSSOM, CSP-safe), the bar is `aria-hidden` and the number beside it is the text. No chart library. |
| Side by side | `Grid columns={2 or 3}` | One column below 42rem, two from 42rem, three from 66rem; logical properties only. `collapse="wide"` skips the two-column step (one column below 66rem) for columns that only read as a set, such as the participant overview's. |
| Vertical rhythm | `Stack gap={…}` | A button in a stack is wrapped in a `div` so it keeps its width. |
| A status, track, deadline state, flag, appointment or project status | `StatusTag family code` | One map (`statusTag`) from the domain's codes to tone, Carbon tag type, icon and label key (the app catalog's existing keys, e.g. `participants.statuses.*`). A new domain code fails the typecheck until it is mapped. Yellow is `yellow-10` with the warning colour as border, since Carbon has no yellow tag. `prefix` names the track where the code alone is ambiguous ("Profiling: Angenommen", C3). |
| A date in a list | `RelativeDate date today kind` | `kind="deadline"`: "in 3 Tagen", "heute fällig", "seit 2 Tagen überfällig" (overdue from the day after); `kind="event"`: "heute", "vor 2 Tagen". `today` is the caller's Berlin date (e.g. the snapshot's), never read by the component. |
| A route loading | `PageSkeleton` | The router's pending component. |
| A list loading | `TableSkeleton headers` | With the real column headers; announced through a hidden status. |
| A small part loading | `Loading label` | Replaces the loose "Wird geladen…" paragraphs. |
| Nothing to show | `EmptyState variant` | `noData` (what this is, why it is empty, the next step as `action`), `noMatches` (with `onResetFilters`: "Filter zurücksetzen"), `forbidden` (who may see it), `error` (with `onRetry`: "Erneut versuchen"). Forbidden and error are alerts. |
| An interactive list | `DataTable` | The table for every list that can exceed five rows (lists move to it with their screens). A text `filter` over the loaded rows (the term in memory only; `renderNoMatches` with its reset replaces the table), `loading` (a skeleton with the shown columns' headers). Sortable headers (`sortValue`; text in German order, empty values last), a sticky header inside its own scroll container (a named `group`, the only thing that scrolls sideways; tables and reflow, below), selection with a batch bar of its own rendered only with a selection (`batchActions`: four buttons, the rest under "Weitere Aktionen", each told its button for the focus return), a row overflow menu (`rowActions`), `onRowClick` (a click outside the row's controls; the row's link stays the keyboard's way), a column chooser (`columnChooser`, `hiddenColumns` to keep the choice in memory across a navigation), "Weitere anzeigen" over the loaded rows (`pageSize`, `limit`) or the next cursor page (`loadMore`). Controlled `sort` for a sort kept in the URL. Without rows the empty state replaces the table, under the `toolbar` (a search or filter that found nothing stays changeable). |
| A small read-only table | `SimpleTable` | Its `footer` holds "Mehr laden" of a cursor list or the list's add action. `hideTitle` when the page or card heading already names it (the table keeps the name for assistive technology). |
| A task over the page (form, filters, bulk action) | `SidePanel` | Below. |
| An action that may be blocked | `ActionButton unavailableReason` | C1. |
| A confirmation or a short choice | Carbon `Modal` | As before; a modal with input follows C4. |
| Progress of tasks (not loading) | a native `progress` in `.tp-task-progress` | With a visible label and the count ("3 von 10 Aufgaben erledigt (30 %)") as its description (the portal, below). |
| A header menu (user menu, the portal's language switch) | `HeaderPanelAction` | Its content renders only while open; `close()` returns the focus to the button, `close({ returnFocus: false })` after a link. |

### The navigation

From 66rem the side navigation is always open beside the content (16rem, no menu button); below
it is behind the header's menu button as an overlay that keeps the focus inside until Escape, the
overlay or a followed link closes it, and returns the focus to the button. The open state is
component state only.

Its entries, in the focus order after the header: "Arbeit" ("Projekte", and "Freigaben" for a
regional operations manager), "Verwaltung" ("Mitarbeitende" and "Regionen" for an admin,
"Eskalationen" for a regional admin and the global admin), then, on any page of a project
(a participant's or an appointment's page included), the project's name over its sections:
"Übersicht", "Teilnehmende", "Termine", "Agentur" (only in a `ta_tg` project), "Einrichtung",
"Team". The sections are shown to everyone who opens the project, as the tabs were; what a
section shows is decided by its capabilities. An entry is added only where its page exists for
that role; `apps/web/src/navigation.test.tsx` holds the entries per role. The current page's entry
has `aria-current="page"`; a participant's page counts as "Teilnehmende", and inside a project
"Projekte" is current only on the list itself.

A badge (`NavBadge`) shows only a count the viewer already gets from an existing endpoint, and
its phrase is part of the entry's name ("Teilnehmende 7 überfällig"). The one badge is the
overdue count of the project's dashboard (`GET /projects/{id}/dashboard`, the viewer's own
scope) on "Teilnehmende"; at zero, or for a viewer the dashboard refuses, there is none. No
access or endpoint is added for a badge.

The participant page keeps its tabs: they are parts of one object.

### The work list

The pattern for a list that is a working queue (`apps/web/src/components/participants.tsx`):
quick views above the table (each one filter, its label saying what it selects and its count,
`aria-pressed` on the active one; a view with no rows stays), the active filters as dismissible
tags, the toolbar with the count line ("142 Teilnehmende · Stand 09:41", "12 Treffer · …" while
filtered), the search and "Filter" (a side panel with the filters in groups, applied at once).
The default order is the domain's (C2); a header sort is a code in the URL. Row click opens the
object; the way back restores the view (C6).

The work list's quick views (`apps/web/src/components/worklist-views.ts`): each is exactly one
existing `WorklistFilter` with its predicate unchanged (`packages/domain/src/worklist/filter.ts`),
and its label says what that predicate selects, never more. A quick view and the dashboard tile
with the same filter share one i18n key (`tileLabelKey`; a unit test asserts equal filters).

| Quick view | Filter | Selects exactly | Shown to |
|---|---|---|---|
| Alle | `{}` | the viewer's whole list scope (an assigned consultant: "Ihre zugewiesenen Teilnehmenden") | everyone with the work list |
| Überfällig | `deadlineState: overdue` | at least one listed deadline whose date has passed | everyone |
| In den nächsten 14 Tagen | `deadlineState: upcoming` | at least one deadline from today to 14 calendar days ahead (Q78) | everyone |
| Angaben/Unterlagen fehlen | `actions: any` | a missing participant field or document, or a rejected upload | everyone |
| Hinweise | `flag: any` | at least one lifecycle flag | everyone |
| Termine zu klären | `appointment: to_resolve` | appointment items needing resolution | PL (the only resolver, data-protection.md) |
| Ohne Beratung | `consultant: none` | no assigned consultant | PL and back office |
| Mir zugewiesen | `consultant: <own id>` | assigned to the viewer | a PL who is also a consultant of the project |

The default columns are six (seven in `ta_tg`, with *Welle*); the others are in the column chooser,
whose choice stays in memory only (Q223): never browser storage or the URL, until a DPO check
allows per-user storage. A new list adds its quick view the same way (Slice 7's DSV view).

### The dashboard

The project's "Übersicht" (`apps/web/src/components/project-dashboard.tsx`) has three layers:

1. **"Heute zu tun"**: four `CountTile`s from the existing counts, labelled like their quick
   views (`tileLabelKey`): "Überfällig", "In den nächsten 14 Tagen", "Angaben/Unterlagen fehlen"
   and, for the PL, "Termine zu klären", else "Hinweise". When all four are zero the row says
   **"Keine offenen Punkte in diesen Ansichten"**, never "Alles erledigt": open work outside these
   views (a mandatory BA reporting task, also after the participation closed; Agentur items;
   flags) isn't counted there, so "Weitere offene Arbeit" lists every other open-work count as a
   link right below. A true all-clear would need every category checked and is not offered.
2. **"Verlauf"**: the main status and, in `ta_tg`, the DSV track, each as its own card of bars of
   all participations (C3: two summaries, never one sequence), with the total as a link.
3. **"Alle Kennzahlen"**: the other groups as compact cards in a three-column grid, open from
   1280px and collapsed below (a disclosure button; the viewer's choice in component state).

Every number links to the work list with exactly the counted rows.

### Setup pages

A section of settings ("Einrichtung") is cards, one per topic, each with an `id`; from 66rem an
in-page anchor list ("Auf dieser Seite") sits beside them and is hidden below, where the cards
simply follow each other. An admin control (the region's change) is in its card only for those
who may use it; everyone else reads the value where it is shown (the page header's metadata).

### The participant page

The pattern for one object with parallel tracks (`apps/web/src/routes/projects/$projectId_.participations.$participationId.tsx`,
`components/participant-overview.tsx`). The header is a `DetailHeader`. Its breadcrumb ends with
the list the object came from, with that list's codes and sort (C6): the work list hands them over
in the navigation's history state (a reload of the participant page keeps it), the work list's
memory is the fallback. Under the title one metadata line and the tags, which name their track
(C3); then up to five key facts, each from what the page already holds and only where the viewer
may read it: the TG start, the DSV's offer deadline while the work list's row carries it, the
consultants, the next appointment and the portal account's state. The actions the capabilities
allow are under "Aktionen"; the reminder and the invitation reuse the work list's dialogs with the
one row. The derived hints are one "Handlungsbedarf" notification with a list, never one banner
each.

**The one primary action is the participation's next step** (principle 3, C2;
`components/participant-next-step.ts`): `nextStep` of the work list's row, offered where the
viewer may take it, and it opens the tab or card that resolves the step ("Nächster Schritt:
Profiling"). The viewer may take a step in a tab the page shows them, or in a card of the overview
whose action their capabilities allow now (the contractual dates or the wave's choice, the privacy
notice, a BA report's outcome). Otherwise the page has no primary action: never the second item
instead of the first, and none without the work list. A blocked card action is no primary action;
its prerequisite stays beside the item (C1).

The overview is a `Split`. The main column separates concerns: *Als Nächstes* (`NextSteps`: the
open items in C2's order, `openSteps`, three shown with "n von m offenen Punkten" and the rest
behind "Alle n anzeigen"; each with what its tier means as text, its date as the line of detail,
its own link to the tab or card that resolves it, and C1's prerequisite as text where the action
there is blocked), *Stand* (each track its own `TrackBar` with its tag, its place on the fixed
lifecycle core's path and its key date; never one sequence across tracks), the timeline, then
one `SectionCard` per topic whose edit forms open in one side panel (C4). "Stammdaten" starts
open; the others are collapsed to a one-line summary (the portal account and the notice, the wave
and the TG period, the number of open BA reports) and open on their heading or when an item, the
timeline or the address points to them. A card with specially protected content never starts
open. The side column holds *Termine & Zuständigkeit* and *Fristen* (the row's deadlines,
relative and absolute). The open items, deadlines and appointments come from the work list's row
of the participation (no API of its own); a viewer without the work list sees the page without
them and is told why.

The timeline (stage 1) is inline SVG styled by CSS classes (no inline `<style>`, CSP) without
a chart library: the TG period as a bar, a "heute" line, one shape per kind (circle, diamond,
square; red for an overdue deadline) with a legend in text. Each marker is a link that the
keyboard reaches, with a tooltip on hover and focus (Escape hides it). Below the graphic the same
events as a list, which is the accessible equivalent; below 30rem only the list shows.
Stage 2 (Slice 8) adds leave, qualification measures and coaching as bars, each kind with its own
colour **and** shape or pattern and a text label. Every event kind passes the field-level access
matrix (data-protection.md) like any other field, and an absence's reason is shown only where its
data class allows it (a sensitive category needs its own decision). A project-level view of the
waves waits for the deferred items.

### The step list in use

A tab that is one long scroll becomes a `StepList` of its one track (`apps/web/src/components/profiling-tab.tsx`,
the participant's "Profiling"): the track's steps only, each with its state and one line of status
from what the tab already reads ("2 Termine erfasst", "4 Angaben fehlen", "wartet auf den
Bogen"). A step is done, open, or blocked while it waits for another; the first open one is the
current step and the tab opens on it, with its action. That step stays open while the viewer
works in it, also once it is done, until they choose another. A step the viewer's capabilities
give nothing for is not in the list. What concerns the track whichever step is open (a closed
participation, a completion no paper supports) is above the list; what is no step of the track
(the exception from profiling) is a `SectionCard` below it, collapsed to its state.

**A fact is shown once.** The missing fields are listed in one step, the self-service data, each
once whatever steps wait for it. A step that waits for them (the TL 407) says how many are
missing and names that step with a link to it ("4 Pflichtangaben fehlen noch. Sie stehen unter
…"); it lists only what is listed nowhere else. The steps stay mounted (`keepMounted`), so a
draft in one survives a look at another, and a sensitive block stays behind its "Anzeigen".

### Side panel

A Carbon `ComposedModal` placed at the inline end, full height, 30rem wide and full width below
42rem (decided in 6b-2 over a focus-trapped `aside`: the modal brings the focus trap, `aria-modal`,
the inert page, Escape and the focus return to the launcher, and passes axe). Its `dirty` prop is
the consumer's comparison of the input with what was saved; with it, C4's question replaces the
footer inside the panel (an `alertdialog` named "Änderungen verwerfen?"), the body is inert until
answered, and the browser's own dialog guards a reload. The app passes a navigation the router
holds back (`usePanelNavigationGuard` in `apps/web`, TanStack Router's `useBlocker`) as
`pendingNavigation`, which asks the same question. Carbon's Escape listener keeps the first
render's `onClose`, so the panel reads its state from a ref updated in a layout effect, and a form
reports its `dirty` state in a layout effect too, so an Escape right after typing already asks.
The focus starts in the first field (not on ×, whose tooltip would swallow the first Escape) and
returns on close to `returnFocusTo` or else to what had it at opening; a row action gets its
menu's trigger for that (`RowAction.onClick(trigger)`), since the menu item is gone by then.

### Tables and reflow (Q225)

1280px is the preferred layout, not a cutoff: at 400% zoom of a 1280px window (320 CSS px) forms,
filters, side panels and dialogs are one column and fully usable without two-dimensional
scrolling. Only a data table may scroll horizontally, inside its own focusable container; the
page never does. Each UI PR records a manual zoom check (200% and 400%) with its axe results.

### The portal

The participant portal (`apps/portal`) is mobile-first at 320px and uses the same kit. Its shell
(`PortalShell`) is the staff shell's dark header without a side navigation; its `actions` are the
language switch (a `HeaderPanelAction` named "Sprache: Deutsch", each language named in itself
with `lang` and `aria-pressed`; choosing one closes the panel and returns the focus) and, while
logged in, the account menu ("Mein Konto", "Abmelden"). No page body has a language select. A
panel link that leaves the page closes it with `close({ returnFocus: false })`, so the focus
doesn't jump back into the header.

The start page answers "What do I still have to do?" (C5). Logged out it offers one choice in two
cards: "Anmelden" and "Mit Aktivierungscode starten", each with a sentence on who it is for.
Logged in: the one `h1` (the greeting), the card "Das fehlt noch" (the progress, the open tasks
each as a link to where it is done, the done ones behind a `details` summary, then "Freiwillig"
outside the count), the card "Ihr nächster Termin", then the participant's areas as cards with
one link each (the title; the text is its description, the whole card clickable). Task progress is
a native `progress` (`.tp-task-progress`), never Carbon's `ProgressBar`, which marks itself busy and
announces "Loading". Each task's state is an icon and visually hidden text ("Offen:",
"Erledigt:"), never colour alone. The channels and "Abmelden" are on "Mein Konto" (`/account`).

## i18n

UI text goes through i18n only. The kit's own strings ("Aktionen", "Filter zurücksetzen",
"Weiter bearbeiten", the relative dates, the table's labels) are its namespace `ui`
(`packages/ui/src/locales/{de,en}.json`, identical keys); each SPA adds `uiResources` to its
instance, like the wizard's `selfService`. Status labels come from the app's catalog under the
keys the status map names.

## Testing

Each component has component tests in `packages/ui` (jsdom: keyboard paths, roles, C1, C4, no
browser storage). The kit page (`/ui-kit`, reached by its address only) shows every component of the second layer
in its states on fixed synthetic fixtures (`apps/web/src/components/ui-kit-fixtures.ts`);
`ui-kit.spec.ts` drives it at 1440, 768, 375 and 320px with axe. `ui-kit-visual.spec.ts` compares
its pixels with a committed baseline (`apps/web/e2e/__screenshots__/`) on a fixed clock, in CI's
environment only and with a small tolerance (Q255). `ui-participant-visual.spec.ts` does the same
for the participant page (the overview and "Profiling"): the API's answers come from a frozen
synthetic fixture (`e2e/fixtures/participant-page.json`), since its relative dates follow the
server's clock. A baseline changes only in the PR that
changes the design, is named in that PR's description for a human to review, and is never
regenerated to get CI green. The comparison adds to the behaviour tests, axe and the zoom checks.
The pages that use the components run axe in the e2e suite (`expectAccessible`) at the
desktop size and, through the `shell` project, at 768 and 375px. Carbon panels, menus and the
navigation animate (~110–240 ms): a screenshot or an assertion right after a click waits for the
end state. jsdom never places Carbon's floating menus, so component tests reach a menu through the
button's `aria-controls` (`chooseRowAction` in `apps/web/src/test-utils.tsx`); the e2e opens it
for real.
