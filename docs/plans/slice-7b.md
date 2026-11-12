# Slice 7b — Foundations before the TG module: agent groundwork and the UI's second layer

Status: **approved by the product owner for implementation on synthetic data** (2026-11-12), with
the answers to Q254–Q258 recorded in
[the decisions](../decisions/2026-11-12-answers-slice-7b.md) and the project section "Agentur"
restored in the navigation (D7). Q241–Q253 are taken by the Slice 8 plan (PR #126).

Why now: the owner's review of the application (2026-11-12) found the UI dated and unorganised,
and the review of the repository found two things that slow every agent session: no single place
shows what a database function currently does, and the domain docs have grown into build logs.
Slice 8 adds three staff tabs, three portal pages and changes the largest database functions
again, so it should be built on the new ground, not migrated to it afterwards.

No lifecycle rule, access rule, API contract or stored data changes in this slice. Synthetic data
only.

## Findings the slice answers

| Finding (measured on `main` at `453016e`) | Answer |
|---|---|
| 116 migrations, about 27,000 lines of hand-written SQL, 325 functions; `record_audit_event` recreated in 42 migrations, `apply_status_change` in 7. The current body of a function is only in the last migration that recreated it, and a one-line change re-pastes hundreds of lines | D1, D2 |
| `data-protection.md` 159 KB, `process-and-lifecycle.md` 119 KB, ADR-0002 128 KB, `open-questions.md` 154 KB; each PR appended an "as built" section, so one topic's rules sit in several places; about 30 question rows are build notes | D3, D4 |
| `packages/ui` has about 1,900 lines, `apps/web` about 25,000 in 66 components that each lay themselves out (`tp-list`, `tp-form`, `tp-facts`, … used 3 to 41 times each) | D5–D9 |
| The participant's "Profiling" tab is one undivided scroll of about five screens and lists the missing fields twice; "Einrichtung" is one long form; the dashboard's "Alle Kennzahlen" is eight tables of zeros | D10–D12 |
| Carbon's `secondary` button renders as a dark block that reads as disabled; actions sit in the page header far from their object; labels and values of "Stammdaten" are far apart; only the work list sorts and filters | D6, D8, D9 |
| The side navigation holds one entry; a project's sections are tabs under a header that repeats on each | D7 |

## Decisions

### Agent groundwork

- **D1. Every database function has one source file** (ADR-0002 gains the rule).
  `packages/db/sql/functions/<area>/<name>.sql` holds the function (`CREATE OR REPLACE`, every
  overload), its owner and its grants; `packages/db/sql/triggers/<table>.sql` the triggers
  (`CREATE OR REPLACE TRIGGER`). `pnpm db:migrate` runs the migrations as today, then applies in
  one transaction every source whose SHA-256 differs from the one recorded in `function_source`,
  in the order of a checked-in manifest. Changing a function is editing its file: the diff shows
  the change. A migration is still needed, and only, for tables, types, data and for dropping an
  old signature or return type. Merged migrations are never edited and stay the history.
  - **Extraction is mechanical**: the first sources are `pg_get_functiondef` of a database migrated
    to the last migration, bodies verbatim.
  - **Equivalence is proved, not assumed**: a test migrates one database from the migrations alone
    and one with the sources applied, and compares definition, owner, privileges, `SECURITY
    DEFINER` and configuration of every function and trigger; they must be identical. Afterwards
    the same test proves a second apply changes nothing.
  - **No orphan**: after a migrate, a function without a source fails the test, except a short
    allowlist of functions a table's constraint, default or index expression depends on (they
    stay in migrations).
  - **Upgrade safeguards** (Q256): beside the fresh build, a test upgrades a database that stands
    at the last migration before 7b-1 with representative synthetic rows, and ends with the same
    functions, triggers, privileges and data; the first apply on such a database changes no
    definition (the hashes are recorded, nothing is recreated differently); the runner applies all
    changed sources in one transaction or none, refuses to run when a migration failed, and
    `db:reset`, the e2e setup and the image smoke test use the same path as `db:migrate`.
  - Sources run after the migrations commit, so a new enum value is usable in a function of the
    same PR without the text comparison, and a migration never calls a function its own PR
    changes.
- **D2. Lists that force a recreate become generated** (`pnpm generate`, drift-checked like the API
  client): the event types `record_audit_event` refuses come from the domain's audit model; the
  table lists of the retention functions and of the evidence-only trigger come from the data
  catalog. A new event type or table then changes the model, not the SQL. **Only inventories are
  generated** (Q256): which types are refused, which tables name a participation. The retention
  rules themselves stay explicit, hand-written and tested as today: each class's triggers and
  deletion, the erasure order, the retained dependencies with their release conditions, and what a
  legal hold keeps. A new table therefore still fails the existing schema tests until its class,
  its place in the erasure order and its dependencies are stated by hand.
