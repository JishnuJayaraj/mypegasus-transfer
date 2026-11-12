# Process & lifecycle: ASU and Kug 200b

### Arbeitsuchendmeldung (ASU)

Legally the registration counts, not the form: §38 SGB III allows registration online, in
person or by phone. Kug 200b is the usual channel in transfer projects, not the only valid one
(Q55).

- The ASU record stores `channel` (`kug_200b`, `online_self`, `in_person`), `registeredOn`, and
  **proof**: the submitted Kug 200b, a BA confirmation, or the BA-Kundennummer noted by the PL.
- **Registered** = a registration with proof, **regardless of channel**. This is what the TG
  entry guard checks.
- For `kug_200b`: `registeredOn` is the submission date to the Agentur, with the submission
  channel. Agentur confirmation (`confirmedOn`) is optional. No confirmation 14 days after
  submission → warning for the PL to follow up.
- If someone registered themselves, **still offer Kug 200b**, because it carries the consent
  that gives the TG access to the BA profile. This is a "what's missing" item, not a guard.
  Without it, the profile-access consent record simply stays empty.
- The **Kug 200b offer and its outcome are recorded separately** from the ASU proof (round 14):
  the participant may decline it, and a declined offer is an outcome, never a "missing signed
  scan". The RV-Nummer and the accepted signed scan are required only when ASU uses
  `kug_200b`; after `online_self` or `in_person` the ASU proof is enough for entry.
- An accepted ASU proof stands for the proof of **any valid channel**, including a structured PL
  attestation of the BA-Kundennummer; it never requires an uploaded file. A Kug 200b scan is
  accepted only when the review checked both declarations (fields 16 and 17) and the
  handwritten signature.
- The ASU completeness rules apply in `ta_tg` projects only (Q89); `ta_only` participants
  register themselves.
- `asuDueDate` (see Dates) gives the deadline `asu_due`; no automatic reminder until Q1 is
  confirmed (Q152).
- **As built (Slice 6, PR 6-4a; Q186, Q201):** the PL or the assigned consultant sets the
  route with its version (`set_asu_route`, `asu_route_set`), the placement Agentur's
  `defaultChannel` preselected, never a blocker; it is fixed while a current registration exists
  (an entry error is corrected through an approved correction, below). On `online_self` /
  `in_person` the PL or the assigned consultant records the actual date (`record_asu_registration`,
  not after today) with the route version they reviewed (a route changed since is
  `409 stale_revision`, never frozen unseen); its proof is either the PL's **attestation** given with it (the BA-Kundennummer,
  write-only and encrypted, with where it was verified: `ba_document_inspected`,
  `ba_online_account_inspected`, `ba_confirmed_by_phone`) or an accepted BA confirmation
  (`asu_proof`) the assigned consultant links afterwards (`link_asu_proof`, `asu_proof_linked`). A
  registration without its proof gives no fact. On `kug_200b` the batch's submission records the
  registration (Kug 200b batches below). One **current** registration per participation
  (`asu_registered`).
- **Corrections** (data-protection.md, evidence corrections; Slice 6, PR 6-8; Q186, Q209): an
  entry error is never fixed by a new route or a duplicate registration. On the PL's request and the
  regional operations manager's approval a registration is **superseded** with the corrected
  actual date where its proof supports it (a new current registration on the same route, recorded
  at the approval instant; the PL's attestation carries over, so the fact `asuRegisteredWithProof`
  is `validOn` the corrected date and `recordedAt` the approval; a BA confirmation is linked again
  by the assigned consultant, confirming it supports the corrected date, and the fact is recorded
  at that link) or **invalidated** (no current registration: the due date applies again
  and the PL records a new one, the route changeable again). The original stays, linked, in the
  history. On `kug_200b` the date is the batch's, so the registration is only invalidated. A status
  that rested on the registration stays; the work list shows `evidence_invalidated` until a new
  current registration gives the fact again (a registration with its linked proof, valid by the TG
  entry date).
