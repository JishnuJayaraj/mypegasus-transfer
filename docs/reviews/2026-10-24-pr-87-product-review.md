# PR #87 — Slice 6 product review and question answers

Reviewed 2026-10-24. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/87>.
Head: `e73b3129a5da5aace631a902d3c3ccebd1ee7115`.
Base: `9027f31e17bdead14fb142e27115f2f599dcb89d`.
This reviews the plan, not an implementation. Line references below name
`docs/plans/slice-6.md` at that head. The two review axes were examined independently.

## Product decision and development order

Approve the Slice 6 scope and the seven-PR split, subject to the specific contract amendments
below. Incorporate the amendments into the plan and relevant question rows; another broad
product-approval round is unnecessary for these exact edits. This does not constitute external
DPO, legal, works-council or Agentur confirmation. Existing pre-pilot gates remain.

- Keep **6-7 in Slice 6**. It completes the evidence/approval workflow used by profiling; its
  facts may exist before Slice 7 connects the remaining TG-entry facts. Keep DSV facts fail closed.
- **6-1** is unblocked by the verified official blank PDFs now available locally. Correct
  applicability and form-version handling before its contract is finalized.
- **6-2** can proceed independently with the health-consent decision below implemented.
- **6-6** can proceed independently.
- **6-3 to 6-5** retain the proposed dependency order, with evidence, snapshot and submission
  corrections below. Re-estimate 6-5 if the official Kug 200a adds enough scope to justify a
  separate coherent PR; do not omit required submission content to hit a line target.

## Standards review

1. **P1 — Health detail needs the existing consent gate (L132–142, L365; before 6-2).**
   `data-protection.md` at the PR head, L698, requires explicit consent for health/disability
   details beyond yes/no. Encryption and a “no diagnoses” hint do not satisfy that rule.
   Either implement evidenced explicit consent with the permitted purpose and access rules, or
   exclude narrative health detail until that gate exists. Do not infer this consent from the
   TL 407 signature or portal-contact consent. A participant who declines optional detail must
   still have a viable profiling path using information lawfully available.

2. **P1 — Signed declarations must bind to immutable contents (L111–113, L146–155, L363;
   before 6-3).** The BA contact declaration and Jobbörse choice can be edited between generation
   and scan acceptance. Dating the current mutable values at acceptance can certify something
   different from the signed paper. Preserve declaration values with the immutable generation;
   certify the actual signed values on acceptance. External paper requires explicit verification
   of its declarations. Later edits create a new declaration/version; they do not rewrite the old
   signed declaration. Test concurrent edits. Rule: data-protection.md L725–727 and ba-forms.md,
   “Declarations to the BA.”

3. **P1 — Sensitive readiness results need their own projection (L113–116, L333–335, L412,
   L544; before 6-3).** Missing-value codes are scoped, but assessment warnings and overflow can
   also reveal restricted information. Enumerate permitted readiness results per access category.
   The PL must receive no section-C-derived warning or overflow detail; unauthorized properties
   must be absent in the API response, not hidden in the UI. Audit sensitive reads used for
   calculation. Rules: data-protection.md access matrix/role knowledge and ADR-0010.

4. **P2 — Exports need a complete lifecycle (L225–228, L373, L415, L573; before 6-4/6-5).**
   Audit actual downloads as well as link issuance/generation; reauthorize every included document
   at download. Either stream bounded transient output or explicitly encrypt stored output and
   define expiry and orphan cleanup. A 60-second link does not imply deletion of its file.
   Include CSV cells beginning with tab/CR, as required by Q159, alongside `=`, `+`, `-`, `@`.
   Rules: data-protection.md L441–442; ADR-0006 encryption-before-storage; Q159 export contract.

5. **P2 — Unsuperseded working copies need an expiry path (L98–99; decide before 6-3).**
   A sole unsigned form can otherwise retain health content indefinitely. Add an abandonment
   timeout and a participation-closure fallback, subject to legal hold. Preserve minimal immutable
   provenance and scan links after the working blob is removed. The proposed 30-day period is an
   implementation policy awaiting DPO confirmation; executable periods stay unset until retention
   is implemented. Rule: ADR-0008, per-item retention.

No useful code-smell finding applies to this docs-only change.

## Specification review

1. **P1 — Valid paper forms must not require app generation (L146–164, L548–551; Q184).**
   PRD F6 requires paper signatures and scan upload, not compulsory in-app generation. Support an
   external-paper origin with verified form code/version, actual signature dates and reviewed
   declarations, without a generation link. Do not ask people to regenerate and re-sign solely
   to satisfy application bookkeeping. For an app-generated form, keep its generation linkage.

