# Decisions — 2026-10-19, round 34 (review of PR 2h-2)

The product owner reviewed PR 2h-2 ([#54](https://github.com/JishnuJayaraj/mypegasus-transfer/pull/54))
and approved its scope with corrections. Placeholder pilot roles, as in rounds 32 and 33; no
external Legal, BA or DPO confirmation is involved. Everything here stays revisitable.

## The Personalnummer (pilot decision)

- The Personalnummer is **mandatory and unique within a project**. It is the exact,
  case-sensitive business key after trimming outer whitespace (Q103, round 32) and the **only
  automatic key** for matching a re-import.
- The application **never generates one**. A file without a mapped Personalnummer stays blocked at
  preview and confirm; a person created by hand needs the Personalnummer the PL enters.
- Name plus birth date only detects a possible duplicate; it never identifies a person
  automatically.

## The two contract additions of 2h-2

- `ProblemDetails.participationId` may name the existing participation once project visibility
  and the PL's permission are established; it never carries a person's value.
- `ImportResult.mappingSaved` is required and says whether at least one mapping row was actually
  written.

## Corrections (applied in #54)

1. The database's `audit_event_lifecycle_has_participation` covers
   `participation_created_manually`, so `record_audit_event` refuses it without a participation.
2. A parse slot is handed on only once its worker has stopped (a timed-out worker's memory counts
   until then).
3. The manual form marks the Personalnummer and the names as required, refuses an empty one
   without a request, and says the Personalnummer is the unique key and never generated.
4. Changing an entered value clears the warning and duplicate confirmations and the old answer.
5. `mappingSaved` is true only when a mapping row was written; the UI says "not saved" without
   naming one reason.
6. The 503 of the preview and the confirm documents `Retry-After`; route tests cover a waiting
   request, an expired wait and a full queue.

Not required for the pilot: cancelling a waiting import when the client disconnects (the queue
is bounded and times out).
