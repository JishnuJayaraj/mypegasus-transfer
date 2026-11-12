# Data protection: corrections

**Evidence corrections** *(assumed, Q88, round 12)*: never by in-place editing, only through
**`request_evidence_correction`** and its approval **`decide_evidence_correction`**, targeting a
document, a record (an ASU registration, a BA reporting outcome), a field (`profilingDoneOn` and a
manual `withdrawnOn`, Slice 7) or a DSV signature date (its supersession, Slice 7). Who may request it is an
explicit correction-authority table (`packages/domain/src/access/corrections.ts`), separate from
who may open a document; requesting grants no read access.
- Documents: PL for TL 407, Kug 200b, ASU proof, exception evidence, CVs, uploads and
  certificates;
  PL or back office for the DSV and its cancellation.
- Fields (round 13), only those retained in the evidence set: PL for `firstName`, `lastName`,
  `birthDate`, `personnelNumber`, `profilingSessions` (one session per correction, never the
  whole collection), `withdrawnOn`, `profilingDoneOn`; back office for
  `pensionInsuranceNumber`, `baCustomerNumber`; either for `dsvSignedOn`, `tgStart`, `tgEnd`,
  `tgEntryDate`, `exitDate`. Payroll and personnel fields (address, tax ID, IBAN, absence
  periods) don't join the evidence set to be corrected; while retained, their own active or
  payroll operations correct them. Statuses change only through the status functions.
- Consultants and participants can't alter the evidence set; they raise a task or rectification
  request for the responsible role.
- Append-only, the original kept and linked (corrects/supersedes); a reason code and a
  documented source (BA/legal reference, data-subject rectification request, corrected source
  document or documented internal error); approval by the regional operations manager, four
  eyes; corrected sensitive values encrypted; audit events with IDs, field key, actor and
  timestamps, never the values; the approver sees category, basis and references, no value they
  couldn't otherwise read.
