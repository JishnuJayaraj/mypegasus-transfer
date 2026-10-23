# Decisions — 2026-10-22, round 39 (Slice 5 planning, Q150–Q159)

The product owner reviewed [the Slice 5 plan](../plans/archive/slice-5.md) (PR #78). Like rounds 32–38,
these are pilot answers in the placeholder roles: no external DPO, legal or works-council
confirmation is involved yet, and none blocks development or testing on synthetic data.

Q150, Q153, Q154, Q156, Q157 and Q159 are **final implementation contracts**: the plan builds on
them as written and does not reopen them as product questions. With Q151, Q152 and Q155 they are
`accepted` in `open-questions.md`. The 🔒 rows keep the pre-pilot gate: DPO/DPIA confirmation for
all of them, and works-council review for Q157. Q158 is answered by the roadmap entry Slice 5b.

## Accepted without change

One work list rather than a second "missing" list; exact internal dashboard counts for users
entitled to list every counted participation; no suppression until an aggregate can leave the
operational application; informational 14-day warnings that never become lifecycle guards
(Q151); manual reminders only (Q152); the three-Berlin-calendar-day reminder frequency (Q155);
three sequential implementation PRs, each near or below 1,500 changed production lines (a soft
limit, not a target).

## Required plan amendments

1. **All applicable deadlines:** `deadlines[]` per participation, filters `deadlineKind` and
   `deadlineState`; the open DSV offer deadline, the effective TG start while `informed`, the
   applicable latest-entry cutoff, the Article 14 due date and the profiling-exception deadline
   with its 14-day upcoming warning. Dashboard counts and the linked list use the same projection;
   the most urgent deadline is shown (oldest overdue first, else earliest upcoming, a
   deterministic tie order); a latest entry date and a cutoff warning are never two warnings;
   tiles count distinct participations. ASU stays in Slice 6 pending Q1.
2. **Search:** a bounded snapshot or index that never sends the term, doesn't recompute the
   project per cursor page, shows loading until the whole authorized scope is searchable, never
   shows a final empty state from partial data, disables "select all matching" until loading is
   complete, and keeps the term out of URLs, persistent query keys, logs and browser storage; an
   end-to-end performance criterion for a search over 2,000 participations.
3. **Reminder dispatch:** the worker re-evaluates the participant's open items immediately before
   dispatch (`nothing_open` as a cancel reason); rows, `reminder_queued` and the pg-boss jobs
   commit atomically; the dispatch claim rechecks channel, consent, participation status and open
   items under current database state; the guarantee is "no dispatch if the invalidating change
   committed before the atomic dispatch check". A Monday reminder allows the next on the
   Thursday; the window counts from the last queued request whatever its outcome; the channel
   choice of Q154; channel and language fixed at request time, never rerouted; explicit
   behaviour for sent, definitive failure, retryable or uncertain errors, final
   `delivery_unknown` and an unavailable provider; "Nachrichten" readable by the PL, the assigned
   consultant and back office (`case_internal`); a hidden target is `participation_not_found`, a
   role that sees the participation but can't remind gets `403`.
4. **Audit redaction inside the database:** `audit_history` returns only the authorized
   projection (field, from/to, reason and details null or filtered in SQL); the API localizes and
   validates but is not the authorization boundary; the consultant's row predicate is
   `case/profiling OR (actor_staff_user_id = viewer AND stream IN (dsv, payroll))`; tests prove
   that unauthorized detail keys and reason codes can't be obtained by calling the function
   directly; the API cursor stays opaque.
5. **Appointments on the roadmap:** Slice 5b after Slice 5 and before Slice 6 (Q158).
6. **UX:** a rejected required document is one participant action per document type, never both
   "missing" and "rejected"; a refused all-or-nothing wave assignment says "Keine Zuweisung
   vorgenommen" before the refused rows.

## Q150 — Dashboard aggregates and n < 5

Exact counts are shown inside the operational application only to a viewer who may list every
contributing participation: PL and back office for their project, and an assigned consultant for
their currently assigned participations. Scope is recalculated on every request; an unassigned
consultant and organisation roles receive no dashboard. Responses are private/no-store and no
dashboard data enters telemetry. Suppression is unnecessary for these internal operational
counts. Every aggregate disclosed outside that scope, including customer reports, uses primary
suppression below 5 and secondary suppression preventing deduction from totals.

- Exact counts include values below five; every count drills down to the identically scoped work
  list. No small-cell rule applies merely because a count is small: the GDPR prescribes no
  universal threshold of five.
- An aggregate disclosed to a customer, or to a viewer who can't list every contributing person:
  primary suppression for n < 5, deterministic secondary suppression, no drill-down to
  individuals.
- Future aggregates of health, disability or other sensitive categories need a separate decision;
  Q150 doesn't authorise them.

## Q153 — Who may send reminders

A current project PL may remind any non-terminal participation in their active project. A current
assigned consultant may remind only their assigned non-terminal participations. No other role may
send; assisted mode and break-glass never grant this operation. Authority and assignment are
checked at request time and again before dispatch; loss of authority cancels the queued reminder.
Staff see only email/SMS and the outcome, never the destination.

- Not allowed: back office, unassigned consultants, the regional operations manager, regional
  admins and admins, participants, assisted-mode and break-glass sessions.
- Loss of membership or assignment cancels with `requester_no_longer_authorized`.
- A hidden or unassigned participation requested by a consultant returns
  `participation_not_found`; a role that can see the participation but can't send gets `403`.
- Reminder records and audit events are never used for staff productivity rankings or general
  performance monitoring.

## Q154 — Channel, consent and reminder content

- **Eligible channel:** registered by the participant, verified, not removed or suspended, linked
  to a live `portal_contact` consent. Never imported private contact data, the work email, postal
  data, a destination supplied by staff, or a different channel after queuing.
- **Several live channels:** the most recently verified email; otherwise the most recently
  verified mobile; the UUID as a deterministic tie-breaker. Channel id and kind, account language
  and message version are fixed when queued; an unavailable channel cancels, never reroutes.
- **Before dispatch:** the selected channel and its consent, a non-terminal participation, an
  authorised requester and an actionable portal item; otherwise cancel with the reason. No
  dispatch when the invalidating change committed before the atomic dispatch check.
- **Content:** no names, project, employer, Personalnummer, deadline, missing item or tracking
  parameters.
  - de: subject "Im Teilnehmerportal ist noch etwas offen"; text "In Ihrem Teilnehmerportal ist
    noch etwas offen. Bitte melden Sie sich an und prüfen Sie Ihre Angaben oder Unterlagen:
    <portal-url>"; email only: "Diese Nachricht enthält aus Datenschutzgründen keine weiteren
    Einzelheiten."
  - en: subject "Something is still open in the participant portal"; text "Something is still
    open in your participant portal. Please sign in and review your information or documents:
    <portal-url>"; email only: "For privacy reasons, this message contains no further details."
  - The ordinary portal URL: no login token, participant id, campaign parameter or tracking
    redirect; no tracking pixel or delivery analytics beyond the provider outcome.
- The portal contact consent must explicitly cover operational portal notifications, be revocable
  and exclude advertising. Removing the last channel warns that portal login will no longer be
  possible; assisted and offline service remains available.

### Final amendment after the second review: consent v2 only

Every reminder requires a live `portal-contact-consent:v2` for the selected channel; v1 is not
reminder-eligible. v1 could plausibly cover reminders, but relying on that reading brings no
benefit while no real participants exist; explicit v2 consent is clearer and safer.

1. **Eligibility:** the selected channel references a live consent with purpose `portal_contact`,
   version exactly `portal-contact-consent:v2` and `ended_at` null. A v1 channel stays valid for
   login codes but can't receive Slice 5 reminders. No migration silently converts v1 evidence
   into v2 consent.
2. **New channels:** once 5-2 is deployed, activations, recoveries and newly added channels record
   only v2.
3. **Existing v1 channels:** a voluntary, non-blocking upgrade in the participant's contact
   settings. Declining or dismissing it removes no channel, ends no session and doesn't prevent
   login. Staff can't accept v2 on a participant's behalf. The already verified destination isn't
   verified again.
4. **Atomic upgrade:** lock participation → channel → current consent; end v1 with the new
   `ConsentEndReason` `superseded`, never `revoked`; insert the participant-given v2 consent and
   point `participant_channel.consent_id` to it; write `consent_ended` and `consent_given` in the
   same transaction; return `already_current` idempotently when the channel already uses v2.
5. **Result codes:** `no_channel` (no live verified channel), `consent_required` (a live channel,
   none with a live v2 consent); staff-facing copy for either stays generic: "Kein für
   Erinnerungen nutzbarer Kontaktweg." Dispatch rechecks the exact queued channel and consent id
   and the v2 version.

## Q156 — Reminder classification and retention

Reminder metadata is internal `case_internal` data under `personnel_file`. It stores identifiers,
version, language, channel kind/id, requester, timestamps and outcome only — never an address,
rendered text, provider response, free text or tracking data. Non-signer reminders are deleted
with the 90-day operational-file deletion; other reminders expire at the end of the third calendar
year following exit. Audit events follow the three-year audit-log rule, with subject references
pseudonymized when the participant record is deleted.

- Allowed: reminder, batch, project and participation ids; kind and immutable message version;
  language; channel id and kind; requesting staff id; requested and outcome timestamps; status,
  outcome and closed cancellation reason; job and provider idempotency identifiers where needed.
- Never: destination address, rendered message or subject, provider response or body, free text,
  delivery error message, IP address or tracking data.
- Legal holds extend only the affected records. Channel-address erasure follows the channel rule;
  the reminder keeps only its value-free channel id. No reuse for marketing, employee performance
  measurement or participant profiling.

## Q157 — Staff audit history

- **Streams** for an active participation: PL `case`, `profiling`, `dsv`; assigned consultant
  `case`, `profiling` and only the rows in `dsv` or `payroll` where they are the actor; back
  office `dsv`, `payroll`; the union for several project roles. No history for participants,
  admins, regional admins or unassigned consultants; regional review stays a separate later view.
- **Never in "Verlauf":** logins, one-time-code or step-up events; sensitive reads and writes;
  document openings; break-glass and security events; exports; session or credential events;
  project-level events.
- **Database enforcement:** `audit_history` resolves the live staff session, reloads the current
  memberships and assignment, enforces the stream and own-action predicates, suppresses
  unauthorized field, from, to, reason code and detail keys, and returns only the final
  projection. The API may localize labels but never removes unauthorized data; `transfer_app`
  keeps no direct access to `audit_event`.
- **Actor names:** the current staff display name (attribution is needed for case
  accountability); if the name is no longer retained, "Ehemaliges Teammitglied", never a deleted
  name. Names aren't searchable or exportable from the history. Staff are informed that case
  actions are attributable; the data serves case reconstruction, correction, compliance and the
  investigation of a concrete incident, never rankings, productivity metrics or routine
  behavioural monitoring. Named technical action records can monitor employees, so deployment
  must check works-council co-determination under §87(1)(6) BetrVG (pre-pilot gate).
- **Reading the history** writes `audit_history_opened` (viewer, participation, timestamp only;
  a security/staff event never returned in the participant history).

## Q158 — Info events and appointments

A new roadmap slice, **Slice 5b**, after Slice 5 and before Slice 6: info events and consultation
slots; participant self-booking and cancellation; attendance; invitations and message logging;
attendance driving the authorised `informed` workflow; overdue appointments joining the same work
list. Only appointment polish stays in v1.1.

## Q159 — Participant-list export

Implementation in Slice 9; the contract is fixed now.

- No export in Slice 5. The generic participant-list export is PL-only; assigned consultants may
  not bulk-export lists; back office gets purpose-specific payroll and DSV exports in their
  slices, not the generic export.
- Generated server-side from current authorization and filters, never from browser rows;
  authorization checked at generation and again at download.
- Whitelist: Personalnummer, first and last name, lifecycle and track statuses, wave, assigned
  consultant names, non-sensitive open-item codes, operational deadlines. Never contact
  destinations, health or disability data, identifiers such as the RV-Nummer, document metadata,
  reminder destinations, audit details or free text.
- Person-level exports aren't subject to n < 5 (explicitly authorized person records); every
  aggregate in an export uses primary and secondary suppression.
- Files: encrypted at rest, opaque object names, downloadable by their creator only, expired and
  purged after 24 hours, never attached to an email. Generation and every download audited. CSV
  cells beginning with `=`, `+`, `-`, `@`, a tab or a carriage return are neutralised.
- Export metadata follows `audit_log`; the generated file `access_credential`.
