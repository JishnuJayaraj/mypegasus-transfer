# Decisions — 2026-10-15, round 5 (PR #1 review, part 2)

## Q54 — TL 407 submission is not a TG entry guard
- §111(4) Nr. 4 requires taking part in profiling before the transfer, not submitting the form.
- Guard: profiling done (TL 407 signed by participant and profiler) **or** profiling exception.
- Submission is tracked with date and channel:
  - not submitted by TG start → warning on the PL dashboard
  - still missing 14 days after TG start → escalation to the PL and the regional admin
  - with the profiling exception, submission follows once profiling is caught up within the
    1-month deadline

## Q55 — The participant's own registration counts
- Legally the registration counts, not the form. §38 SGB III allows online, in person or by
  phone. Kug 200b is the usual channel in transfer projects, not the only valid one.
- The ASU record stores `channel` (`kug_200b`, `online_self`, `in_person`), `registeredOn`, and
  proof: the submitted Kug 200b, a BA confirmation, or the BA-Kundennummer noted by the PL.
- The TG entry guard checks "ASU registered with proof", regardless of channel.
- Self-registered people are still offered Kug 200b for the TG profile-access consent ("what's
  missing" item, not a guard). Without it, the consent record stays empty.

## Q56 — Order of withdrawal reasons
- `declined_dsv` → `declined_profiling` → `no_response`. Declining the DSV is the decision
  against the TG itself; explicit decisions rank above silence.
- Store the primary reason by this precedence, plus all other applicable reasons as a secondary
  list.
- A reason chosen manually by the PL (e.g. `placed_direct`, `retirement`) always overrides the
  derived one.

## Settings file
- Don't rename `.env.example`. Narrow the deny rules to the real secret files: `Read` and Bash
  access for `./.env`, `./.env.local`, `./.env.*.local`, `./.env.production`,
  `./.env.development`, `./.env.test`. No `.env.*` wildcard.
- `.env.example` stays readable and editable. `.gitignore` ignores `.env` and `.env.*` and
  un-ignores `.env.example` (checked).
- `CLAUDE.md` notes that these deny rules are a guardrail, not a security boundary (C17). Real
  secrets live in the cluster's secret store.

## Remaining review items
1. **Row-level security:** not for the demo, required at the pre-pilot gate. Every table holding
   participant data gets `project_id` from the start (ADR-0002, ADR-0005).
2. **Base defaults:** `packages/domain/config/base-defaults.json`, validated by the same JSON
   Schema as regional templates: default channels, deadlines (ASU formula, signing-deadline
   offset, reminder intervals), default completeness rules (ADR-0004).
3. **API (ADR-0010):** OpenAPI via `@hono/zod-openapi`, RFC 9457 problem details, cursor
   pagination, `/api/v1`.
4. **Jobs (ADR-0011):** pg-boss, decided now. Idempotent, `system` actor, injected `Clock`,
   ID-only payloads.
5. **Slice 4 split:** 4a wizard + consent, 4b uploads + documents, 4c QR registration +
   matching.

## Noted while applying
- The Bash deny patterns from round 4 (`cat * .env*` etc.) were so broad that they blocked
  unrelated commands in this session (e.g. a command that read `.gitignore` and mentioned
  `.env` later). The narrowed list uses exact file names, plus `grep * <file>`.
- Escalating to the regional admin conflicted with "regional admins see no case data". Settled
  by Q57 below.

## Q57 — Content of escalations to the regional admin
- The escalation shows: project, responsible PL, number of overdue items per type (e.g.
  "3 × TL 407 not submitted"), and days overdue for the oldest item.
- **No participant names.** If the regional admin needs details, they contact the PL.
