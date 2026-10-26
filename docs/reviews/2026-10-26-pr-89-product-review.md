# PR #89 — Slice 6, PR 6-2 review and the Q198 decisions

Reviewed 2026-10-26. PR: <https://github.com/JishnuJayaraj/mypegasus-transfer/pull/89>.
Head: `6fbef3a`. This records the product owner's findings and decisions as given; the fixes are
in the same PR. This does not constitute external DPO, legal, works-council or Agentur
confirmation.

## Findings

1. **F1 — P2: session values and their revision need one read snapshot.** The tab's view read the
   sessions and the shared record's revision through independent concurrent queries; a concurrent
   commit could pair old sessions with a new revision, and a later whole-list write could erase
   that commit without `409`. Read the values and the concurrency token in one snapshot (one
   statement or a suitably isolated transaction; independent READ COMMITTED statements in one
   transaction are not one snapshot). Add a controlled concurrent-read/write case.
2. **F2 — P2: assessment save responses could adopt another writer's revision.** The save
   discarded the revision the write function returned and reloaded metadata separately; the editor
   attached that possibly newer revision to its old values, so a stale write could overwrite
   another tab's edit with `200`. Keep the successful write's own revision with the values it
   saved; never advance a dirty editor's token from arbitrary later metadata. Verify: A saves, B
   saves before A's response metadata is loaded, A's next stale write gets `409`.
3. **F3 — P2: an unrelated save silently discarded drafts.** Both editors were keyed by the shared
   revision, so saving one section remounted the other and dropped its unsaved choices. Preserve
   dirty drafts across unrelated saves and background refreshes, refresh clean sections, and handle
   conflicting server changes explicitly without silently replacing the local draft. Keeping the
   shared server revision is acceptable; removing conflict checks is not the fix.
4. **F4 — P2: page 7 rejected paragraph breaks.** Gesamteinschätzung and weiteres Vorgehen used
   the single-line validator (domain and database), so a newline was `422 control_characters`.
   Give these narrative fields an explicit multiline contract in both layers: normalise CRLF,
   keep ordinary line breaks, refuse other control characters, leave single-line fields as they
   are, and verify the paragraph round-trip through API, storage and form generation.

## Q198 decisions

- **School designation:** accept the participant's marking and the profiler's review in assisted
  mode without a separate confirmation workflow. Before 6-3 generation, distinguish an explicit,
  reviewed "no school qualification" answer (valid) from "not yet designated / clarified"
  (incomplete). Never fabricate an education row or infer the answer from names, recency or an
  unchecked checkbox. Tie generation review to the current source values, so a later participant
  edit doesn't inherit an earlier review.
- **Revisions:** accept a shared revision for sessions and declarations (with F1–F3 corrected) and
  a separate assessment revision. **The unemployment period needs a revision** before merge: one
  profiler can open two tabs and the schema permits several assigned consultants. Return a token
  with the logged read and require it for updates and for clearing, with an atomic stale check;
  the storage arrangement is an implementation choice.
- **Granularity and bounds:** accept one ciphertext and one audited field per section C line,
  page 7's two texts and the health rating separately, 16 fields in all; reading the whole
  assessment may audit all 16. Accept 50 sessions and 100-character labels as storage bounds, not
  BA rules.
- **Closed participations:** accept refusing ordinary profiling writes; present the editor as
  read-only or explain the closure instead of offering writes that must fail. Later evidence
  corrections are the approved controlled workflow, not ordinary editing here.
- **The unemployment period:** accept staff capture without a portal display in this slice; the
  data-subject export and correction route remains applicable (a UI scope decision, not a
  permanent denial of access rights; Q85's classification review stays open). Accept logged
  back-office reads without a tab. Accept storing a reversed range as a warning rather than a hard
  BA rule; show the warning when saving as well as at form readiness.
- **Visibility:** accept no back-office tab and profiler-only pending declarations and presence;
  the permission to read confidential data doesn't require showing it on every screen. Keep
  profiling completion deferred to 6-3 and its signed-TL-407 guard.