- **As built (Slice 6, PR 6-8; readings Q209, accepted with amendments in the review of PR #103)** for three targets; the
  date targets are below (Slice 7, PR 7-8):
  - **Targets and effects.** An accepted **document**: invalidated (`invalidated_by_correction`);
    the request states explicitly whether it is a **wrong person's file**, which on approval
    becomes a tombstone (`wrong_person`, the file name erased) whose object `documents.purge-object`
    purges; the row and the history stay. A current **ASU registration**: **superseded** with the
    corrected actual registration date where its proof supports it (a new current registration
    with the same route, recorded at the approval instant, `correction_id`; the PL's attestation
    carries over and is proven then, while a BA confirmation is linked again by the assigned
    consultant, confirming it supports the corrected date; the original keeps its row,
    `superseded_by`) or **invalidated** (`invalidated_by`; the PL then records a registration again,
    on the same or another route). On `kug_200b` the date is the batch's, so a registration there is
    only invalidated (`asu_route_kug200b`). A closed **BA reporting outcome**: superseded by a linked
    replacement task (`pending`, `replaces_task_id`), the original's outcome and history unchanged
    (`superseded_by`); a confirmation dialog still open for the original is refused
    (`already_recorded`), since it names the original (Q207 (6)). The replacement reports the same
    obligation: its sent date is not before the day the chain's first task was created, through
    repeated corrections too, while it keeps its own creation instant.
  - **The request:** the correction-authority table's roles (the PL; for the DSV and its
    cancellation also back office; nobody for a working copy), as themselves, in normal mode; a
    reason code (`ba_legal_reference`, `data_subject_rectification`, `corrected_source_document`,
    `documented_internal_error`) and the documented source (one line, at most 200 characters,
    normalised; the form says to enter no names or health details); nothing preset. One pending
    request per target. The request is authorised by its own grant, independent of a read right:
    the PL requests the correction of the exception evidence they can't open. A request changes
    nothing.
  - **The decision:** the regional operations manager of the project's region in "Freigaben",
    never the requester; under the project's exclusive lock; a rejection changes nothing; a
    request decided meanwhile is `409 source_changed`, never another request of the same target.
    The queue shows the project, the target's kind and category (the document type or the
    report's kind), the action, whether it is a wrong person's file, the reason, the source and
    the dates (requested, the target's recording day): no name, no file and no corrected value.
  - **Storage:** `evidence_correction`, append-only; internal / `case_internal`
    (`evidenceCorrection`, codes, dates and the source); its retention class per row, the
    target's. No corrected value of these targets is sensitive, so nothing is encrypted.
  - **History** (`case`, the PL and the assigned consultant): `evidence_correction_requested`
    (target kind, action, reason) and `evidence_correction_decided` (the same and the decision);
    never the source or a value.
  - **Withheld facts:** an invalidated document supplies no fact (every facts reader skips it),
    counts nothing in completeness and opens for nobody, a link opened before it included; it isn't
    quarantined again, and no quarantine is lifted while a correction of the document is pending.
    A superseded or invalidated registration supplies nothing; the facts and the ASU record read the
    current one. Past snapshots and the history stay. Nothing restores an invalidation.
  - **"Nachweis ungültig"** (`evidence_invalidated`, a case item on the work list; the domain's
    `evidenceInvalidatedSince`): from the approval of an invalidation of evidence (an ASU
    registration or a catalog type marked `signed`) until replacement evidence supports the fact the
    invalidated evidence supported, its linkage and its effective date: an invalidated registration,
    or a BA confirmation or batch scan that proved one, until the current registration gives
    `asuRegisteredWithProof` recorded after the approval and valid by the TG entry date (a
    registration without proof, or an accepted but unlinked proof, doesn't count); a TL 407 until
    a valid one accepted after the approval is signed by the retained `profilingDoneOn`; exception
    evidence while the open request rests on evidence that doesn't count; other evidence until a
    valid document of its type is accepted after the approval. The status that rested on it stays
    for the PL to resolve (new evidence, or the reconciliation rules); no date is invented.
- **Date corrections as built (Slice 7, PR 7-8; readings Q232)**, through the same request and
  decision, the same reason codes, documented source, four eyes, one pending request per target and
  `409 source_changed` for a request decided meanwhile:
  - **Field targets** (`correct_field { field, value }`): `profilingDoneOn` and `withdrawnOn` only;
    any other field is refused (by the request's schema and by the table's check), whatever the
    authority table lists: identity, `tgStart`/`tgEnd`, `tgEntryDate`, `profilingSessions` and
    `exitDate` wait for their own operations (proposed: with retention activation), and
    `dsvSignedOn` has no field target (its date is a signature's, superseded below). The PL requests.
    Rules (the domain's `fieldCorrectionProblem`; the function checks them again under the lock and
    once more at the approval, against the original the request recorded, `target_corrected` when
    the field changed meanwhile): the field holds a value (`field_not_recorded`: the profiling track
    `profiling_done`, the participation `withdrawn`); the corrected date differs
    (`correction_unchanged`) and isn't in the future (`corrected_on_in_future`); `profilingDoneOn`
    not before the earliest later signature date of a usable accepted TL 407 (Q191,
    `effective_date_before_signature`); `withdrawnOn` only for a manual withdrawal (a system
    withdrawal's date is derived, `withdrawal_by_system`) and, for a withdrawal of a signed DSV, not
    before a counting cancellation's validity (`effective_date_before_cancellation`). The approval
    writes `profiling_done_on` or `withdrawn_on`: the one write of these columns besides the status
    function, and no other column; no status, status version, past snapshot, audit event or entry
    made changes. The original stays in the correction row (`original_on`) beside the corrected date.
  - **The DSV signature-date supersession** (`supersede_dsv_signature { offerId, paper, signature,
    signedOn }`, `paper` the contract's scans `dsv_signed_scan` or the cancellation's
    `dsv_cancellation`): the PL or back office (who read the scans) request the date as the paper
    shows it. The accepted scans of that paper of the offer must show the signature with one date
    (`signature_not_shown`, `signature_date_mismatch`); the corrected date differs, isn't in the
    future and keeps the paper's order (`received_before_signature`: received not before the
    participant's signature). The approval appends, on **every** accepted scan of that paper showing
    the signature (quarantined ones too), a linked replacement `dsv_scan_signature` row with the
    corrected date, recorded at the approval (`correction_id`); the original row stays,
    `superseded_by`. So `dsvSignedOn` and the packet keep agreeing and `signature_date_mismatch`
    never arises from a correction. The signed offer's retained dates (`dsv_contract`) follow the
    corrected actual date. Class: the scans' (`personnel_file`).
  - **Facts recorded at the approval:** `tl407_facts` gives `profilingDone` valid on the corrected
    date and recorded at the latest of the supporting scan's availability, the status change and
    the approval; `dsv_facts` and `dsv_cancellation_facts` read the current signature rows, recorded
    at the latest of the acceptance (or lift) and the approval. A scheduled run before the approval
    never counts the corrected date; a later run or a reconciliation does.
  - **"Nachweis ungültig"** also from the approval of a corrected `profilingDoneOn` or contract
    signature date while it no longer supports an entry already recorded (the corrected completion,
    or the counting packet's validity, after the TG entry date; an entry on an approved exception
    isn't affected), until the current facts support it again. The PL resolves it through the
    reconciliation rules or the entry clarification; nothing is repaired.
  - **Queue and history:** "Freigaben" shows the field key or the paper and signature kind, the
    reason, the source and the dates (requested; the field's status change or the signature's
    recording), never the corrected or original date, the participant's id or name.
    `evidence_correction_requested` and `_decided` add `fieldKey`, or `paper` and `signatureKind`;
    never a value or a date. Logs carry ids and codes only.
- A correction alone never bypasses lifecycle guards or changes Transfer-KuG eligibility,
  contractual dates or payments: that takes a reconciliation, contractual amendment or recorded
  BA/legal determination.