- **D3. The domain docs are split by topic, verbatim first.** `process-and-lifecycle.md`,
  `data-protection.md` and ADR-0002 become directories with one file per topic (lifecycle: dates,
  main status and rules, profiling, DSV, ASU and Kug 200b, TG entry, cutoff, appointments, import,
  work list; data protection: classification, access matrix, documents, self-service, forms and
  scans, exports, messages, consent, retention, authentication, corrections; the database
  reference per area under `docs/architecture/database/`, ADR-0002 keeping the decision). The move
  changes no sentence. The three old files stay as indexes that keep every old heading as a link,
  so a citation such as "process-and-lifecycle.md, BA reporting" in code still leads there.
  A check in `pnpm lint` (`scripts/check-docs.mjs`) fails on a broken relative link and on a doc
  over 40 KB (generated files and `open-questions.md` excepted).
- **D4. One current statement per rule, from now on.** agent-workflow.md gains: a PR that changes
  behaviour edits the topic's rule text in place; "as built" history belongs in the PR
  description. Merging the existing "as built" sections into their rules is done per topic by the
  PR that next touches it, as a diff the owner can read, never in a bulk rewrite. **History is
  separated from unresolved decisions by status and substance, never by a row's title** (Q257, as
  amended): each row is read; what records how something was built and asks nothing more moves
  with its number to `docs/decisions/readings.md`; a row that still holds an undecided point, a
  `verify` fact, a pilot gate (🔒) or an `open` or `assumed` status stays in `open-questions.md`,
  whatever it is called, and a row holding both is split with the open part kept under its number.
  The PR lists every row with where it went and why, for the owner's review.

### The UI's second layer

- **D5. Carbon stays; a product theme goes on top** (ADR-0003; Q254, accepted: white cards,
  restrained rounding and shadow, central overrides). A change of library would
  rewrite the staff app and redo its accessibility work. `packages/ui` gains theme tokens: white
  cards on the `g10` background with an 8px radius and one soft elevation, 6px on controls, a
  spacing scale; Carbon's components keep their behaviour and focus handling. One stylesheet holds
  every override of a Carbon class, each with the Carbon version it was checked against.
- **D6. Buttons have one hierarchy.** One primary button per page, in the header: **the next step**
  of the object where the viewer may take it (`nextStep`, ui-patterns.md C2), else the page's
  creating action. Every other action sits beside the thing it acts on as an outlined button
  (Carbon `tertiary`) or a text button; Carbon's dark `secondary` kind is not used. Destructive
  actions stay last in "Aktionen". A blocked action keeps its prerequisite beside it (C1).
  ui-patterns.md's principle 3 is amended accordingly.
- **D7. A real navigation** (Q258). From 66rem the side navigation is always open: "Projekte",
  then "Freigaben", "Eskalationen" and the admin entries exactly for the roles that have them
  today, then the current project's sections, which become routes of their own instead of tabs:
  "Übersicht", "Teilnehmende", "Termine", **"Agentur"** (the Kug 200b batches; only in a `ta_tg`
  project and only for whoever sees the tab today), "Einrichtung", "Team". Every old `?tab=`
  address redirects to its route, `?tab=agentur` included, and in a `ta_only` project the
  "Agentur" route shows the overview as the tab does now. "Agentur" keeps its layout (D13). **Role
  visibility is preserved**: an entry appears exactly where its tab or link appears today. **A
  badge shows only a count the viewer is already authorised to get from an existing endpoint**; an
  entry without such a count has no badge, and no access or endpoint is added for one. The work list's return
  path (C6) keeps working from the new route. The participant page keeps its tabs: they are parts
  of one object.
- **D8. New kit components**, the only places a layout is defined: `DetailHeader` (title, one
  metadata line, the track tags, up to five key facts, the primary action, "Aktionen");
  `SectionCard` (a titled card that collapses to its title and a one-line summary; open state in
  memory only; a card with specially protected content is never open by default); `Facts` (label
  above or beside its value in a two- or four-column grid); `NextSteps` (open items, each with its
  own action); `StepList` (D10); `Funnel`; the existing tiles restyled. A lint rule refuses a
  `className` starting with `tp-` and a style import in `apps/web` and `apps/portal` outside an
  allowlist that shrinks as screens migrate.
- **D9. One table.** `DataTable` (sort, filter, column chooser, empty and loading states) is the
  table for every list that can exceed five rows; `SimpleTable` stays for short read-only tables.
  The reference pages use it; the remaining lists follow with their screens (D13).
- **D10. A long tab becomes a step list** ([mock-up 2](mockups/slice-7b/participant-profiling.png)):
  the steps of the tab's one track at the left, each with its state and one line of status; the
  current step open at the right with its action; the others collapsed to their summary. A fact
  is shown once: the missing fields appear in "Angaben prüfen" and are named by the step that
  waits for them. The step list is within one track, so C3 (parallel tracks are never one
  sequence) holds.