2. **P1 — Wrong acceptance needs a recovery path (L151–180, L303–305; Q183/Q186).**
   An accepted wrong-person scan or incorrect registration must not remain authoritative until
   an unspecified later feature. Provide approved append-only invalidation/supersession with
   history and guard-fact handling. Immediately quarantine a suspected wrong-person document
   from ordinary access while it is investigated. This does not permit editing signed contents
   or silently reversing lifecycle status. Rules: data-protection.md L513–537, evidence corrections.
   An Agentur rejection must reopen submission work without automatically invalidating genuine
   profiling signatures; submission is not the TG-entry guard.

3. **P1 — Record the complete ASU fact at its actual recording instant (L172–180; Q186).**
   A proof accepted yesterday, associated with a registration today, cannot make the combined fact
   look recorded yesterday. `validOn` is the verified actual registration date; `recordedAt` is
   when the complete registration-with-proof fact was recorded, including any later proof or
   correction. Check the proof's participation and support for that date. This preserves the
   TG-entry snapshot rule and prevents retroactive scheduled eligibility.

4. **P1 — Exception evidence must retain both settled source alternatives (L262–270,
   L584–586; Q194).** Round 16 Q94 accepts an immutable evidence record representing one or more
   accepted document versions **or** structured BA confirmation. Round 17 defines canonical
   fingerprints for both. A mandatory single document/FK and file-only digest narrow that contract.
   Model the evidence record, specify how documents are verified/accepted, and retain normalized
   BA confirmation facts. Preserve four-eyes approval, unchanged-evidence rejection and restricted
   evidence visibility. A file's mere presence is not evidence verification.

5. **P2 — Separate immediate exception escalation from submission follow-up (L243–250;
   Q189).** Profiling refusal after entry or a missed one-month profiling deadline requires
   immediate compliance escalation (process-and-lifecycle.md, profiling track). Moving a
   submission baseline must not add another 14-day grace period to that obligation.

## Additional primary-source findings

### ASU formula — Q1, Q177, Q178

