# Slice 5 — PL dashboard (F7) and reminders (F4 basics)

Status: **proposed** 2026-10-22, awaiting the product owner's review. Nothing is implemented
before approval.
Roadmap: funnel, "what's missing", filters, bulk reminder (mail/SMS adapters, mock), deadlines;
deferred here from Slice 2: bulk entry-wave assignment and the audit history UI (the runtime role
can't read `audit_event` yet). Builds on the participant list
(`apps/web/src/components/participants.tsx`, `GET /projects/{id}/participations`), the
completeness engine (`packages/domain/src/completeness/engine.ts`) and `selfServiceMissing` with
live document states (Slice 4b), the planner's derived flags (`lifecycleFlags`,
`packages/domain/src/lifecycle/planner.ts`), the mail/SMS adapters with their mocks and the
development outbox (ADR-0006), the portal channels and the `portal_contact` consent
(data-protection.md, authentication), single wave assignment (`assign_entry_wave`) and the audit
streams of `decideAccess` (Q87 A).
The open questions this plan needs are Q150–Q159 in `docs/open-questions.md`, each with a
proposed answer marked `assumed`; the decisions below build on those answers.

## Decisions

- **D1. One work list, not a second list.** "What's missing" is the participant list with derived
  columns and filters, not a new list: the existing list keeps its selection and bulk actions
  (consultants, activation codes) and gains wave assignment (D7) and reminders (D8–D12). The
  project page gets the tabs "Übersicht" (the dashboard, D3), "Teilnehmende" (the list),
  "Einrichtung" (setup, Agentur settings, waves, import) and "Team".
- **D2. What is "open" in Slice 5** (PRD F7; Q151): per participation the missing items of the
  steps whose facts exist today, `data_collection` and `profiling` (fields and the participant's
  own document types, as `selfServiceMissing` gives them, from the participation's own resolved
  chain), the rejected own documents (`not_accepted`), the planner's lifecycle flags, the next
  deadline (D4) and whether the portal reaches the participant (D10). `asu_registration` and `dsv`
  items (the ASU proof and the DSV scan can't be stored before Slices 6 and 7), TL 407 and
  Kug 200b lists, "DSV signed, not fully executed" and the regional admin's escalation view (Q57)
  come with their slices, each as one more item kind in the same list. Overdue appointments come
  with appointments (Q158). Missing items are codes, and only for fields the viewer may know about
  (the rule of the "Selbstauskunft" tab: `staffSelfServiceAccess` `knows`); presence, never a
  value (data-protection.md, self-service data).
- **D3. The dashboard is a staff view, unsuppressed only for viewers who can list every counted
  participation** (Q150). Counts per main status, profiling and DSV status (`ta_tg`), per wave
  (and "ohne Welle"), portal activation, Art. 14 notice due/overdue, per lifecycle flag and per
  deadline kind; each count links to the filtered list. The PL and back office count the project,
  an assigned consultant their assigned participations; an unassigned consultant and the org roles
  get `403` (their aggregate views come with Slice 6, Q57). No aggregate of this slice leaves the
  app: no export, no report (Q159). The n < 5 suppression with secondary suppression is built in
  the reporting layer with the customer report (Slice 9, CLAUDE.md rule 6), where an aggregate can
  reach the customer. No chart library: tables and tiles (the CSP forbids inline styles).
- **D4. Deadline warnings are derived, informational, never guards** (Q151): the offer deadline of
  an open DSV offer, the effective TG start while `informed`, the wave's latest entry date
  (the existing `cutoff_warning` / `cutoff_final_reminder`, Q78) and the Art. 14 notice due date
  (Q124), each from 14 calendar days before (`deadlineWarningDays`, the Q78 horizon), plus the
  passed ones the planner flags (`tg_start_missed`, `profiling_exception_deadline_missed`). The
  ASU due date waits for Slice 6 (no knowledge date or ASU record yet, and Q1 needs a PL's
  confirmation before reminders use it).
- **D5. Computed on read, per project.** Completeness depends on each participation's resolved
  chain (TypeScript, ADR-0004), so the open items can't be a SQL predicate. The list and the
  dashboard load the project's participations in the viewer's scope in two queries (facts and live
  documents; the flags with the guard facts the nightly sweep uses, `GuardFactsProvider`), resolve
  the configuration once per placement Agentur, evaluate in memory and, for a derived filter, page
  the result by the same keyset `(created_at, id)`. No stored copy to drift.
  PRD: up to 2,000 participations; the PR reports the timings (target p95 < 300 ms).
- **D6. Filters are codes in the query; the name search never leaves the browser.** Server
  filters: main status, profiling and DSV status, wave (or `none`), consultant (or `none`),
  activation and notice state (exist), open items (`any`, `fields`, `documents`,
  `rejected_documents`, `none`), flag, deadline (`soon`, `passed`), portal (`reachable`,
  `not_reachable`). They are ids and codes only, so the web app keeps them in the route's search
  params. The search by name or Personalnummer filters the rows in the browser (PRD:
  client-side); while a term is typed the list loads its remaining pages. A term is never in a
  URL, a query key that persists, a log or a request (ADR-0010: no personal data in URLs).
- **D7. Bulk entry-wave assignment** (deferred from Slice 2): `POST
  /projects/{id}/entry-wave-assignments` `{ waveId, participationIds }` (1–500 distinct), PL only,
  `ta_tg`. One transaction under the exclusive project lock: every participation through the
  status service's checks (`assignEntryWave`), then `assign_entry_wave` for each (one
  `entry_wave_assigned` each). All or nothing like the consultant assignment: any refusal
  (`status_not_open`, `dsv_already_offered`, `individual_dates_set`, …) refuses the batch with
  every refused row's index and code. A participation already in that wave is left as it is and
  counted `unchanged` (the bulk reading of `wave_unchanged`). No new database function.