- **D11. The participant page** ([mock-up 1](mockups/slice-7b/participant-overview.png)): the
  header answers who, where in each track, and the next step; "Als Nächstes" lists three open
  items with their actions; "Stand" shows the three tracks as three bars; "Stammdaten" and the
  other cards collapse to a summary; appointments, responsibility and deadlines sit in a side
  column. Everything shown is data the page already loads.
- **D12. The project overview and the setup** ([mock-up 3](mockups/slice-7b/project-dashboard.png),
  [mock-up 4](mockups/slice-7b/project-setup.png)): tiles for what needs work today, the funnel as
  one row whose numbers open the list, the oldest overdue items as a table, the week's dates and
  the waves at the side; "Kennzahlen" shows only values above zero with "Alle anzeigen".
  "Einrichtung" is a step list of the setup with what blocks activation named in the header; each
  section collapses to a summary and is edited in the side panel; rarely used settings sit under
  "Erweitert".
- **D13. Three reference pages now, the rest later.** 7b builds the kit and these pages. Slice 8
  builds its screens on them from the start. The remaining screens ("Selbstauskunft",
  "Unterlagen", "Termine", "Nachrichten", "DSV", "Aufbewahrung", "Verlauf", "Freigaben", the
  appointment page, "Team", the admin pages, the portal's layouts) migrate with Slice 9's
  hardening; until then they get the theme and the navigation and keep their layout.
- **D14. The open usability walkthrough runs on the reference pages** (roadmap.md, still open from
  Slice 6b): 30 minutes with one PL and one consultant on synthetic data, four tasks; its findings
  are a table in the PR that follows it (7b-8), and anything larger becomes a question.
- **D14a. Visual regression** (Q255, accepted): a pixel comparison of the kit page and the three
  reference pages, on stable synthetic fixtures (fixed data and a fixed clock) in CI's environment
  only, with a small tolerance. A changed baseline is committed in the PR that changes the design
  and named in its description for a human to review; it is never regenerated to get CI green.
  It adds to the behaviour tests, axe and the zoom checks and replaces none of them.
- **D15. Unchanged rules:** nothing in browser storage; no participant name in a page title;
  sensitive blocks behind "Anzeigen"; German staff UI through i18n; axe without serious or
  critical findings and the 200 % and 400 % zoom check on every changed page; logical CSS
  properties (ui-patterns.md, data-protection.md).
- **D16. Not in this slice:** squashing or editing merged migrations; splitting the large API
  route files (Slice 9); the remaining screens (D13); dark mode, saved views, the cross-project
  start page (Q224); new endpoints (a reference page that turns out to need one says so and the
  owner decides); any Slice 8 function.

## PRs

One planned PR = one branch = one PR, each based on `main`. Estimates count changed lines without
tests, generated code, docs and moved SQL or prose.

| PR | Scope | Needs | Est. lines |
|---|---|---|---|
| 7b-1 | Function sources (D1): the runner in `db:migrate`, `function_source`, the extraction, the equivalence and orphan tests, ADR-0002, CLAUDE.md | — | ~500 (plus the functions' SQL, extracted verbatim) |
| 7b-2 | Generated lists (D2): the refused audit types, the retention and evidence-only table lists | 7b-1 | ~500 |
| 7b-3 | Docs (D3, D4): the split with the three indexes, `scripts/check-docs.mjs`, `readings.md`, CLAUDE.md and agent-workflow.md | — | ~200 (plus the moved prose) |
| 7b-4 | Kit (D5–D9): theme tokens, the navigation and the project routes, `DetailHeader`, `SectionCard`, `Facts`, `NextSteps`, `StepList`, `Funnel`, the button rule, the lint rule, ui-patterns.md, the kit page | — | ~1,500 |
| 7b-5 | Participant page (D10, D11): header, overview, "Profiling" as a step list | 7b-4 | ~1,400 |
| 7b-6 | Project overview (D12) | 7b-4 | ~900 |
| 7b-7 | Project setup (D12) | 7b-4 | ~1,200 |
| 7b-8 | The walkthrough's findings (D14); roadmap.md; this plan archived | 7b-5 to 7b-7 | ≤ 800 |

7b-1 and 7b-3 can start at once and beside 7b-4. Slice 8 starts when 7b-1, 7b-2, 7b-4 and 7b-5
have merged; 7b-6 to 7b-8 can run beside its first PRs.

**What changes in the Slice 8 plan** (PR #126, updated after this plan is approved): its tabs use
`SectionCard`, `Facts` and `StepList`, its quick views and tiles the new overview, its exit action
the header's next step; its "SQL functions redefined" column becomes "functions changed" and the
retention table lists drop out of every PR, which lowers its estimates.

## Design

### Database (`packages/db`)

- `sql/functions/<area>/<name>.sql`, `sql/triggers/<table>.sql`, `sql/manifest.json` (the order);
  `src/scripts/migrate.ts` applies changed sources after the migrations in one transaction and
  records name, hash and time in `function_source` (no personal data, `reference_data`).
- `src/function-sources.int.test.ts`: equivalence at the baseline, idempotence, no orphan, and the
  existing `grants.int.test.ts` unchanged and green.
- Generated sources (D2) carry a header naming their generator; `pnpm verify` checks their drift.

### UI (`packages/ui`, then `apps/web`)

- `theme.scss` (tokens and the Carbon overrides), `detail-header.tsx`, `section-card.tsx`,
  `facts.tsx`, `next-steps.tsx`, `step-list.tsx`, `funnel.tsx`; each with a component test and an
  entry on the kit page (`ui-kit.spec.ts`).
- `apps/web`: routes `/projects/$projectId/{overview,participants,appointments,agentur,setup,team}`; the
  shell's navigation from the viewer's capabilities; the three reference pages. The data comes
  from the endpoints the pages use today (the participation detail, the work list's snapshot, the
  dashboard, the appointments).
- The mock-ups are static pages in `docs/plans/mockups/slice-7b/` (HTML, one stylesheet, a PNG
  each). They show layout and hierarchy; the kit is the implementation, and wording follows the
  i18n catalog.

## Acceptance criteria

**7b-1** A database built from the migrations alone and one with the sources are identical in
every function and trigger (definition, owner, privileges, security, configuration); a second
apply is a no-op; an unlisted function without a source fails; changing one function is a diff of
that file only (shown in the PR with one real example); `pnpm db:migrate`, `db:reset`, the e2e
setup and the image smoke test work unchanged; the upgrade test from the last migration before
7b-1 with existing rows ends identical, and a failed source leaves nothing applied.

**7b-2** Adding an audit event type or a participant table in a test fixture changes the generated
SQL and nothing hand-written; the drift check fails when the generated file is stale; the refused
list and the table lists equal the previous hand-written ones at the switch; the retention rules,
the erasure order, the retained dependencies and the hold rules are unchanged files, and a new
table still fails the schema tests until they are stated.

**7b-3** Every sentence of the three documents exists once in the new files (a script compares
the text before and after, ignoring headings and links); every old heading resolves from its
index; `pnpm lint` fails on a broken link and on a doc over 40 KB; every `Qnn` is found in exactly one of the three files; no row that is `open`, `assumed`,
`verify` or a pilot gate left `open-questions.md`; the PR's table names each row's destination and
reason.

**7b-4** The kit page shows every new component in its states; no `secondary` button remains in
`packages/ui`; the lint rule fails on a new layout class outside the kit; the navigation shows
exactly the entries each role has today (a test per role, "Agentur" in a `ta_tg` project and absent
in a `ta_only` one), keeps the focus order and reflows to the menu below 66rem; every old `?tab=`
address redirects, `agentur` included; a badge appears only with an authorised count; the pixel
comparison runs in CI on fixed fixtures; axe and both zoom checks pass; screenshots `docs/screenshots/7b-4/`.

**7b-5 to 7b-7** Each page matches its mock-up's structure (regions, order, what is collapsed, the
one primary action); nothing shown that the page didn't already load, and no field a role
couldn't see before (the existing access tests unchanged and green); "Profiling" lists each
missing field once; the existing e2e flows of the page pass with updated selectors only, none
removed; axe, zoom checks, screenshots `docs/screenshots/<pr>/`.

**7b-8** The walkthrough's four tasks, who took part by role, and a findings table with each
finding fixed, deferred with its slice, or recorded as a question.

## Docs updated by the PRs

- 7b-1, 7b-2: ADR-0002 (function sources, generated lists), CLAUDE.md (commands, where functions
  live), agent-workflow.md (a function change is a source edit).
- 7b-3: the split itself, CLAUDE.md ("Start here"), agent-workflow.md (D4), open-questions.md.
- 7b-4 to 7b-7: ui-patterns.md (theme, principle 3, the new components, the step list, the
  navigation), architecture/overview.md (the project routes, the participant page).
- 7b-8: roadmap.md (Slice 7b done; the screens left for Slice 9), this plan archived.

## Questions

Q254–Q258, answered by the product owner on 2026-11-12
([the decisions](../decisions/2026-11-12-answers-slice-7b.md)): Q254 accepted, Q255 accepted, Q256
accepted with the upgrade safeguards and explicit retention rules, Q257 amended, Q258 accepted
with "Agentur" restored. None blocks a PR or the pilot.