The existing unconditional `max(end − 3 months, knowledge + 3 days)` is not a faithful statement
of the two alternatives in [§38(1) SGB III](https://www.gesetze-im-internet.de/sgb_3/__38.html).
The statute distinguishes the normal three-month rule from learning of the end less than three
months before it. For example, under the repository's current calendar arithmetic, an end of
30 June 2027 and knowledge on 29 March 2027 produces 1 April from `max`, despite knowledge
preceding the ordinary 30 March threshold.

Use explicit statutory branches rather than the unconditional maximum. Keep precise calendar,
boundary, weekend/holiday and unusual-case treatment under Q1 verification; finding this defect
does not externally confirm the entire deadline implementation. An unknown knowledge date is
an unknown legal due date. The three-month reference may be shown as a clearly labelled
orientation and “Kenntnisdatum klären,” not as a definitive overdue finding. No automatic reminder.

### Official batch cover list — Q187

The current [BA guidance, effective 4 May 2026](https://www.arbeitsagentur.de/datei/dok_ba036500.pdf),
section 2.13(12), names both Kug 200a and Kug 200b. The official
[Kug 200a 07/2025](https://www.arbeitsagentur.de/datei/formular-transfergesellschaften_ba029375.pdf)
contains more than the plan's minimal list, including identifying, employment and TG-period
fields. Therefore the proposed name/birth-date/version list is not a verified substitute.

Implement the official submission form where required, or obtain and record confirmation that
the relevant Agentur accepts the alternative. Keep an operational index separate from the
official submission artifact. Sensitive values required for that purpose need an explicit export
policy, logged access, encryption and current authorization; generic list-export restrictions
must not be bypassed silently. This is a bounded addition to 6-5, not a generic export feature.

### Meaning of Kug 200b declaration 17 — Q185

The [official Kug 200b](https://www.arbeitsagentur.de/datei/erklaerung-arbeitsuchendmeldung-kenntnisnahme-transfergesellschaft_ba147320.pdf)
labels declaration 17 as acknowledgement of selective access. That wording alone does not
establish freely given GDPR consent or the legal effects of a purported revocation. Preserve
the exact signed declaration as evidence, keep the existing purpose identifier if needed for
compatibility, and retain legal-basis/revocation semantics as a DPO confirmation gate. Do not
claim that recording a revocation in this platform disables BA-system access; record the
necessary BA notification/follow-up separately. Neither a declined offer nor a withdrawal of
optional permission erases an otherwise valid ASU registration.

## Answers to Q176–Q194

### Q176 — Blank PDFs: resolved

Downloaded unchanged from the official BA URLs on 2026-10-24 and added locally:

- `packages/forms/templates/ba/tl407/08-2025/blank.pdf`: seven pages, 160 AcroForm fields,
  SHA-256 `d17a8087b5fba1803a491c66987b00b7cd73b25ba91f540f18f1482022b50968`.
- `packages/forms/templates/ba/kug200b/09-2021/blank.pdf`: one page, 20 AcroForm fields,
  SHA-256 `0134cc889e39eaced1a2be3c307244605c66bbb54a0e30fc42f08e2c4e833c00`.

Each has a `source.json` with URL, retrieval date and checksum. Both were parsed with pypdf:
no nonempty field values, no XFA. These source files are provenance, not completed registry
manifests; do not invent effective dates from the printed version month. Files are uncommitted.

### Q177 — Knowledge date: accept the individual fact; amend missing-data behavior

Optional import plus audited PL correction is appropriate. Do not silently inherit a project or
wave date: people can learn of their individual employment end on different dates. A later
explicit, confirmed bulk entry can write the individual records if there is a real shared date;
it need not be built in this slice. Missing knowledge is “date to clarify,” as described above.

### Q178 — Due date: accept warnings/no reminders, with the formula correction

Use verified statutory branches and distinguish confirmed information from an estimate. Do not
present the missing-knowledge reference as a definitive legal due date or call someone late on
that basis. No automatic reminder until Q1 is confirmed. This slice's TG workflow scope does
not mean TA-only participants have no independent registration obligation.

### Q179 — Generated documents: accept with a complete expiry contract

Accept encrypted immutable working copies, assigned-profiler TL 407 generation, PL/assigned
consultant Kug 200b generation, and purpose-bound logged opening. Preserve source revision,
declaration snapshot, form version and generation provenance. Use the proposed 30-day cleanup
after supersession/signature acceptance, and add a bounded abandonment/closure fallback rather
than keeping the sole unsigned generation indefinitely. Periods remain a DPO gate.

### Q180 — Pre-fill: accept, with applicability and identifier safeguards

Never pre-tick paper declarations or signatures. Keep optional Kug 200b contact data blank;
TL 407 contact pre-fill follows its separate BA declaration, not portal-contact consent.
Generation may leave Kug 200b fields for handwriting; acceptance must verify mandatory
information on the actual completed paper. Do not overflow, truncate or abbreviate identifiers
such as the RV-Nummer. “Required” means applicable required fields: signatures are for paper,
Agentur-only fields are excluded, and TA-only beE dates are inapplicable.

### Q181 — Träger and TA-only beE dates: accept an explicit applicability rule

Use the actual delivering legal entity, not the old employer. Organization configuration is
adequate if that entity really is the provider for all projects. In `ta_only`, there is no beE:
leave fields 9/10 blank and skip their beE-required validation. Never substitute measure dates,
old-employment dates or fictional TG dates. In `ta_tg`, use the actual effective contractual
TG dates. The form's label supports the distinction, but it does not document the Agentur's
TA-only blank-field handling: retain that acceptance check before live §110 submission.

### Q182 — Anlage: accept with complete traceability

Continue text without losing content; repeat the relevant source field/table heading and
participant identification. If a final table row is replaced by the continuation marker, move
that displaced data row to the Anlage too. Preview and sign the complete combined packet, and
review that packet on upload. Apply the parent document's strictest classification throughout.
Agentur acceptance of the layout remains the named operational confirmation.

### Q183 — Wrong-person scans: amend the post-acceptance case

Accept PL deletion/purge before review with a tombstone and controlled reason. After acceptance,
do not allow ordinary destructive editing, but provide immediate quarantine and approved
append-only correction/supersession. An accidental acceptance cannot make someone else's data
permanently visible or permanently usable as evidence.

### Q184 — Document operations: accept roles; add external paper

Accept PL/assigned-consultant operations for signed TL 407/Kug 200b, no back-office file access,
and the scoped ASU-proof/identifier permissions. Add externally completed signed forms with
verified version and signature dates. A PL's write-only identifier attestation grants no later
read. Verify actual ASU registration and its date; a BA customer number by itself is not a
statement of when the person registered.

### Q185 — Paper declaration: accept evidence capture, retain legal verification

Check declarations 16/17 and the handwritten signature on the real scan; no silent preselection.
Bind the recorded facts to the signed source, its version and dates. Apply the qualification in
the primary-source finding above: do not mark the consent characterization externally confirmed.
Recording a received withdrawal must not erase ASU history or block legally required processing.

### Q186 — ASU record: accept routes and separate confirmation; amend finality

Keep route, actual registration date, proof, recording instant and optional BA confirmation
separate. The combined fact's recording instant is when the complete supported registration
becomes recorded, not an earlier unassociated proof upload/acceptance. Add controlled append-only
correction and invalidation. Do not force a new route or duplicate registration merely to fix an
entry error. Missing BA confirmation remains follow-up work; it does not automatically negate
the recorded registration.

### Q187 — Batches: accept grouping, amend submission content and rechecks

PL-only batches per placement Agentur and immutable prepared membership are appropriate. Address
the official Kug 200a requirement above. Recheck authority, applicable evidence, routing and
member state before export/submission. A terminal member remains in historical batch records,
but must not silently receive a new active registration solely because an old draft batch was
submitted. Provide discard/rebuild for a draft that no longer qualifies. Historical recording
of what was actually sent must preserve the actual date and recording instant.

### Q188 — Form versions: accept configurable submission enforcement

Use the reviewed registry's effective dates, never guess validity from the filename. Preserve
signed historical versions. Enforce the Agentur's resolved rejection rule at actual submission;
an expired registry version is not automatically a claim that every Agentur rejects it.

### Q189 — Submission and exceptions: amend escalation and rejection handling

Record rejections and retain all attempts. Rejection reopens actionable submission work until
the issue is resolved; it must not vanish because a historical submission row exists. It does
not automatically invalidate signatures or completed profiling. Submit promptly after profiling
catch-up; missing the one-month profiling deadline/refusal requires immediate compliance
escalation, without another 14-day grace period.

### Q190 — BA reporting outcomes: accept with auditable correction

Accept PL/back-office recording, controlled reasons and real reporting dates; invent no due date.
Do not make an accidental `not_required` irreversible: an approved correction can supersede it
or create a linked replacement task, retaining the original history. Claims/closure remain
outside this slice. Do not represent a domain helper as enforcement of workflows that do not
yet exist.

### Q191 — Profiling completion date: accept

Use the later actual signature date as the default minimum completion date, allow a later
nonfuture completion date, and preserve the independent recording instant. External paper can
predate use of the platform. Late evidence changes no past scheduled-entry snapshot; any later
eligibility action follows the existing reconciliation rules.

### Q192 — Sensitive storage: accept separation; implement the health gate

Accept field encryption, logged reads/writes, profiler-only assessment access and separate
retention classes. Narrative health detail requires the existing explicit-consent contract or
must be excluded until it is available. Do not treat a hint against diagnoses as enforcement.
Keep unemployment-period access under its explicit category; no accidental PL readiness leak.
The signed document follows its own evidence policy, not the operational health-row expiry.

### Q193 — Sessions and BA declarations: accept with immutable signed snapshots

Accept the session validation, assignment permissions, revision checks and evidence classification.
Pending declaration values may be edited; accepted signed declarations preserve what was
actually signed. Later profile edits do not rewrite them. Keep sessions distinct from booked
appointments: a planned consultation is not automatically completed profiling evidence.

### Q194 — Exceptions: keep in Slice 6; restore settled evidence alternatives

Use accepted immutable document versions or structured BA confirmation through an evidence record.
Define verification/acceptance of the document source before it supplies a fact. Preserve the
canonical, participant-bound fingerprint format for each source and the four-eyes decision.
Keep raw evidence restricted; the regional operations manager sees only the authorized approval
metadata. Conservative special-category handling for unstructured uploads is acceptable; it does
not require every structured BA confirmation to become a clinical file. Do not revoke a valid
exception silently after entry; retain the existing completion/compliance workflow.

## Required implementation scenarios

- External paper signed before platform generation can be recorded without re-signing.
- Changing a BA declaration after printing does not change the eventual signed-source record.
- A wrong-person scan accepted by mistake can be quarantined and corrected without wiping history.
- An old proof linked today cannot create a fact recorded before today's link/registration.
- Missing knowledge date is not displayed as a verified overdue finding; the statutory-branch
  boundary exposes the current unconditional-max defect.
- A required Kug 200a packet is generated/verified, or an explicitly accepted alternative is used.
- An abandoned unsigned health-bearing PDF has a cleanup path; retained scan provenance survives.
- Restricted warnings/overflow cannot be obtained by the PL through readiness APIs.
- A missed profiling-exception deadline escalates immediately; rejected submission work reopens.
- Normalized structured BA confirmation and accepted documentary evidence both support an
  exception; identical reuploads do not count as changed evidence.

Standards: five findings, most serious the health-detail consent gate. Specification: five
findings, most serious the unrecoverable wrong-evidence contract. Primary-source amendments to
the ASU formula, official batch list and paper-acknowledgement interpretation are listed separately.