- **D8. Reminders are manual in Slice 5** (Q152): a PL or assigned consultant (Q153) selects rows
  and sends; no scheduled reminder to participants (automatic ASU reminders wait for Q1 and Slice
  6). No regional reminder rules: the policy is a domain constant (`reminderPolicy`, Q155), and
  the row "Reminder rules" in regional-variation.md says so.
- **D9. One reminder kind, generic content** (Q154): `open_items`, sent only when the participant
  has something to fix in the portal (a missing wizard item or a rejected own document). The text
  `portal-reminder:v1` (de/en, the account's language, immutable with fixed SHA-256 tests in the
  notice catalog) says only that something is open in the participant portal, with its link: no
  name, item, date, employer or project. A portal notification under the consent
  `portal-contact-consent:v1` ("Benachrichtigungen aus dem Portal"); final wording with the DPO
  (Q132).
- **D10. Consent and channel state decide, twice** (Q123, Q154): only a live portal channel
  (verified, not suspended, not removed) whose `portal_contact` consent hasn't ended; never an
  imported email or phone, never the work email. One message per reminder: the live email, else
  the live mobile (SMS). Checked when the reminder is requested (in the database function) and
  again by the job before it sends; a reminder whose channel or consent ended meanwhile, or whose
  participation closed, is `cancelled` with that reason and never sent.
- **D11. Bulk sending skips, it doesn't refuse.** A selection is accepted per row: a participation
  that can't be reminded is skipped with its code (`no_channel`, `reminded_recently`,
  `nothing_open`, `participation_closed`) and the answer lists them; the rest are queued. Refused
  as a whole only for authority, an inactive project, unknown or foreign ids, or no sender
  (`503 delivery_unavailable`, before anything is written, as in production until a real provider
  exists, ADR-0006). The list's capability `remind` (with the code) lets the dialog show the
  counts before sending; the API decides again.
- **D12. Each reminder is a row and audited** (Q156; PRD F4 "all messages logged per
  participant"): `participant_reminder` (kind, text version, language, channel id and kind,
  requester, times, outcome; never an address or text), `reminder_queued` when requested and
  `reminder_delivery` with the outcome, both in the `case` stream. The job's payload is the
  reminder id only; logs carry ids and outcomes only.