- **Completeness** (regional-variation.md, the base rules): the engine's state for `asu_proof`
  comes from the record: accepted once a registration with proof exists, on any route, without a
  file; else the live BA confirmations', an accepted but unlinked one still awaiting its link. The
  Kug 200b rules apply on the route `kug_200b` only (`asuChannel`, the rule `when`).

#### The Kug 200b offer *(accepted, Q179, Q184, Q185; as built in Slice 6, PR 6-4b; readings Q202)*

`ta_tg` only (Q89). The offer is separate from the ASU proof; neither its outcome nor a withdrawal
touches a registration.

- **Offered** once a Kug 200b was generated (the PL or the assigned consultant on the tab
  "Arbeitsuche", the PL also for 1–100 participations from the work list, all or nothing) or a
  signed external paper was received. Generation prints fields 1–12; 13–19, the declarations 16
  and 17 and the signature are the participant's hand. Before printing, a **handwriting and
  clarification checklist** names every blank `*` field (`required_blank`) and every text too
  long for its box (`text_not_fitting`), stored with the generation (ba-forms.md, Kug 200b as
  built).
- **Outcome `signed`:** an accepted, usable signed scan (generated or external paper). The review
  needs the date written in field 19 (not after today; for a generated scan not before its
  generation) and three confirmations made on the actual paper: **16 and 17 ticked, the mandatory
  information completed, signed**; nothing is preselected. It records the signed declarations 16
  and 17 and declaration 17 as written as one consent record (purpose `kug200b_profile_access`,
  source `paper_form`, given on the field-19 date, the scan; data-protection.md, signed
  declarations). One record is in force, by the dates and never the order of acceptance: an
  accepted paper is in force only if signed after every withdrawal received and not before a
  record in force whose paper is usable, and then supersedes the earlier (`consent_ended`,
  `superseded`); an older paper is kept as history, its record ended `superseded` at once, so a
  renewed declaration needs a later paper. A quarantined, deleted or invalidated paper's record
  isn't shown as in force; its withdrawals and their BA notice stay.
- **Outcome `declined`:** recorded with its date by the PL or the assigned consultant, once, while
  nothing is signed and the route isn't `kug_200b` (`asu_route_kug200b`: the route changes first,
  so a declined offer is never a missing scan). A later signed paper still makes the outcome
  `signed`.
- **A withdrawal** of declaration 17 that reaches the TG in writing is recorded by the same roles
  with the date received (not after today, not before the date on the paper), also after the
  participation's end: the record ends `revoked` (`consent_ended`), and the item
  `kug200b_withdrawal_ba_notice` stays open until "BA informiert am" is recorded (not before the
  receipt). The platform records that the BA was told, never that its access was disabled; what a
  withdrawal effects stays with the DPO/legal check (Q185 `verify`).
- **Work-list items** (`caseItems`, beside the deadlines): `kug200b_offer_open` with the offer's
  date while an open participation's offer has no outcome and its route isn't `kug_200b` (there the
  step's rule `base-kug200b-signed-scan` names the missing scan); never a guard.
  `kug200b_withdrawal_ba_notice` with the earliest unnotified withdrawal's date of receipt, also
  after the end. Filters and counts follow with 6-5b.

#### Kug 200b batches *(accepted, Q45, Q91, Q187, Q203; as built in Slice 6, PRs 6-5a-1 and 6-5a-2; readings Q205)*

`ta_tg` only. The PL alone builds and sends them (the project tab "Agentur"); back office never
opens a signed Kug 200b (Q49).

- **Per placement Agentur:** its resolved `batchSubmissionChannel` (unset: "Einstellungen fehlen",
  the `asu_registration` step blocker refuses a batch, `batch_settings_missing`, Q91) and the
  **artifact**: the official Kug 200a, or the alternative list when the Agentur's acceptance is
  recorded as an Agentur-scoped setting (regional-variation.md, the accepted alternative). The
  batch records both when it is built. The **operational index** (last name, first name, form
  version; "Arbeitsliste (CSV)") is the PL's work list, never the artifact.
- **Ready scans:** per open participation placed with the Agentur its newest accepted, live,
  unquarantined, uninvalidated Kug 200b scan, while the participation is in no open batch, its
  Kug 200b was never submitted, it has no registration on the route `kug_200b`, and its version
  isn't one the Agentur rejects as outdated (only where its resolved `rejectsOutdatedFormVersions`
  is `true`, D26). The participation needs an **explicitly chosen ASU route** (Q203): without one
  its scan is listed as waiting for the route, linked to "Arbeitsuche", never batched
  (`asu_route_unset`). On `kug_200b` the submission is the registration; on another route the
  member gets its submission only, and the route can then never become `kug_200b`
  (`asu_kug200b_submitted`): the person registers on the route they are on. Scans without a
  placement Agentur are counted, not batched; a closed participation's scan is neither.
