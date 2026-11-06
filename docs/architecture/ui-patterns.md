# UI patterns (staff app and portal)

The product-design layer over Carbon. Every UI change follows this page; a pattern that is
missing here is added here in the PR that needs it. The components live in `packages/ui`
(ADR-0003: the apps use Carbon only through it) and are thin wrappers built from `@carbon/react`
primitives, following the Carbon for IBM Products patterns without depending on
`@carbon/ibm-products` (Q222). A wrapper is built only when a screen needs it.

## Principles

1. **One job per screen, three things that matter.** Every screen states its job in the plan of
   the PR that builds it; the top of the screen answers "what needs me now?".
2. **Four layers of disclosure.** Glance (page header, today's tiles) → list or overview → detail
   (tabs) → action (side panel or modal). A control appears in the layer where its object is, and
   only when it can apply: bulk actions only with a selection, admin settings only in
   "Einrichtung".
3. **One primary action per page,** top right in the page header; secondary actions in its
   "Aktionen" menu; row actions in the row's overflow menu.
4. **Status has one visual language** (`StatusTag`, below): red = overdue/blocked, yellow = due
   soon/needs confirmation, green = done, blue = in progress/info, gray = inactive/terminal. Never
   colour alone: the tag's text and icon carry the meaning (WCAG 1.4.1).
5. **Dates are relative and absolute:** "seit 3 Tagen überfällig · 03.11.2026" in lists; the
   absolute `TT.MM.JJJJ` date is always present (`RelativeDate`).
6. **Name a heading once.** A tab label is the panel's name; a panel doesn't repeat it as an `h2`.
   One `h1` per page (the page header's). Headings get their size from one rule, never from the
   component they sit in: `packages/ui/src/styles.scss` sets `h1` = `heading-04`, `h2` =
   `heading-03`, `h3` = `heading-02` under `:where(.tp-content, .tp-portal-content)`, as weak as an
   element selector so a Carbon component's own heading class (a modal title) still wins. A card's
   heading is `heading-compact-02` whatever its level.
7. **Every state is designed:** loading = a skeleton of the final layout; empty = what this is,
   why it is empty and the next step ("Filter zurücksetzen" when filters cause it); error = what
   failed and how to retry; forbidden = who may see it.
8. **Spacing and layout come from the primitives** (`Stack`, `Grid`, `Section`, `Card`, a table's
   `footer`), never from a class named for something else.
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
| Top of a page | `PageHeader` | `breadcrumbs` (ancestor links; the page is the title), `title` (the one `h1`), `tags`, `metadata` (one plain line), `primaryAction` (one), `menuActions` ("Aktionen"; destructive ones last, in red). |
| A titled part of a page | `Section` | `h2` by default, `level={3}` inside a section, panel or tab. In a tab panel that is named by its tab, no section heading repeats the tab. |
| One topic as a block | `Card` | Details, a small form, a summary; a card's actions are its own. |
| Side by side | `Grid columns={2 or 3}` | One column below 42rem, two from 42rem, three from 66rem; logical properties only. |
| Vertical rhythm | `Stack gap={…}` | A button in a stack is wrapped in a `div` so it keeps its width. |
| A status, track, deadline state, flag or appointment status | `StatusTag family code` | One map (`statusTag`) from the domain's codes to tone, Carbon tag type, icon and label key (the app catalog's existing keys, e.g. `participants.statuses.*`). A new domain code fails the typecheck until it is mapped. Yellow is `yellow-10` with the warning colour as border, since Carbon has no yellow tag. |
| A date in a list | `RelativeDate date today kind` | `kind="deadline"`: "in 3 Tagen", "heute fällig", "seit 2 Tagen überfällig" (overdue from the day after); `kind="event"`: "heute", "vor 2 Tagen". `today` is the caller's Berlin date (e.g. the snapshot's), never read by the component. |
| A route loading | `PageSkeleton` | The router's pending component. |
| A list loading | `TableSkeleton headers` | With the real column headers; announced through a hidden status. |
| A small part loading | `Loading label` | Replaces the loose "Wird geladen…" paragraphs. |
| Nothing to show | `EmptyState variant` | `noData` (what this is, why it is empty, the next step as `action`), `noMatches` (with `onResetFilters`: "Filter zurücksetzen"), `forbidden` (who may see it), `error` (with `onRetry`: "Erneut versuchen"). Forbidden and error are alerts. |
| An interactive list | `DataTable` | Sortable headers (`sortValue`; text in German order, empty values last), a sticky header inside its own scroll container (a named `group`, the only thing that scrolls sideways, D10), selection with a batch bar of its own rendered only with a selection (`batchActions`: four buttons, the rest under "Weitere Aktionen", each told its button for the focus return), a row overflow menu (`rowActions`), `onRowClick` (a click outside the row's controls; the row's link stays the keyboard's way), a column chooser (`columnChooser`, `hiddenColumns` to keep the choice in memory across a navigation), "Weitere anzeigen" over the loaded rows (`pageSize`, `limit`) or the next cursor page (`loadMore`). Controlled `sort` for a sort kept in the URL. Without rows the empty state replaces the table, under the `toolbar` (a search or filter that found nothing stays changeable). |
| A small read-only table | `SimpleTable` | Its `footer` holds "Mehr laden" of a cursor list or the list's add action. |
| A task over the page (form, filters, bulk action) | `SidePanel` | Below. |
| An action that may be blocked | `ActionButton unavailableReason` | C1. |
| A confirmation or a short choice | Carbon `Modal` | As before; a modal with input follows C4. |

### The work list

The pattern for a list that is a working queue (`apps/web/src/components/participants.tsx`):
quick views above the table (each one filter, its label saying what it selects and its count,
`aria-pressed` on the active one; a view with no rows stays), the active filters as dismissible
tags, the toolbar with the count line ("142 Teilnehmende · Stand 09:41", "12 Treffer · …" while
filtered), the search and "Filter" (a side panel with the filters in groups, applied at once).
The default order is the domain's (C2); a header sort is a code in the URL. Row click opens the
object; the way back restores the view (C6).

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

### Tables and reflow (D10)

1280px is the preferred layout, not a cutoff: at 400% zoom of a 1280px window (320 CSS px) forms,
filters, side panels and dialogs are one column and fully usable without two-dimensional
scrolling. Only a data table may scroll horizontally, inside its own focusable container; the
page never does. Each UI PR records a manual zoom check (200% and 400%) with its axe results.

## i18n

UI text goes through i18n only. The kit's own strings ("Aktionen", "Filter zurücksetzen",
"Weiter bearbeiten", the relative dates, the table's labels) are its namespace `ui`
(`packages/ui/src/locales/{de,en}.json`, identical keys); each SPA adds `uiResources` to its
instance, like the wizard's `selfService`. Status labels come from the app's catalog under the
keys the status map names.

## Testing

Each component has component tests in `packages/ui` (jsdom: keyboard paths, roles, C1, C4, no
browser storage). The pages that use them run axe in the e2e suite (`expectAccessible`) at the
desktop size and, through the `shell` project, at 768 and 375px. Carbon panels, menus and the
navigation animate (~110–240 ms): a screenshot or an assertion right after a click waits for the
end state. jsdom never places Carbon's floating menus, so component tests reach a menu through the
button's `aria-controls` (`chooseRowAction` in `apps/web/src/test-utils.tsx`); the e2e opens it
for real.