- **D13. The audit history is a database read function, not a grant** (Q157, Q87 A):
  `transfer_app` keeps no privilege on `audit_event`. `audit_history` resolves the staff user from
  the live staff session, derives the viewer's streams from their memberships and assignment in
  SQL (PL `case`, `profiling`, `dsv`; assigned consultant `case`, `profiling` and their own actions
  in `dsv`, `payroll`; back office `dsv`, `payroll`; the union of the viewer's roles, Q61) and
  returns that participation's events of those streams. The stream of each event type is a domain
  table (exhaustive, generated into the access matrix) mirrored in the reference table
  `audit_event_stream` (drift test). The `security` and `review` streams, project-level events and
  the regional operations manager's review queue are not shown in Slice 5. The API projects
  `details` through a per-type allowlist and drops field keys the viewer may not know about.
- **D14. The participant detail gets the tabs "Nachrichten" (reminders) and "Verlauf" (history).**

## PRs

One planned PR = one branch, each based on `main` after its predecessor merged (none stacked).
Three PRs, one per concern; 5-3 needs neither 5-1 nor 5-2, but its stream table must cover every
event type, so it follows 5-2.

| PR | Scope | Est. lines |
|---|---|---|
| 5-1 | Dashboard and work list (D1–D7): open items, deadlines, funnel and filters in the domain; the worklist loader, list filters and columns, the dashboard route, bulk wave assignment; the tabs "Übersicht" and "Teilnehmende" with filters, search and the bulk wave action | ~1,400 |
| 5-2 | Reminders (D8–D12): reminder policy and text, `participant_reminder`, its functions, grants and events, the job `reminders.send`, the routes, the bulk action "Erinnern" and the tab "Nachrichten" | ~1,400 |
| 5-3 | Audit history (D13, D14): the stream table, `audit_event_stream`, `audit_history`, the history route and the tab "Verlauf"; archive this plan | ~900 |

## Design

### Domain (`packages/domain`, no I/O, no system time)

5-1, `src/dashboard/`:
- `dashboardSteps = ["data_collection", "profiling"]`; `participationOpenItems(facts, snapshot,
  project, today, { knows })` → `{ missing: { step, kind, key, reason }[], rejectedDocuments,
  flags, deadline: { kind, date } | null }` (reusing `evaluateCompleteness` and `lifecycleFlags`).
- `nextDeadline(snapshot, notice, today)`; `DeadlineKind`: `offer_deadline`, `tg_start`,
  `latest_entry_date`, `privacy_notice`; `deadlineWarningDays = 14` (Q151).
- `projectFunnel(items)` → the counts of D3; `WorklistFilter` (Zod) and `matchesWorklistFilter`.
- Capability `assignEntryWave` on list items (the existing detail rule, `participation-view.ts`).

5-2, `src/reminders/`:
- `ReminderKind` (`open_items`), `ReminderStatus` (`queued`, `sent`, `failed`,
  `delivery_unknown`, `cancelled`), `ReminderSkip` (`no_channel`, `reminded_recently`,
  `nothing_open`, `participation_closed`), `ReminderCancelReason` (`channel_unavailable`,
  `consent_ended`, `participation_closed`).
- `reminderPolicy` (Q155): at most one per participation within 3 Berlin calendar days of the
  last queued one; 1–500 per request. `mayRemind(subject, target)` (Q153) beside
  `mayPerformOperation`; `reminderEligibility(openItems, channels, lastReminder, status, today)` →
  `ok` or a skip code (the capability and the API's pre-check; the function decides again).
- `portal-reminder:v1` (de/en) in `notices/catalog.ts` with its SHA-256; `channelFor(channels)`:
  the live email, else the live mobile.
- Audit events `reminder_queued` (reminder id, batch id, kind, channel kind) and
  `reminder_delivery` (reminder id, outcome, cancel reason), reserved.

5-3, `src/audit/streams.ts`: `auditStreamOf(eventType, field)` for every event type (a
`status_changed` by its field: `status` → `case`, `profiling_status` → `profiling`,
`dsv_status` → `dsv`); `historyDetails(eventType, details)` (the allowlist per type);
`historyStreams(roles, assigned)` (Q87 A, the same table `decideAccess` uses). The generated
access matrix adds "Audit streams" (event type → stream).

### Data model

5-1: none.

5-2 (data catalog; `project_id` and a composite FK to `participation`):

| Table | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|
| `participant_reminder` | id, project, participation, `batch_id`, `kind`, `message_version`, `language`, `channel_id` (FK `participant_channel`), `channel_kind`, requested by (staff id), `requested_at`, `status`, `cancel_reason`, `outcome_at`; no address, no text, no provider response | internal / `case_internal` | `personnel_file` (Q156; the channel row's address is erased after its removal, the reminder keeps only the channel id) |

5-3:

| Table | Holds | dataClass / accessCategory | retentionClass |
|---|---|---|---|
| `audit_event_stream` | event type, field (null except `status_changed`), stream; written by migrations only, drift-tested against `auditStreamOf` | no personal data | `reference_data` |

### Functions and grants (hand-written, SECURITY DEFINER, audit in the same transaction)

5-2:
- `request_reminders(context, project, participation ids, kind, message version, batch id)` →
  per participation the reminder id or a skip code. Under the exclusive project lock: the project
  `active` (`project_not_active`), every id of the project (`participation_not_found`), the actor a
  PL of the project or the consultant assigned to each participation (`actor_not_allowed`; never
  assisted mode); per row `participation_closed`, `no_channel` (no live channel with a live
  `portal_contact` consent; the email preferred), `reminded_recently` (database Berlin date). The
  API passes only participations its open-items check found `ok` and skips the rest
  `nothing_open` itself (completeness is TypeScript). Writes the rows `queued` and
  `reminder_queued` each.
- `record_reminder_delivery(reminder, outcome, cancel reason, job id)`: system actor, once per
  reminder (a second call with the same outcome is a no-op, another is `reminder_settled`);
  `reminder_delivery`.
- Grants: `transfer_app` selects `participant_reminder` and writes none; `EXECUTE` on both.
  `record_audit_event` refuses the two event types.

5-3:
- `audit_history(staff session hash, participation, before seq, limit)` → rows (seq, time, type,
  actor kind, staff id and display name, system job, on behalf, field, from, to, reason code,
  effective date, details). Only a live staff session (`unauthenticated`); the participation's
  project roles of that user (`not_member`); a consultant only while assigned; the streams of
  D13 joined through `audit_event_stream`; newest first, at most 100. Not audited (audit
  metadata, no sensitive event). Slice 7 adds the evidence-set phase (break-glass, round 12).
- Grants: `transfer_app` gets `EXECUTE` on `audit_history` and `SELECT` on `audit_event_stream`;
  still no privilege on `audit_event`.

### API (`/api/v1`, OpenAPI, RFC 9457)

| PR | Route | Does |
|---|---|---|
| 5-1 | `GET /projects/{id}/dashboard` | `ProjectDashboard`: the counts of D3, the next dates per wave with their counts, `scope` (`project` / `assigned`); `403` for a viewer with no list scope |
| 5-1 | `GET /projects/{id}/participations` (extended) | the D6 filters; items add `openItems` (`missing`, `rejectedDocuments`, `flags`, `deadline`, `reachable`) and `capabilities.assignEntryWave` |
| 5-1 | `POST /projects/{id}/entry-wave-assignments` | `{ waveId, participationIds }` → `200 { assigned, unchanged }`; `422` with `errors[]` at `/participationIds/<i>` per refused row |
| 5-2 | `POST /projects/{id}/reminders` | `{ kind, participationIds }` → `201 { batchId, queued, skipped: [{ participationId, code }] }` |
| 5-2 | `GET /participations/{id}/reminders` | the participation's reminders, newest first (cursor) |
| 5-3 | `GET /participations/{id}/history` | `HistoryPage`: entries newest first, cursor `seq` |

List items (5-2) add `reminder: { lastRequestedAt, status } | null` and `capabilities.remind`
(`{ allowed, code }`). No new problem codes: the routes use the existing 422 `project_not_active`,
`participation_not_found`, `not_ta_tg` and the wave codes, and 503 `delivery_unavailable`; skips
are data in a `201`, not problems. Order as in ADR-0010: schema → visibility 404 → permission 403
→ state 422.

### Jobs (5-2)

`reminders.send` (`exclusive`, `singletonKey` the reminder id, retries 5 with backoff), queued per
reminder in the request's transaction. The worker loads the reminder, its channel and the
participation; cancels (D10) or sends with the provider key `reminder:<reminderId>`; records
`sent` or `failed`; a provider error fails the job for a retry, the last attempt records
`delivery_unknown`. Never logs an address, text or provider error. Without pg-boss
(`JOBS_ENABLED=false`: tests, e2e) the API runs the same handler after the response
(`detached.ts`).

### Web UI (`apps/web`, German only)

- 5-1: tab "Übersicht": tiles "Teilnehmende", "aktiviert", "offene Angaben", "Hinweise", a table
  per track (status, Anzahl, link), "Nach Welle", "Fristen (14 Tage)" (date, kind, wave, Anzahl).
  Tab "Teilnehmende": a filter bar (D6) bound to the route's search params, the search field, the
  columns "Offen" (count and the first items as tags, labels from the self-service labels),
  "Nächste Frist", "Portal"; bulk action "Eintrittswelle zuweisen" (wave, then the refused rows
  shown by Personalnummer when the API refuses).
- 5-2: bulk action "Erinnern": a dialog with the counts from the rows' capabilities (wird erinnert
  per E-Mail / SMS, nicht erreichbar, kürzlich erinnert, nichts offen), a preview of the generic
  text, "Senden"; the result per skip code. Column "Erinnert" (date, state). Detail tab
  "Nachrichten": date, Art, Kanal (E-Mail/SMS), Status, angefordert von (Team).
- 5-3: detail tab "Verlauf": Zeitpunkt (Berlin), Ereignis, Änderung (von → nach), Grund, wirksam
  am, durch (staff name, "Teilnehmer·in", "System", "… (assistiert)"); "Mehr laden".
- Every button by its capability; neither page derives a permission (ADR-0010, capabilities).

## User flows

1. **PL, morning check:** "Übersicht" → 23 participations with open items, 4 offers expiring
   within 14 days → clicks "Angebot läuft ab" → the list filtered → opens one participant.
2. **PL, wave planning:** "Teilnehmende" → filter "ohne Welle", status `informed` → selects 30 →
   "Eintrittswelle zuweisen" W2 → one row refused (`individual_dates_set`), shown by
   Personalnummer → deselects it → 29 assigned.
3. **PL, chasing data:** filter "offene Angaben", portal "erreichbar" → selects all → "Erinnern" →
   "18 per E-Mail, 2 per SMS, 3 kürzlich erinnert" → sends; participants without a portal account
   are filtered out and get an activation code instead (existing bulk action).
4. **Consultant:** sees only assigned participations on both tabs; reminds two of them; can't
   send to others (`participation_not_found`).
5. **Back office:** opens "Verlauf" of a participation: DSV events only (none before Slice 7);
   the PL sees status, profiling and DSV events with who did them.

## Acceptance criteria

**5-1**
- Domain tests first (100 % coverage): open items per step and document state; a field the viewer
  may not know about is never named; `ta_only` skips `ta_tg` rules; every deadline kind at 15, 14,
  0 and −1 days; the funnel counts; every filter; capability `assignEntryWave` matches the detail.
- Integration: the list's derived filters page by keyset across pages with stable order; an
  assigned consultant's list and dashboard count only their participations, an unassigned
  consultant and the org roles get `403`; no list or dashboard payload carries a sensitive value
  (a test reads every response for the synthetic sensitive values); a project of 2,000 synthetic
  participations answers both in under 1 s in CI (timings in the PR).
- Bulk wave: assigns and audits each; any refusal assigns none and names each refused index and
  code; already-assigned rows count `unchanged`; only the PL; `ta_only` refused.
- Component tests: the dashboard tiles and tables, the filter bar ↔ search params, the search
  loading the remaining pages and never touching the URL, the wave dialog with a refusal.
- e2e `dashboard.spec.ts` (no code submission; synthetic participations created through the staff
  API and the owner fixtures in `participants.ts`; the suite fails on any CSP violation;
  `expectAccessible`): the PL opens "Übersicht", follows a count to the filtered list, searches a
  synthetic name, assigns two rows to a wave.

**5-2**
- Domain tests: eligibility per skip code, the 3-day window across a DST change, the channel
  choice, the text catalog's SHA-256 and that no template has a placeholder but the portal link.
- Integration: a request queues one row and one `reminder_queued` per eligible participation and
  skips the others with their codes; a removed or suspended channel, an ended consent, a closed
  participation and a second request within 3 days are skipped in the function even when the API
  is bypassed; a consultant can't remind an unassigned participation; with `NODE_ENV=production`
  the route answers `503 delivery_unavailable` and writes nothing; the job sends once with the
  idempotency key, cancels on a channel removed after queuing, records `delivery_unknown` after
  the last retry; the runtime role can't write `participant_reminder`.
- Log capture: no address, text, name or provider error in logs, job payloads, errors or audit
  details.
- Component tests: the dialog's counts from capabilities, the result per code, the tab
  "Nachrichten".
- e2e `reminders.spec.ts` (no code submission: `activatedParticipant` and `loggedInAsOwner`; CSP
  check): the PL reminds an activated participant with open items and one without an account →
  one sent, one skipped `no_channel`; the development outbox holds one message with the generic
  text and none of the participant's data; a second reminder is skipped `reminded_recently`; the
  participant follows the link into the portal.

**5-3**
- Domain tests: every `AuditEventType` has a stream (exhaustive); every type's allowlist; the
  streams per role and assignment.
- Integration: the drift test (`audit_event_stream` = the domain table); `audit_history` per
  role: the PL sees case/profiling/DSV, the assigned consultant case/profiling and their own DSV
  actions, back office DSV/payroll, nobody `security` or `review` events (a `document_opened` and
  a `sensitive_read` never appear); an ended session, an unassigned consultant and a
  non-member are refused; the runtime role still can't select `audit_event`.
- Component test: the tab renders every event type's label, actor kinds and "Mehr laden".
- e2e `history.spec.ts` (no code submission; CSP check): after a wave assignment and a reminder
  the PL sees both in "Verlauf" with their actor; the participation's document opening isn't
  listed.

## Docs updated by the PRs

- 5-1: `process-and-lifecycle.md` (deadline warnings and open items as built, bulk wave
  assignment), `data-protection.md` (the work list and dashboard: what they show, scope,
  aggregates and Q150, the search never in a URL), ADR-0010 (routes, filters, codes),
  `architecture/overview.md` (the project page's tabs).
- 5-2: ADR-0002 (`participant_reminder`, functions, grants), ADR-0006 (reminder delivery as
  built), ADR-0011 (`reminders.send`), ADR-0010 (routes, codes), `data-protection.md` (reminders:
  consent and channel, text, retention table row), `regional-variation.md` (no regional reminder
  rules, Q152).
- 5-3: ADR-0002 (`audit_event_stream`, `audit_history`, grants), ADR-0010 (the history route),
  `data-protection.md` ("Audit metadata" as built), the generated access matrix (audit streams),
  `roadmap.md` (Slice 5 done); this plan moves to `plans/archive/`.
