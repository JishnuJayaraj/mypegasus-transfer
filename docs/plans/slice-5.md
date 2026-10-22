# Slice 5 — PL dashboard (F7) and reminders (F4 basics)

Status: **revised** 2026-10-22 after the product owner's review of PR #78 (not yet approved):
the accepted decisions are recorded in [round 39](../decisions/2026-10-22-answers-round-39.md);
this revision adds the required amendments (deadlines, the search snapshot, the dispatch check,
audit redaction in the database, appointments as Slice 5b, two UX details). Nothing is
implemented before approval.
Roadmap: funnel, "what's missing", filters, bulk reminder (mail/SMS adapters, mock), deadlines;
deferred here from Slice 2: bulk entry-wave assignment and the audit history UI (the runtime role
can't read `audit_event` yet). Builds on the participant list
(`apps/web/src/components/participants.tsx`), the completeness engine
(`packages/domain/src/completeness/engine.ts`) and `selfServiceMissing` with live document states
(Slice 4b), the planner's derived flags (`lifecycleFlags`,
`packages/domain/src/lifecycle/planner.ts`), the mail/SMS adapters with their mocks and the
development outbox (ADR-0006), the portal channels and the `portal_contact` consent
(data-protection.md, authentication), single wave assignment (`assign_entry_wave`) and the audit
streams of `decideAccess` (Q87 A).
Questions: Q150–Q159 in `docs/open-questions.md`. Q150–Q157 and Q159 are `accepted` for
implementation (round 39; the 🔒 rows keep the pre-pilot gate); Q158 is answered by the roadmap
entry Slice 5b.

## Decisions

- **D1. One work list.** "What's missing" is the participant list with derived columns and
  filters: it keeps its selection and bulk actions (consultants, activation codes) and gains wave
  assignment (D8) and reminders (D9–D15). The project page gets the tabs "Übersicht" (the
  dashboard, D4), "Teilnehmende" (the work list), "Einrichtung" (setup, Agentur settings, waves,
  import) and "Team".
- **D2. One projection for the list and the dashboard.** The domain's `worklistProjection` turns
  one participation's facts into a `WorklistItem`: statuses, wave, consultants, activation and
  notice state, `actions` (D3), `deadlines` (D5), the remaining `flags`, `reachable` (D11) and
  capabilities. The dashboard's counts are `projectFunnel(items)` over the same items, and each
  count is defined as a `WorklistFilter`, so a count and its drill-down are the same predicate
  (`matchesWorklistFilter`); a domain test asserts `count = items.filter(filterOf(count)).length`
  for every count. Counts are **distinct participations**, never sums of items.
