# Decisions — 2026-10-16, round 12 (Slice 1, PR 1d-2 review)

The product owner's answers to the eight readings taken in PR 1d-2, to the ten readings left from
the round 11 follow-up (PR #14), and to Q88. Q88 is **assumed** until the DPO and the PLs confirm
it (pre-pilot gate). Where it differs from earlier rounds, round 12 wins.

## The eight readings of PR 1d-2

1. **Self-registration — confirmed.** An authenticated participant takes no lifecycle
   transition. The `self_registered` creation edge belongs to Slice 4c's anonymous,
   project-QR-controlled registration flow and must not be callable through the ordinary
   transition service. Its kind is named **`anonymous_self_registration`**.
2. **Consultant/profiler transitions — confirmed.** For assigned participations: contact,
   unreachable, informed, the profiling transitions and the TG exit. No creation,
   self-registration matching, manual withdrawal or TA completion.
3. **Back-office DSV transitions — confirmed.** Offer and re-offer, signed, declined. Expiry stays
   system-only.
4. **Organisation roles — confirmed.** Regional operations managers and admins take no ordinary
   lifecycle transition; their authority is their explicit review and approval operations and
   regional scope.
5. **Four eyes — confirmed.** Exception decisions, reconciliation review, break-glass review and
   evidence-correction approval are performed by someone other than the requester or actor.
   Holding both the PL and the regional operations manager role doesn't remove this.
6. **Clarification requests — confirmed.** No four-eyes check: not an approval or review.
7. **Evidence-correction requester — corrected.** Correction authority is **not derived from who
   may open a document**: access to content and responsibility for initiating a correction are
   separate permissions.

   | Document type | May request a correction |
   |---|---|
   | TL 407 signed scan | PL |
   | Kug 200b signed scan | PL |
   | DSV signed scan / cancellation | PL or back office |
   | ASU proof | PL |
   | Profiling-exception evidence | PL |
   | Participant upload / qualification certificate | PL |

   Requesting a correction doesn't grant the PL access to the file. Sensitive replacement
   evidence is still supplied or handled through an authorised consultant or assisted workflow.
8. **Superseding stale exceptions — confirmed.** System-only, applied atomically by the status or
   domain operation.

## The ten readings left from PR #14

1. Every field resource carries its field key, reads included: **confirmed**.
2. Document categories and classes: **confirmed** as the conservative MVP classification.
3. Document retention classes: **confirmed for the raw files.** After stage-one deletion only the
   **minimum derived evidence facts** are kept (e.g. ASU proof checked; exception decision,
   reason and approval; references and timestamps), not the raw health-related exception
   evidence as part of the long-lived evidence set.
4. A role a document type doesn't name gets `never`: **confirmed**.
5. PL access to profiling-exception evidence: **confirmed**. Metadata and content stay assisted
   mode / break-glass only; the correction-request permission doesn't widen read access.
6. Documents are immutable or changed through a domain operation: **confirmed**. Correction
   permissions come from an explicit correction-authority table, not from open rights.
7. **Evidence-set reads — corrected.** Evidence-set access is the **intersection of the role's
   active-phase entitlement and break-glass**. An active-phase access that already permits
   break-glass (or assisted mode) doesn't become `never`:
   - the PL opening ASU proof in the evidence-set phase → `needs_break_glass`;
   - the PL opening exception evidence, where active access permits assisted mode or
     break-glass → `needs_break_glass`;
   - a role with no active-phase entitlement → `never`;
   - lists → always `never`.
8. **Audit streams — allocation confirmed, phase corrected.** Once only the evidence set is
   left, participant-level operational audit projections need break-glass. The regional
   operations manager's review queue stays normally accessible: it is needed to review those
   break-glass actions and holds only authorised review metadata.
9. Knowledge-check denial only where access would otherwise be allowed: **confirmed**.
10. Reports and exports as a later dedicated resource kind: **confirmed**.

## Q88 🔒 (assumed) — corrections to evidence-set fields

Evidence-set field data stays correctable, but **never by generic or in-place field editing**.
The evidence-correction operation takes a target:

```ts
type EvidenceCorrectionTarget =
  | { kind: "document"; documentType: DocumentType; documentId: string }
  | { kind: "field"; fieldKey: string };
```

**Request authority**
- PL: identity and case facts, measure participation, operational participation dates and times.
- Back office: payroll/BA identifiers and DSV/TG employment or payroll dates.
- Where both responsibilities apply, either role may request.
- Consultants and participants can't alter the evidence set directly; they may initiate a task or
  rectification request for the responsible role.

**Required behaviour**
- an append-only correction record or version; the original retained and linked through
  corrects/supersedes;
- a mandatory reason code and documented source;
- a BA/legal reference where applicable, but also a data-subject rectification request, a
  corrected source document or a documented internal error;
- approval by the regional operations manager, four eyes;
- corrected sensitive values encrypted;
- audit events with IDs, field key, actor and timestamps, never the old or new sensitive values;
- the approver sees the correction category, basis and references, but no sensitive value they
  are otherwise forbidden to access.

A field correction alone never bypasses lifecycle guards or retroactively changes Transfer-KuG
eligibility, contractual dates or payments. Those consequences need the corresponding
reconciliation, contractual amendment or recorded BA/legal determination.

## Applied in PR 1d-2

See the plan, section 5.6, and the readings taken while applying them.