- **Building** ("Sammelmeldung bilden", `create_kug200b_batch`): 1–200 ready scans, one per
  participation, all or nothing under the project's exclusive lock; any scan that can't join
  refuses the batch with its rows (`batch_stale`), so two batches racing for one scan give one.
  Each member keeps its route and placement Agentur as read then; the membership is fixed.
- **Recheck** before an export and before "Übermittelt am": the channel and the artifact still
  resolve as when built (`settings_changed`), and every member's scan still usable, the
  participation open, placed with the batch's Agentur and on its route, no registration on
  `kug_200b` and no outdated version. Any row refuses (`batch_stale` with the rows); the PL
  discards ("Verwerfen", the members free again) and rebuilds. A member that has become terminal
  therefore never receives a registration; once submitted, a later terminal member stays in the
  historical batch.
- **"Übermittelt am"** (`submit_kug200b_batch`): the actual sent date, not after today and not
  before the batch's day, and the recording instant. Each member gets an `agentur_submission`
  (form, version, Agentur, channel, batch, date; the proof of submission) and, on `kug_200b`, its
  ASU registration: `registeredOn` the sent date, the proof `kug200b_submission`, the complete
  fact recorded at the submission's commit, so it counts for a scheduled entry only from then.
  The submitted scan is the fact's supporting evidence: while it is quarantined, invalidated or
  deleted the registration stays as history but supplies no `asuRegisteredWithProof`; after a
  lifted quarantine the fact counts from the lift. No lifecycle status reverses on its own.
- **The official artifact** (PR 6-5a-2; ba-forms.md, the Kug 200a as built): an open, current
  batch offers "Kug 200a (PDF)" (or "Sammelliste (PDF)", the accepted alternative with the same
  contents) and, on the channels `scan_email` and `upload`, "Scans (PDF)": the members' accepted
  scans in one PDF in the list's order (a PDF as it is, an image as an A4 page). On a paper
  channel the Kug 200a goes with the originals, so no scans PDF (`export_not_applicable`). The tab
  shows the handwriting checklist beside the download, before printing: the header keys not set,
  the members' missing values (address, RV-Nummer, TG dates), what the data doesn't decide (the
  last activity at the employer and its period, the info event's date over several dates; Q205)
  and what doesn't fit at 6 pt, by member. Both downloads are exports (data-protection.md,
  exports): the PL alone, rechecked **in full at the download**, settings included, and compared
  by what they print (`409 source_changed`); nothing stored.
- **No duplicate initial submission:** a participation whose Kug 200b was submitted doesn't join
  another batch. Retransmitting a rejected, returned or unreceived packet is open (Q204, before
  the pilot).
- **"Bestätigung der Agentur am"** (`record_asu_confirmation`, tab "Arbeitsuche"): the PL records
  the Agentur's confirmation of a batch's registration once, from the submission to today, also
  after the end; follow-up work, never a condition. The item `kug200b_confirmation_missing` (none
  `kug200bConfirmationFollowUpDays` after the submission) comes with the work-list items of 6-5b.