- **D3. Participant actions, one per field or document type** (PRD F7; Q151). From the steps
  whose facts exist today, `data_collection` and `profiling` (`selfServiceMissing`, from the
  participation's own resolved chain): one action per missing field, and one per document type of
  the participant's own types, `missing` or `rejected`. A required type whose live documents are
  all rejected (the engine's `not_accepted`) is one `rejected` action, never also a `missing` one;
  a type without a rule gives a `rejected` action when it has a rejected live document and no live
  document that isn't rejected. Codes only, and only for fields the viewer may know about
  (`staffSelfServiceAccess` `knows`, the "Selbstauskunft" tab's rule); presence, never a value.
  `asu_registration` and `dsv` items, TL 407 / Kug 200b lists, "DSV signed, not fully executed"
  and the regional admin's escalation view (Q57) come with Slices 6 and 7, overdue appointments
  with Slice 5b (Q158); each joins as one more item kind in the same projection.
- **D4. The dashboard** (Q150): tiles of distinct participations ("Teilnehmende", "mit offenen
  Angaben oder Unterlagen", "Frist in 14 Tagen", "Frist überschritten", "Hinweise", "nicht
  erreichbar"), counts per main status, profiling and DSV status (`ta_tg`), per wave and "ohne
  Welle", per activation and notice state, per deadline kind and state, per flag; each count links
  to the work list filtered by the same `WorklistFilter`. Exact counts, values below five
  included, for a viewer who may list every counted participation: the PL and back office for the
  project, an assigned consultant for their currently assigned participations; the scope is
  recalculated on every request; an unassigned consultant and the org roles get `403`. Responses
  are `Cache-Control: private, no-store` and never enter analytics or telemetry. No Slice 5
  aggregate leaves the application; the n < 5 rule (primary and deterministic secondary
  suppression, no drill-down) applies wherever an aggregate is disclosed outside that scope (the
  customer report, Slice 9). Aggregates of health, disability or other sensitive categories need a
  decision of their own. Tables and tiles, no chart library (the CSP forbids inline styles).
- **D5. Deadlines: every applicable one, informational, never a guard** (Q151). Each item carries
  `deadlines[]` of `{ kind, date, state }`:

  | Kind | Applies while | Date | Planner flags it replaces |
  |---|---|---|---|
  | `offer_deadline` | `dsv_offered` | the effective offer deadline (Q69) | — |
  | `tg_start` | `informed`, not entered | the effective TG start | `tg_start_missed` |
  | `latest_entry_cutoff` | the cutoff would withdraw or flag it (the planner's cutoff outcome) | the applicable latest entry date (the wave's, else the project's final one, Q84) | `cutoff_warning`, `cutoff_final_reminder` |
  | `privacy_notice` | the Art. 14 notice not provided (Q124) | its due date | — |
  | `profiling_exception` | `active_in_tg`, an approved exception, profiling not done | entry + `profilingExceptionDeadlineMonths` (1 month) | `profiling_exception_deadline_missed` |

  `state` is `upcoming` from 14 calendar days before the date up to the date itself (deadlines are
  inclusive, Q69; `deadlineWarningDays = 14`, Q78's horizon) and `overdue` from the day after;
  `latest_entry_cutoff` adds `final: true` within 3 days (Q78). A deadline further away isn't
  listed. A planner flag in the last column is represented by its deadline and never listed as a
  flag too, so a cutoff is counted once; the flags that stay flags are
  `conflict_dsv_signed_profiling_declined`, `dsv_never_offered`, `informed_without_wave_at_cutoff`
  and `profiling_declined_after_entry`. The row shows the most urgent deadline: the oldest overdue
  date first, otherwise the earliest upcoming; ties by kind in the table's order. The filters
  `deadlineKind` and `deadlineState` match a participation with at least one deadline of that kind
  and state (both together when both are set). The ASU due date waits for Slice 6 and Q1.
- **D6. The work list is one bounded snapshot; filtering and the name search run in the
  browser** (PRD: 2,000 participations filter client-side). `GET /projects/{id}/worklist` answers
  the viewer's whole authorized scope in one response, evaluated once (two queries, facts and live
  documents; the configuration resolved once per placement Agentur; the guard facts of the nightly
  sweep's `GuardFactsProvider`), at most `worklistMaxRows = 5,000` (PRD 2,000 with headroom; a
  larger project is `422 worklist_too_large` until the Slice 9 performance pass), `private,
  no-store`. No cursor, so no page recomputes the project and nothing is ever partial (an exception
  to ADR-0010's cursor pagination, recorded there). The browser keeps the snapshot in memory only
  (the query cache, never persisted) and builds a search index of the listable person fields
  (Personalnummer, names; case and diacritics folded, `ß` → `ss`). The search term lives only in
  component state: never sent, never in a URL, a query key, a log or browser storage; the field
  has `autocomplete="off"`. Until the snapshot has arrived the list shows "Wird geladen…", the
  search field and "Alle Treffer auswählen" are disabled and no empty state is shown; a refetch
  after a bulk action keeps the previous snapshot visible with its time ("Stand 10:42") and
  disables "Alle Treffer auswählen" until it is complete. The code filters (D7) stay in the
  route's search params. The paginated `GET /projects/{id}/participations` stays as it is.
- **D7. Filters** (codes only, in the URL): main status, profiling and DSV status, wave (or
  `none`), consultant (or `none`), activation and notice state, actions (`any`, `fields`,
  `documents`, `rejected_documents`, `none`), `deadlineKind`, `deadlineState`, flag, portal
  (`reachable`, `not_reachable`); all defined in the domain (`WorklistFilter`) and applied by
  `matchesWorklistFilter`, the predicate of D2.
- **D8. Bulk entry-wave assignment** (deferred from Slice 2): `POST
  /projects/{id}/entry-wave-assignments` `{ waveId, participationIds }` (1–500 distinct), PL only,
  `ta_tg`. One transaction under the exclusive project lock: every participation through the
  status service's checks (`assignEntryWave`), then `assign_entry_wave` for each (one
  `entry_wave_assigned` each). All or nothing, like the consultant assignment: any refusal
  (`status_not_open`, `dsv_already_offered`, `individual_dates_set`, …) refuses the batch with
  every refused row's index and code; a participation already in that wave is left as it is and
  counted `unchanged`. The dialog then says **"Keine Zuweisung vorgenommen"** first and lists the
  refused rows below it, by Personalnummer with their reasons. No new database function.
- **D9. Reminders are manual** (Q152): a current PL or assigned consultant selects rows and sends;
  no scheduled reminder (ASU reminders wait for Q1 and Slice 6); no regional reminder rules: the
  policy is the domain constant `reminderPolicy` (Q155), and regional-variation.md's row "Reminder
  rules" says so.
- **D10. Who sends** (Q153): a current PL of the project, for any non-terminal participation of
  the active project; a current assigned consultant, for their assigned non-terminal
  participations. Nobody else (back office, unassigned consultants, the org roles, participants),
  never in assisted mode or through break-glass. A consultant naming a participation hidden from
  them gets `422 participation_not_found`; a role that sees the participation but may not remind
  (back office) gets `403`. Authority is checked when the reminder is requested and again at the
  dispatch claim (D13); a lost membership or assignment cancels it
  (`requester_no_longer_authorized`). Reminder records and their audit events are never used for
  staff rankings, productivity metrics or general performance monitoring.
- **D11. Channel and consent** (Q154): only a channel the participant registered, verified, not
  removed or suspended, with a live `portal_contact` consent; never imported contact data, the
  work email, postal data, a destination from staff, or another channel after queuing. With
  several live channels: the most recently verified email, else the most recently verified mobile,
  the channel id breaking a tie. The channel id and kind, the account's language and the text
  version are fixed when the reminder is queued; if that channel becomes unavailable the reminder
  is cancelled, never rerouted. `reachable` on the work list means "has such a channel".
- **D12. One kind, a fixed generic text** (Q154): `open_items`, only when the participant has a
  participant action (D3). `portal-reminder:v1`, immutable with fixed SHA-256 tests in the notice
  catalog, final wording with the DPO (Q132):

  | | de | en |
  |---|---|---|
  | Subject (email) | Im Teilnehmerportal ist noch etwas offen | Something is still open in the participant portal |
  | Text | In Ihrem Teilnehmerportal ist noch etwas offen. Bitte melden Sie sich an und prüfen Sie Ihre Angaben oder Unterlagen: `<portal-url>` | Something is still open in your participant portal. Please sign in and review your information or documents: `<portal-url>` |
  | Email only | Diese Nachricht enthält aus Datenschutzgründen keine weiteren Einzelheiten. | For privacy reasons, this message contains no further details. |

  The URL is the plain `PORTAL_PUBLIC_URL`: no token, participant id, campaign parameter or
  tracking redirect; plain-text mail, no pixel, no analytics beyond the provider's outcome. The
  consent must name operational portal notifications, be revocable and exclude advertising:
  `portal-contact-consent:v2` (de/en) says so and is the version new consents record. v1 already
  names "Benachrichtigungen aus dem Portal" and is revocable, so a v1 consent (synthetic data only
  so far) still covers reminders (a reading for the owner to confirm). Removing the last channel
  warns that portal login is then no longer possible and that help in person, by phone or by
  letter remains (the portal's existing warning, new copy).
- **D13. Queued atomically, checked again under current state before dispatch** (Q154, Q155):
  - **Request:** the API evaluates the selection's actions (TypeScript) and calls
    `request_reminders`, which checks authority, the project, each participation's status, the
    channel and the window, picks the channel and writes the rows `queued` with one
    `reminder_queued` each; in the same transaction the API sends one `reminders.send` job per
    queued reminder through pg-boss on the transaction's connection. A failed enqueue rolls back
    rows, events and jobs alike: nothing is queued without its job.
  - **Dispatch claim:** the worker opens a transaction, locks the participation
    (`lock_participation`: the participant's writes and the team changes serialise with it),
    loads the actions' facts and evaluates them, then calls `claim_reminder_dispatch` with that
    verdict; the function locks the channel and consent rows and rechecks the channel, the
    consent, the participation's status, the requester's authority and the verdict. It marks the
    reminder `dispatching` or cancels it (`channel_unavailable`, `consent_ended`,
    `participation_closed`, `nothing_open`, `requester_no_longer_authorized`), audited. The
    guarantee: **no dispatch when the invalidating change committed before the claim**; a change
    committed after the claim may still see the message sent.
  - **Outcomes:** the provider's `sent` → `sent`; a definitive `failed` → `failed`, no retry; a
    provider error or an unknown outcome fails the job for a retry (5, with backoff, the same
    provider key `reminder:<reminderId>`). A retry repeats the claim: if the claim now fails, the
    reminder ends `delivery_unknown` (an earlier attempt may have delivered it) without another
    send. The last attempt's error ends it `delivery_unknown`. No sender wired at dispatch →
    `cancelled` (`delivery_unavailable`) before any claim. Every final state is audited
    (`reminder_delivery`).
  - **Window:** one reminder per participation within 3 Berlin calendar days, counted from the
    last **queued request**, whatever its outcome: a reminder requested on a Monday allows the
    next on the Thursday.
  - Without pg-boss (`JOBS_ENABLED=false`: tests and e2e only) the handler runs after the commit
    (`detached.ts`). With `NODE_ENV=production` the route refuses `503 jobs_unavailable` without
    pg-boss and `503 delivery_unavailable` without a sender, before writing anything.
- **D14. The message log** (Q156; PRD F4 "all messages logged per participant"):
  `participant_reminder` holds ids, kind, text version, language, channel id and kind, the
  requester, times, status and a closed cancel reason; never an address, rendered text, provider
  response, free text, error message, IP or tracking data. The tab "Nachrichten" on the
  participant detail is readable by whoever reads the participation's `case_internal` data: the
  PL, the assigned consultant and back office.
- **D15. Bulk sending skips per row and refuses only for the request as a whole.** Skipped with a
  code: `no_channel`, `reminded_recently`, `nothing_open`, `participation_closed`. Refused as a
  whole: visibility (D10), `403`, `project_not_active`, duplicates, `503`. The work list's
  capability `remind` (with its code) gives the dialog its counts before sending; the database
  decides again.
- **D16. The audit history is redacted inside the database** (Q157, Q87 A). `transfer_app` keeps
  no privilege on `audit_event`; `audit_history` is the authorization boundary and returns only the
  final projection; the API localizes and validates, and removes nothing:
  - It resolves the staff user from the live staff session and reloads the memberships and the
    assignment. Rows: PL `case`, `profiling`, `dsv`; assigned consultant `stream in (case,
    profiling) or (actor_staff_user_id = viewer and stream in (dsv, payroll))`; back office `dsv`,
    `payroll`; the union of the viewer's roles (Q61). Never `security` or `review` events,
    project-level events, logins, one-time codes, step-ups, sensitive reads or writes, document
    openings, break-glass, exports or session events.
  - Per event type the reference table `audit_event_projection` (generated from the domain,
    drift-tested) gives the stream, whether `field`/`from`/`to` and the reason code are shown, and
    the allowed detail keys; field keys inside details (e.g. `participant_data_changed`) are kept
    only for the access categories the viewer's role may know (`role_field_knowledge`, generated
    from `decideAccess`, drift-tested). Everything else is null or absent in the function's
    result.
  - The actor: the staff member's current display name while it is retained, else null
    ("Ehemaliges Teammitglied"); "Teilnehmer·in", "System", "(assistiert)". Names aren't
    searchable or exportable here; the history serves case reconstruction, correction, compliance
    and the investigation of a concrete incident, never rankings or routine monitoring.
  - The first page writes `audit_history_opened` (viewer, participation, time; `security` stream,
    never returned in a history).
  - The API's cursor is opaque (base64url of the position), whatever the function uses inside.
- **D17. The participant detail gets the tabs "Nachrichten" (D14) and "Verlauf" (D16).**

## PRs

One planned PR = one branch, each based on `main` after its predecessor merged (none stacked);
about 1,500 changed production lines is a soft limit, not a target. 5-3 needs neither 5-1 nor
5-2, but its projection table must cover every event type, so it follows 5-2.

| PR | Scope | Est. lines |
|---|---|---|
| 5-1 | Dashboard and work list (D1–D8): the projection, actions, deadlines, funnel and filters in the domain; the worklist snapshot and dashboard routes, bulk wave assignment; the tabs "Übersicht" and "Teilnehmende" with filters, the in-memory search and the wave action | ~1,450 |
| 5-2 | Reminders (D9–D15): policy, texts and consent v2; `participant_reminder`, `request_reminders`, `claim_reminder_dispatch`, `record_reminder_outcome`, grants and events; the job; the routes; "Erinnern", the column and the tab "Nachrichten" | ~1,500 |
| 5-3 | Audit history (D16, D17): the projection and knowledge tables in the domain, `audit_event_projection`, `role_field_knowledge`, `audit_history`, the route and the tab "Verlauf"; archive this plan | ~1,100 |

## Design

### Domain (`packages/domain`, no I/O, no system time)

5-1, `src/worklist/`:
- `worklistProjection(facts, snapshot, project, today, viewer)` → `WorklistItem`;
  `participantActions` (D3); `deadlinesOf` and `mostUrgent` (D5: `DeadlineKind`,
  `DeadlineState`, `deadlineWarningDays = 14`); `remainingFlags`; `projectFunnel(items)` and
  `funnelFilters` (each count's `WorklistFilter`); `WorklistFilter` (Zod) and
  `matchesWorklistFilter`; `searchKey(text)` (the folding of D6, shared with the web app);
  `worklistMaxRows`.
- Capability `assignEntryWave` per item (the detail's rule, `participation-view.ts`).

5-2, `src/reminders/`:
- `ReminderKind` (`open_items`); `ReminderStatus` (`queued`, `dispatching`, `sent`, `failed`,
  `delivery_unknown`, `cancelled`); `ReminderSkip` (`no_channel`, `reminded_recently`,
  `nothing_open`, `participation_closed`); `ReminderCancelReason` (`channel_unavailable`,
  `consent_ended`, `participation_closed`, `nothing_open`, `requester_no_longer_authorized`,
  `delivery_unavailable`).
- `reminderPolicy` (3 Berlin days from the last queued request; 1–500 per request);
  `nextEligibleDate(lastQueuedOn)`; `mayRemind(subject, target)` beside `mayPerformOperation`;
  `chooseChannel(channels)` (D11); `reminderEligibility(item, lastQueuedOn, today)` → `ok` or a
  skip code (the capability; the database decides again).
- Notice catalog: `portal-reminder:v1` (D12) and `portal-contact-consent:v2`, each de/en with its
  SHA-256; the reminder's only placeholder is the portal URL.
- Audit events (reserved): `reminder_queued` (reminder and batch id, kind, channel kind),
  `reminder_delivery` (reminder id, outcome, cancel reason).

5-3, `src/audit/`:
- `auditProjection`: per `AuditEventType` (and, for `status_changed`, per field: `status` →
  `case`, `profiling_status` → `profiling`, `dsv_status` → `dsv`) the stream, `showsChange`,
  `showsReason` and the allowed detail keys; exhaustive (a test fails for a type without a row).
- `roleFieldKnowledge`: per project role the access categories whose field keys it may know,
  derived from `decideAccess`.
- `historyStreams(roles, assigned)`; the event `audit_history_opened`. The generated access
  matrix adds the table "Audit history" (type → stream, change, reason, detail keys).

### Data model

5-1: none.

5-2 (data catalog; `project_id` and a composite FK to `participation`):

| Table | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|
| `participant_reminder` | id, project, participation, `batch_id`, `kind`, `message_version`, `language`, `channel_id` (FK `participant_channel`), `channel_kind`, `requested_by` (staff id), `requested_at`, `requested_on` (Berlin date, for the window), `status`, `cancel_reason`, `claimed_at`, `outcome_at`; nothing else (D14) | internal / `case_internal` | `personnel_file` (Q156: non-signers with the 90-day deletion of the operational file, otherwise the end of the 3rd calendar year after exit; a legal hold extends only the affected rows; the channel's address is erased under its own rule and the reminder keeps the value-free channel id) |

5-3:

| Table | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|
| `audit_event_projection` | event type, field (null except `status_changed`), stream, `shows_change`, `shows_reason`, `detail_keys text[]`; migrations only, drift-tested against `auditProjection` | no personal data | `reference_data` |
| `role_field_knowledge` | project role, access category; migrations only, drift-tested against `roleFieldKnowledge` | no personal data | `reference_data` |

The slice's audit events (`reminder_queued`, `reminder_delivery`, `audit_history_opened`) are
`audit_log`: three years, the participation reference pseudonymised when the participant's record
is deleted.

### Functions and grants (hand-written, SECURITY DEFINER, audit in the same transaction)

5-2:
- `request_reminders(context, project, participation ids, kind, message version, batch id)` → per
  participation the reminder id or a skip code. Exclusive project lock; refuses
  `project_not_active`, `participation_not_found` (another project's id, or for a consultant one
  not assigned to them), `actor_not_allowed` (any other role, assisted mode); per row
  `participation_closed`, `no_channel`, `reminded_recently` (database Berlin date). The API passes
  only participations with a participant action and skips the rest `nothing_open` itself. Picks
  and stores the channel and language (D11); writes `queued` and `reminder_queued`.
- `claim_reminder_dispatch(reminder, has_actions, job id)` → `dispatching`, `settled` (the job
  stops) or the cancel reason. Under `lock_participation`, with the channel and consent rows
  `FOR SHARE`, it rechecks D13; from `dispatching` (a retry) a failed check settles
  `delivery_unknown`.
- `record_reminder_outcome(reminder, outcome, cancel reason, job id)`: system actor; once per
  reminder (the same outcome again is a no-op, another `reminder_settled`); `reminder_delivery`.
- Grants: `transfer_app` selects `participant_reminder` and writes none; `EXECUTE` on the three;
  `record_audit_event` refuses the two event types.

5-3:
- `audit_history(staff session hash, participation, before seq, limit)` → the projected rows (seq,
  time, type, actor kind, retained display name, system job, on behalf, field, from, to, reason
  code, effective date, details), newest first, at most 100. A live staff session
  (`unauthenticated`), a member of the participation's project (`not_member`), a consultant only
  while assigned; the predicates and projection of D16 through `audit_event_projection` and
  `role_field_knowledge`; on the first page (no `before seq`) it writes `audit_history_opened`.
  Slice 7 adds the evidence-set phase (break-glass, round 12).
- Grants: `EXECUTE` on `audit_history`, `SELECT` on the two reference tables; still no privilege
  on `audit_event`.

### API (`/api/v1`, OpenAPI, RFC 9457)

| PR | Route | Does |
|---|---|---|
| 5-1 | `GET /projects/{id}/dashboard` | `ProjectDashboard`: tiles and counts (D4), each with its `filter`; the next dates per wave with their counts; `scope` (`project` / `assigned`); `private, no-store`; `403` without a list scope |
| 5-1 | `GET /projects/{id}/worklist` | `Worklist` `{ generatedAt, items: WorklistItem[] }`: the whole authorized scope (D6); `private, no-store`; `422 worklist_too_large` |
| 5-1 | `POST /projects/{id}/entry-wave-assignments` | `{ waveId, participationIds }` → `200 { assigned, unchanged }`; `422` with `errors[]` at `/participationIds/<i>` per refused row |
| 5-2 | `POST /projects/{id}/reminders` | `{ kind, participationIds }` → `201 { batchId, queued, skipped: [{ participationId, code }] }` |
| 5-2 | `GET /participations/{id}/reminders` | the reminders, newest first (cursor); for `case_internal` readers |
| 5-3 | `GET /participations/{id}/history` | `HistoryPage`, newest first, an opaque cursor |

`WorklistItem` (5-2) adds `reminder: { lastRequestedOn, status } | null` and `capabilities.remind`
(`{ allowed, code }`). New codes: 422 `worklist_too_large`, 503 `jobs_unavailable`; the others
exist (`project_not_active`, `participation_not_found`, `not_ta_tg`, the wave codes,
`delivery_unavailable`). Skips are data in the `201`, not problems. Order as in ADR-0010: schema →
visibility (404, or `participation_not_found` for ids in a body) → permission 403 → state 422.

### Jobs (5-2)

`reminders.send` (`exclusive`, `singletonKey` the reminder id, retries 5 with backoff), queued in
the request's transaction (D13). Payload `{ reminderId }`. Logs: job, id, reminder id, outcome;
never an address, text, name or provider error.

### Web UI (`apps/web`, German only)

- 5-1: "Übersicht": the tiles, a table per track, "Nach Welle", "Fristen" (kind × state), the
  flags; every number links to "Teilnehmende" with its filter. "Teilnehmende": the filter bar
  (route search params), the search field (the states of D6), the columns "Offen" (the number of
  actions and the first as tags, with the self-service labels), "Frist" (the most urgent,
  "überschritten seit …" or "in n Tagen"), "Portal"; "Alle Treffer auswählen"; the bulk action
  "Eintrittswelle zuweisen" with the refusal text of D8.
- 5-2: bulk "Erinnern": counts from the rows' capabilities ("per E-Mail", "per SMS", "nicht
  erreichbar", "kürzlich erinnert (wieder ab …)", "nichts offen"), the fixed text as preview,
  "Senden", then the result per code; the column "Erinnert"; the detail tab "Nachrichten" (date,
  kind, E-Mail/SMS, status or cancel reason, "Team").
- 5-3: the detail tab "Verlauf": Zeitpunkt (Berlin), Ereignis, Änderung (von → nach), Grund,
  wirksam am, durch; "Mehr laden".
- Every button by its capability (ADR-0010, capabilities).

## User flows

1. **PL, morning check:** "Übersicht" → "Frist in 14 Tagen: 6" → the list filtered to those six,
   the most urgent first → opens one participant.
2. **PL, wave planning:** "Teilnehmende" → filter "ohne Welle", status `informed` → "Alle Treffer
   auswählen" (30) → "Eintrittswelle zuweisen" W2 → "Keine Zuweisung vorgenommen", one row
   `individual_dates_set` → deselects it → 29 assigned.
3. **PL, chasing data:** filter "offene Angaben", portal "erreichbar" → "Alle Treffer auswählen"
   → "Erinnern": "18 per E-Mail, 2 per SMS, 3 kürzlich erinnert (wieder ab Donnerstag)" → sends.
   One participant completes the wizard before the job runs: their reminder is cancelled
   `nothing_open`.
4. **Consultant:** both tabs show only their assigned participations; reminds two of them.
5. **Back office:** reads "Nachrichten", isn't offered "Erinnern"; "Verlauf" shows DSV and payroll
   events only (none before Slice 7).

## Acceptance criteria

**5-1**
- Domain tests first (100 % coverage): actions per step and document state (a rejected required
  type is one `rejected` action, never also `missing`); a field the viewer may not know about is
  never named; `ta_only` skips `ta_tg` rules; every deadline kind at 15, 14, 0 and −1 days and
  across a DST change; the most-urgent order and its tie order; a cutoff counted once; every count
  equals its filter's result (D2); tiles count distinct participations.
- Integration: the snapshot holds exactly the viewer's scope (PL, back office, assigned
  consultant); an unassigned consultant and the org roles get `403`; the scope follows an
  assignment change on the next request; no payload carries a sensitive value (every response
  searched for the synthetic sensitive values); `private, no-store` on both routes; 2,000
  synthetic participations answer in under 1 s in CI (timings in the PR); above `worklistMaxRows`
  `422`.
- Bulk wave: assigns and audits each; any refusal assigns none and names each refused index and
  code; already-assigned rows count `unchanged`; only the PL; `ta_only` refused.
- Component tests: tiles and tables link to the matching filter; the filter bar ↔ search params;
  while loading, the search and "Alle Treffer auswählen" are disabled and no empty state appears;
  the term never reaches the URL, a query key or `localStorage`/`sessionStorage`; the refusal text
  of D8.
- e2e `dashboard.spec.ts` (no code submission: synthetic participations through the staff API and
  the owner fixtures in `participants.ts`; fails on any CSP violation; `expectAccessible`): the PL
  follows a count to the same number of rows, searches a synthetic name and assigns two rows to a
  wave. **Performance:** with 2,000 synthetic participations, from opening "Teilnehmende" to the
  result of a typed name in under 3 s, and each further keystroke's result in under 100 ms
  (Chromium in CI); the recorded requests show one worklist request and none carrying the term.

**5-2**
- Domain tests: eligibility per skip code; Monday → Thursday and the window across a DST change;
  the channel choice (two emails, email vs. mobile, the id tie-break); the texts' SHA-256 and the
  single placeholder.
- Integration: rows, events and jobs commit together and an enqueue failure leaves none; skips
  are enforced in the function with the API bypassed; a consultant naming a hidden participation
  gets `participation_not_found`, back office `403`; `NODE_ENV=production` without a sender or
  without pg-boss writes nothing (`503`). The claim: each cancel reason when its change committed
  before the claim (channel removed, consent ended, participation closed, the wizard completed,
  the consultant unassigned); no reroute to another channel; a retry after an unknown outcome
  sends with the same key and settles `delivery_unknown` when its claim now fails; a definitive
  failure is final; the runtime role can't write `participant_reminder`.
- Log capture: no address, text, name or provider error in logs, job payloads, errors or audit
  details.
- Component tests: the dialog's counts, the result per code, "Nachrichten" for each role.
- e2e `reminders.spec.ts` (no code submission: `activatedParticipant`, `loggedInAsOwner`; CSP
  check): an activated participant with open items and one without an account → one sent, one
  skipped `no_channel`; the development outbox holds exactly the fixed German text with the plain
  portal URL and none of the participant's data; a second request is skipped `reminded_recently`;
  the participant follows the link into the portal.

**5-3**
- Domain tests: every event type has a projection row; the streams per role and assignment.
- Integration, **calling `audit_history` directly as `transfer_app`**: the drift tests of both
  reference tables; per role exactly the rows of D16 (a consultant sees their own DSV action but
  not another's); a detail key not on the allowlist, a reason code with `shows_reason` false and a
  field key of a category the role may not know never appear in the function's result;
  `document_opened`, `sensitive_read`, logins and `audit_history_opened` never appear; an ended
  session, an unassigned consultant and a non-member are refused; the first page writes one
  `audit_history_opened`, later pages none; `transfer_app` still can't select `audit_event`.
- Component test: every event type's label, the actor kinds, "Ehemaliges Teammitglied", "Mehr
  laden" with the opaque cursor.
- e2e `history.spec.ts` (no code submission; CSP check): after a wave assignment and a reminder
  the PL sees both with their actor; the document opening isn't listed.

## Docs updated by the PRs

- 5-1: `process-and-lifecycle.md` (deadline warnings and participant actions as built, bulk wave
  assignment), `data-protection.md` (the work list and dashboard: scope, exact counts and Q150,
  `no-store`, the search never leaving the browser), ADR-0010 (the routes, the bounded snapshot as
  an exception to cursor pagination, codes), `architecture/overview.md` (the project page's tabs).
- 5-2: ADR-0002 (`participant_reminder`, the functions, grants), ADR-0006 (reminder delivery as
  built), ADR-0011 (`reminders.send`, the claim), ADR-0010 (routes, codes), `data-protection.md`
  (reminders: who, channel and consent, the text, no monitoring use, the retention row, consent
  v2), `regional-variation.md` (no regional reminder rules, Q152).
- 5-3: ADR-0002 (the reference tables, `audit_history`, grants), ADR-0010 (the history route),
  `data-protection.md` ("Audit metadata" as built, the purposes of the history, Q157), the
  generated access matrix ("Audit history"), `roadmap.md` (Slice 5 done); this plan moves to
  `plans/archive/`.
